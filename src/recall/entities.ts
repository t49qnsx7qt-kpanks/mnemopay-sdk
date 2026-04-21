/**
 * Entity extraction + tiered canonicalization.
 *
 * Named entities (people, places, orgs, products, dates, quantities) are the
 * skeleton of multi-session reasoning. If "Kura Sushi" is mentioned in
 * session 3 and "that sushi place in Plano" is referenced in session 17,
 * the retriever needs to resolve both to the same canonical node before
 * graph spreading can surface session 3 when session 17 is queried.
 *
 * Canonicalization tiers (cheap → expensive):
 *   1. Exact match on normalized key
 *   2. Alias match (previously resolved variants)
 *   3. Fuzzy match — Levenshtein distance / max-length ratio ≤ 0.2 for
 *      strings of length ≥ 5. Rules out trivial typo merges on short tokens.
 *   4. Embedding similarity (future work — would require per-agent vector
 *      index keyed on entity names; we skip it for now because the lexical
 *      tiers already cover the cases LongMemEval exercises).
 *
 * Extraction is done by a cheap LLM (Groq Llama-3.3-70B by default) with a
 * strict JSON schema so we can parse without retries. Anthropic fallback is
 * provided because Groq quotas are thinner than Anthropic's on this account.
 */

export type EntityType =
  | "person"
  | "place"
  | "org"
  | "product"
  | "event"
  | "date"
  | "quantity"
  | "other";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export interface EntityExtractionOptions {
  provider?: "groq" | "anthropic";
  apiKey?: string;
  model?: string;
  /** Max entities to return per call (default 30). */
  maxEntities?: number;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const EXTRACT_SYSTEM = `Extract named entities from the user-provided text.

Return STRICT JSON with this shape and nothing else:
{"entities": [{"name": "string", "type": "person|place|org|product|event|date|quantity|other"}, ...]}

Rules:
- Extract proper nouns, specific product/brand names, named places, people, organizations, concrete dates, and quantities with units.
- Skip generic nouns ("the restaurant", "my car", "the book") unless they carry a proper-noun qualifier.
- Deduplicate by surface form.
- Max 30 entities.
- If nothing qualifies, return {"entities": []}.`;

// ─── LLM callers ────────────────────────────────────────────────────────────

async function callGroqJSON(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 900,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${err}`);
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content ?? "";
}

async function callAnthropicJSON(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  const j = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (j.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

function parseEntitiesJSON(raw: string, cap: number): ExtractedEntity[] {
  // Tolerate models that wrap JSON in prose despite instructions.
  let body = raw.trim();
  const firstBrace = body.indexOf("{");
  const lastBrace = body.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    body = body.slice(firstBrace, lastBrace + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const entities = (parsed as { entities?: unknown })?.entities;
  if (!Array.isArray(entities)) return [];
  const out: ExtractedEntity[] = [];
  for (const raw of entities) {
    if (!raw || typeof raw !== "object") continue;
    const name = String((raw as { name?: unknown }).name ?? "").trim();
    if (!name) continue;
    const type = String((raw as { type?: unknown }).type ?? "other") as EntityType;
    out.push({
      name,
      type: isEntityType(type) ? type : "other",
    });
    if (out.length >= cap) break;
  }
  return out;
}

function isEntityType(t: string): t is EntityType {
  return (
    t === "person" ||
    t === "place" ||
    t === "org" ||
    t === "product" ||
    t === "event" ||
    t === "date" ||
    t === "quantity" ||
    t === "other"
  );
}

/**
 * Extract named entities from a chunk of text. Returns [] on API failure —
 * entity extraction is best-effort; the retriever must still work without it.
 */
export async function extractEntities(
  text: string,
  opts: EntityExtractionOptions = {},
): Promise<ExtractedEntity[]> {
  const provider = opts.provider ?? "groq";
  const apiKey =
    opts.apiKey ??
    (provider === "groq" ? process.env.GROQ_API_KEY : process.env.ANTHROPIC_API_KEY) ??
    "";
  if (!apiKey) return [];
  const cap = opts.maxEntities ?? 30;
  const user = text.length > 8000 ? text.slice(0, 8000) : text;

  try {
    const raw =
      provider === "groq"
        ? await callGroqJSON(
            apiKey,
            opts.model ?? "llama-3.3-70b-versatile",
            EXTRACT_SYSTEM,
            user,
          )
        : await callAnthropicJSON(
            apiKey,
            opts.model ?? "claude-haiku-4-5-20251001",
            EXTRACT_SYSTEM,
            user,
          );
    return parseEntitiesJSON(raw, cap);
  } catch {
    return [];
  }
}

// ─── Canonicalization ────────────────────────────────────────────────────────

export function normalizeEntityKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance — rolling-array implementation, O(min(a,b)) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = temp;
    }
  }
  return dp[n];
}

export interface CanonicalEntry {
  canonicalName: string;
  aliases: string[];
}

export interface CanonicalizeResult {
  canonicalName: string;
  matched: boolean;
  /** Which tier matched: "exact" | "alias" | "fuzzy" | null (if new). */
  tier: "exact" | "alias" | "fuzzy" | null;
}

/**
 * Resolve an entity name to its canonical form among a set of known entities.
 * Returns the input name unchanged (matched=false) if no tier resolves.
 */
export function canonicalize(
  name: string,
  existing: readonly CanonicalEntry[],
): CanonicalizeResult {
  const normalized = normalizeEntityKey(name);
  if (!normalized) return { canonicalName: name, matched: false, tier: null };

  // Tier 1: exact match on canonical
  for (const e of existing) {
    if (normalizeEntityKey(e.canonicalName) === normalized) {
      return { canonicalName: e.canonicalName, matched: true, tier: "exact" };
    }
  }

  // Tier 2: alias match
  for (const e of existing) {
    for (const alias of e.aliases) {
      if (normalizeEntityKey(alias) === normalized) {
        return { canonicalName: e.canonicalName, matched: true, tier: "alias" };
      }
    }
  }

  // Tier 3: fuzzy match — only on tokens of length ≥ 5 to avoid merging
  // things like "car" and "cat".
  if (normalized.length >= 5) {
    for (const e of existing) {
      const candidates = [e.canonicalName, ...e.aliases];
      for (const c of candidates) {
        const cn = normalizeEntityKey(c);
        if (cn.length < 5) continue;
        if (Math.abs(cn.length - normalized.length) > 2) continue;
        const dist = levenshtein(cn, normalized);
        const maxLen = Math.max(cn.length, normalized.length);
        if (dist / maxLen <= 0.2) {
          return { canonicalName: e.canonicalName, matched: true, tier: "fuzzy" };
        }
      }
    }
  }

  return { canonicalName: name, matched: false, tier: null };
}
