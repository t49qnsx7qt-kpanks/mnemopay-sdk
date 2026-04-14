/**
 * LLM Reasoning Post-Processor for MnemoPay Recall.
 *
 * After recall returns candidate memories, this layer uses an LLM to:
 *   1. Extract and synthesize temporal facts (date math, duration calculations)
 *   2. Identify which memories are most relevant to the query
 *   3. Produce a distilled reasoning trace that downstream consumers can use
 *
 * This solves the "100% session hit, 62% answer hit" gap in LongMemEval
 * where retrieval is perfect but temporal reasoning questions fail because
 * the answer requires date arithmetic that pure text matching can't do.
 */

import type { RecallResult } from "../recall/engine.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReasoningConfig {
  /** LLM provider: "anthropic" or "openai" (default: "anthropic") */
  provider?: "anthropic" | "openai";
  /** API key for the LLM provider */
  apiKey: string;
  /** Model to use (default: "claude-sonnet-4-20250514" for anthropic, "gpt-4o-mini" for openai) */
  model?: string;
  /** Max tokens for reasoning output (default: 1024) */
  maxTokens?: number;
  /** Whether to include chain-of-thought in output (default: false — only distilled facts) */
  includeChainOfThought?: boolean;
}

export interface ReasoningResult {
  /** Distilled facts extracted from memories, relevant to the query */
  facts: string[];
  /** Optional chain-of-thought reasoning trace */
  reasoning?: string;
  /** Re-ranked memory IDs (most relevant first) */
  rankedIds: string[];
  /** Time taken in ms */
  durationMs: number;
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const REASONING_SYSTEM_PROMPT = `You are an analytical reasoning engine. Given a set of retrieved memories and a query, your job is to:

1. EXTRACT all facts from the memories that are relevant to answering the query.
2. COMPUTE any derived facts — especially temporal calculations:
   - Convert relative dates to absolute dates when session dates are provided.
   - Calculate durations, intervals, counts of days/weeks/months between events.
   - Identify "before", "after", "during" relationships between events.
3. RANK which memories are most relevant (by their [Memory N] number).
4. OUTPUT a structured response in this exact format:

REASONING:
<Your step-by-step reasoning, especially any date math or temporal logic>

FACTS:
- <fact 1>
- <fact 2>
- <fact N>

RANKED: <comma-separated memory numbers, most relevant first, e.g. 3,1,5,2,4>

Rules:
- Every FACT must be grounded in the provided memories — never invent information.
- For temporal questions, SHOW YOUR MATH (e.g., "Session on 2024-03-15 mentions event X. 30 days before = 2024-02-14.").
- If a question asks "how many days/weeks/months", compute the exact number.
- Keep facts concise — one sentence each.
- The RANKED list must include ALL memory numbers.`;

// ─── Anthropic Client (minimal, avoids hard dep) ───────────────────────────

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  messages: AnthropicMessage[],
  maxTokens: number
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
      messages,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  return data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

// ─── OpenAI Client (minimal) ───────────────────────────────────────────────

async function callOpenAI(
  apiKey: string,
  model: string,
  system: string,
  messages: AnthropicMessage[],
  maxTokens: number
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        ...messages,
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

// ─── Parser ─────────────────────────────────────────────────────────────────

function parseReasoningOutput(raw: string): {
  reasoning: string;
  facts: string[];
  ranked: number[];
} {
  const reasoningMatch = raw.match(/REASONING:\s*([\s\S]*?)(?=\nFACTS:)/i);
  const factsMatch = raw.match(/FACTS:\s*([\s\S]*?)(?=\nRANKED:)/i);
  const rankedMatch = raw.match(/RANKED:\s*([\s\S]*?)$/im);

  const reasoning = reasoningMatch?.[1]?.trim() ?? "";

  const facts = (factsMatch?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter((l) => l.length > 0);

  const ranked = (rankedMatch?.[1] ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  return { reasoning, facts, ranked };
}

// ─── Post-Processor ─────────────────────────────────────────────────────────

export class ReasoningPostProcessor {
  private readonly config: Required<ReasoningConfig>;

  constructor(config: ReasoningConfig) {
    this.config = {
      provider: config.provider ?? "anthropic",
      apiKey: config.apiKey,
      model:
        config.model ??
        (config.provider === "openai"
          ? "gpt-4o-mini"
          : "claude-sonnet-4-20250514"),
      maxTokens: config.maxTokens ?? 1024,
      includeChainOfThought: config.includeChainOfThought ?? false,
    };
  }

  /**
   * Reason over recalled memories to extract facts and re-rank by relevance.
   */
  async reason(
    query: string,
    memories: RecallResult[]
  ): Promise<ReasoningResult> {
    if (memories.length === 0) {
      return { facts: [], rankedIds: [], durationMs: 0 };
    }

    const t0 = Date.now();

    // Build context block
    const contextBlock = memories
      .map(
        (m, i) =>
          `[Memory ${i + 1}] (id: ${m.id}, created: ${m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt})\n${m.content}`
      )
      .join("\n\n");

    const userPrompt = `Query: ${query}\n\nRetrieved memories:\n\n${contextBlock}`;

    // Call LLM
    const callFn =
      this.config.provider === "openai" ? callOpenAI : callAnthropic;
    const rawOutput = await callFn(
      this.config.apiKey,
      this.config.model,
      REASONING_SYSTEM_PROMPT,
      [{ role: "user", content: userPrompt }],
      this.config.maxTokens
    );

    // Parse structured output
    const parsed = parseReasoningOutput(rawOutput);

    // Map memory numbers back to IDs
    const rankedIds = parsed.ranked
      .filter((n) => n >= 1 && n <= memories.length)
      .map((n) => memories[n - 1].id);

    // Include any memories not mentioned in ranking (append at end)
    const rankedSet = new Set(rankedIds);
    for (const m of memories) {
      if (!rankedSet.has(m.id)) rankedIds.push(m.id);
    }

    const durationMs = Date.now() - t0;

    return {
      facts: parsed.facts,
      reasoning: this.config.includeChainOfThought
        ? parsed.reasoning
        : undefined,
      rankedIds,
      durationMs,
    };
  }

  /**
   * Reason and produce a distilled context string suitable for answer generation.
   * This replaces raw memory concatenation with a reasoned summary.
   */
  async distill(
    query: string,
    memories: RecallResult[]
  ): Promise<{ distilledContext: string; result: ReasoningResult }> {
    const result = await this.reason(query, memories);

    const lines: string[] = [];
    if (result.reasoning) {
      lines.push(`Reasoning:\n${result.reasoning}\n`);
    }
    if (result.facts.length > 0) {
      lines.push(`Extracted facts:`);
      for (const fact of result.facts) {
        lines.push(`- ${fact}`);
      }
    }

    // Also include re-ranked raw memories for the answer generator
    const reranked = result.rankedIds
      .map((id) => memories.find((m) => m.id === id))
      .filter(Boolean);

    if (reranked.length > 0) {
      lines.push(`\nSource memories (ranked by relevance):`);
      for (const m of reranked) {
        lines.push(`---\n${m!.content}`);
      }
    }

    return {
      distilledContext: lines.join("\n"),
      result,
    };
  }
}
