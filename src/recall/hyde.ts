/**
 * HyDE — Hypothetical Document Embeddings for query expansion.
 *
 * Classic retrieval fails when the question and the relevant memory share no
 * lexical overlap. HyDE asks a cheap LLM to generate what an answer to the
 * question might look like, then uses those hypothetical answers as extra
 * retrieval queries. The embedding of a hypothetical answer is closer to the
 * real answer's embedding than the question's embedding is.
 *
 * Reference: Gao et al., "Precise Zero-Shot Dense Retrieval without
 * Relevance Labels" (2022).
 */

export interface HyDEConfig {
  provider?: "anthropic" | "openai" | "groq";
  apiKey: string;
  model?: string;
  /** Number of hypothetical answers to generate (default: 3). */
  numHypotheses?: number;
  /** Max tokens per hypothesis (default: 128). */
  maxTokens?: number;
  /** Temperature — higher = more lexical variation across hypotheses. */
  temperature?: number;
}

export interface HyDEResult {
  /** Generated hypothetical answers, ready to be used as retrieval queries. */
  hypotheses: string[];
  durationMs: number;
}

const HYDE_SYSTEM_PROMPT = `You write short, plausible answers to questions about a user's past conversations with an assistant.

Rules:
- Produce EXACTLY the number of distinct answers requested, numbered 1., 2., 3.
- Each answer should read like a real factual statement the user might have made in a past session (e.g., "My favorite restaurant is Kura Sushi in Plano.").
- Use concrete nouns, names, places, dates — specificity is what makes the embedding useful.
- Keep each answer to 1-2 sentences.
- Vary vocabulary across the answers so the retrieval net is wider.
- If you don't know, invent a plausible answer anyway. This is for retrieval expansion, not fact generation.
- Never refuse, never hedge, never say "I don't have access to..."`;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      temperature,
      messages: messages.filter((m) => m.role !== "system"),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HyDE ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("");
}

async function callOpenAICompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`HyDE ${baseUrl} ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

function parseHypotheses(raw: string, expected: number): string[] {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.)]\s*|[-*]\s*)(.+)$/);
    if (m && m[1]) out.push(m[1].trim());
    else if (out.length === 0 && line.length > 10) out.push(line);
  }
  // Fallback: if parser produced nothing, treat the whole response as one hypothesis.
  if (out.length === 0 && raw.trim().length > 0) out.push(raw.trim().slice(0, 300));
  return out.slice(0, expected);
}

/**
 * HyDE is net-harmful for questions whose answer is a *specific closed fact*
 * the LLM would have to invent (a date, a count, a duration between two
 * events). The fabricated value enters the retrieval query and pulls in chunks
 * that mention that value in unrelated contexts — verifier-biased noise that
 * swamps the real evidence. Bench data (LongMemEval oracle, 2026-04-20):
 * temporal-reasoning dropped 6.0pt and knowledge-update dropped 7.7pt when
 * HyDE ran blindly on every question.
 *
 * Heuristic: skip HyDE when the question asks for a count of time units,
 * a duration between events, or uses explicit update/recency language. For
 * open-ended or preference questions HyDE still helps, so the default is ON
 * and we only gate off the known failure modes.
 */
const HYDE_SKIP_PATTERNS: RegExp[] = [
  /\bhow\s+(?:many|long)\b.*\b(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes)\b/i,
  /\bhow\s+much\s+time\b/i,
  /\b(?:days?|weeks?|months?|years?|hours?)\s+(?:between|before|after|since|apart|ago)\b/i,
  /\btime\s+(?:between|difference|passed|elapsed)\b/i,
  /\b(?:currently|right\s+now|most\s+recent(?:ly)?|latest|newest|last\s+time|still)\b/i,
  /\b(?:updated?|changed|switched|replaced|upgraded)\s+(?:to|from)?\b/i,
];

export function shouldUseHyDE(query: string): boolean {
  for (const re of HYDE_SKIP_PATTERNS) {
    if (re.test(query)) return false;
  }
  return true;
}

export class HyDEGenerator {
  private readonly config: Required<HyDEConfig>;

  constructor(config: HyDEConfig) {
    this.config = {
      provider: config.provider ?? "anthropic",
      apiKey: config.apiKey,
      model:
        config.model ??
        (config.provider === "openai"
          ? "gpt-4o-mini"
          : config.provider === "groq"
            ? "llama-3.3-70b-versatile"
            : "claude-haiku-4-5-20251001"),
      numHypotheses: config.numHypotheses ?? 3,
      maxTokens: config.maxTokens ?? 128,
      temperature: config.temperature ?? 0.7,
    };
  }

  async generate(query: string): Promise<HyDEResult> {
    const t0 = Date.now();
    const userPrompt = `Generate ${this.config.numHypotheses} distinct plausible answers to this question. Number each one (1., 2., 3.).\n\nQuestion: ${query}`;

    let raw = "";
    try {
      if (this.config.provider === "anthropic") {
        raw = await callAnthropic(
          this.config.apiKey,
          this.config.model,
          HYDE_SYSTEM_PROMPT,
          [{ role: "user", content: userPrompt }],
          this.config.maxTokens * this.config.numHypotheses,
          this.config.temperature,
        );
      } else if (this.config.provider === "groq") {
        raw = await callOpenAICompatible(
          this.config.apiKey,
          "https://api.groq.com/openai/v1",
          this.config.model,
          HYDE_SYSTEM_PROMPT,
          [{ role: "user", content: userPrompt }],
          this.config.maxTokens * this.config.numHypotheses,
          this.config.temperature,
        );
      } else {
        raw = await callOpenAICompatible(
          this.config.apiKey,
          "https://api.openai.com/v1",
          this.config.model,
          HYDE_SYSTEM_PROMPT,
          [{ role: "user", content: userPrompt }],
          this.config.maxTokens * this.config.numHypotheses,
          this.config.temperature,
        );
      }
    } catch (e: any) {
      // Graceful degradation: if HyDE fails, return original query as the only "hypothesis"
      // so downstream retrieval still runs.
      return { hypotheses: [query], durationMs: Date.now() - t0 };
    }

    const hypotheses = parseHypotheses(raw, this.config.numHypotheses);
    return {
      hypotheses: hypotheses.length > 0 ? hypotheses : [query],
      durationMs: Date.now() - t0,
    };
  }
}
