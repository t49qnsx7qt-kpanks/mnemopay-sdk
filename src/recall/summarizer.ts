/**
 * Session Summarizer — dated factual digests of conversation sessions.
 *
 * The biggest retrieval failure on long-conversation benchmarks is multi-session
 * reasoning: the evidence is spread across many sessions and raw-turn chunking
 * either misses one of the evidences or buries it under irrelevant context.
 * Summaries collapse each session to ~200 tokens of facts with the session
 * date prefixed, which makes them cheap to retrieve and easy for the answerer
 * to cross-reference across sessions.
 *
 * Pattern adapted from Mem0's ADD algorithm (arxiv 2504.19413) and Mastra's
 * Observational Memory layer (arxiv 2502.12110). Stored alongside raw-turn
 * memories — not replacing them — so preference/single-session categories
 * still see verbatim evidence.
 */

export interface SessionTurn {
  role: "user" | "assistant" | "human";
  content: string;
}

export interface SummarizerOptions {
  provider?: "groq" | "anthropic";
  apiKey?: string;
  model?: string;
  /** Max completion tokens for the summary (default: 280 — ~200 tokens of output + slack). */
  maxTokens?: number;
  /** Session date (ISO date or LongMemEval format) — prefixed into the digest. */
  date?: string;
  /** Temperature — 0 for determinism (default: 0). */
  temperature?: number;
}

export interface SummarizedSession {
  sessionId: string;
  date: string;
  summary: string;
  turnCount: number;
  durationMs: number;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SUMMARIZER_SYSTEM = `You condense one conversation session into a dense factual digest for agent memory.

Rules:
- Preserve every user-stated fact, preference, commitment, date, name, quantity, identifier, and decision.
- Strip pleasantries, filler, meta-commentary, and assistant hedging.
- Keep relative temporal markers intact ("last week", "next Tuesday", "two months ago").
- One fact per short sentence. No bullets, no headers, no preamble, no "summary:" prefix.
- Under 200 tokens. Hard cap.
- If the session contains updates to prior state (user changed their mind, replaced an item, corrected a fact), mark both the old and new value with "was X, now Y".`;

function formatTranscript(turns: SessionTurn[]): string {
  return turns
    .map((t) => {
      const speaker = t.role === "assistant" ? "Assistant" : "User";
      return `${speaker}: ${t.content}`;
    })
    .join("\n");
}

async function callGroq(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
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
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${err}`);
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
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
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  const j = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return ((j.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")).trim();
}

/**
 * Summarize a single conversation session into a dated factual digest.
 * Returns the summary text (no prefix). Callers typically wrap it with
 * `formatSummaryMemory()` before storing.
 */
export async function summarizeSession(
  turns: SessionTurn[],
  opts: SummarizerOptions = {},
): Promise<string> {
  const provider = opts.provider ?? "groq";
  const apiKey =
    opts.apiKey ??
    (provider === "groq" ? process.env.GROQ_API_KEY : process.env.ANTHROPIC_API_KEY) ??
    "";
  if (!apiKey) throw new Error(`summarizer: no API key for provider "${provider}"`);

  const transcript = formatTranscript(turns);
  const dated = opts.date
    ? `Session date: ${opts.date}\n\n${transcript}`
    : transcript;
  const maxTokens = opts.maxTokens ?? 280;
  const temperature = opts.temperature ?? 0;

  if (provider === "groq") {
    return callGroq(
      apiKey,
      opts.model ?? "llama-3.3-70b-versatile",
      SUMMARIZER_SYSTEM,
      dated,
      maxTokens,
      temperature,
    );
  }
  if (provider === "anthropic") {
    return callAnthropic(
      apiKey,
      opts.model ?? "claude-haiku-4-5-20251001",
      SUMMARIZER_SYSTEM,
      dated,
      maxTokens,
      temperature,
    );
  }
  throw new Error(`summarizer: unknown provider "${provider}"`);
}

/**
 * Format a summary for storage as a memory. The `[Session Summary ...]`
 * prefix matches the `[Session ...]` prefix used for raw-turn memories so
 * the answerer LLM can tell them apart at read time.
 */
export function formatSummaryMemory(params: {
  sessionId: string;
  date: string;
  summary: string;
}): string {
  return `[Session Summary ${params.sessionId} — ${params.date}]\n${params.summary}`;
}

/**
 * Full helper: summarize + return a `SummarizedSession` record with timing,
 * so callers can log summarizer overhead per session.
 */
export async function summarizeAndTime(params: {
  sessionId: string;
  date: string;
  turns: SessionTurn[];
  options?: SummarizerOptions;
}): Promise<SummarizedSession> {
  const t0 = Date.now();
  const summary = await summarizeSession(params.turns, {
    ...params.options,
    date: params.date,
  });
  return {
    sessionId: params.sessionId,
    date: params.date,
    summary,
    turnCount: params.turns.length,
    durationMs: Date.now() - t0,
  };
}
