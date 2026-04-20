#!/usr/bin/env tsx
/**
 * evaluate.ts — Run LongMemEval queries against MnemoPay's recall system,
 * generate answers with Claude, and output JSONL for evaluation.
 *
 * Flow per question:
 *   1. Create/restore the MnemoPay agent (same ID used during ingestion)
 *   2. Re-ingest memories if needed (MnemoPayLite is in-memory, so we
 *      re-run ingestion inline — fast since it's local)
 *   3. Use agent.recall(query, limit) to retrieve relevant memories
 *   4. Build a prompt with the retrieved context + question
 *   5. Call Claude to generate the answer
 *   6. Write {question_id, hypothesis} to JSONL
 *
 * Usage:
 *   npx tsx evaluate.ts --data data/longmemeval_oracle.json --out results/hypothesis.jsonl
 *   npx tsx evaluate.ts --data data/longmemeval_oracle.json --recall-limit 30 --model claude-sonnet-4-20250514
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MnemoPay, ReasoningPostProcessor, HyDEGenerator, CrossEncoderReranker } from "@mnemopay/sdk";
import Anthropic from "@anthropic-ai/sdk";
import type { LongMemEvalInstance, Hypothesis, Turn } from "./types.js";

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  return {
    dataFile: get("--data", "data/longmemeval_oracle.json"),
    outputFile: get("--out", "results/hypothesis.jsonl"),
    recallLimit: parseInt(get("--recall-limit", "20"), 10),
    maxQuestions: parseInt(get("--max", "0"), 10),
    resumeFrom: parseInt(get("--resume", "0"), 10),
    model: get("--model", "claude-sonnet-4-20250514"),
    concurrency: parseInt(get("--concurrency", "1"), 10),
    recallStrategy: get("--recall-strategy", "score") as "score" | "vector" | "hybrid",
    reasoning: args.includes("--reasoning"),
    reasoningModel: get("--reasoning-model", ""),
    embeddings: get("--embeddings", "bge") as "local" | "bge" | "openai",
    hyde: args.includes("--hyde"),
    hydeProvider: get("--hyde-provider", "anthropic") as "anthropic" | "openai" | "groq",
    hydeModel: get("--hyde-model", ""),
    hydeN: parseInt(get("--hyde-n", "3"), 10),
    rerank: args.includes("--rerank"),
    rerankModel: get("--rerank-model", "Xenova/bge-reranker-base"),
    rerankPool: parseInt(get("--rerank-pool", "50"), 10),
  };
}

// ─── Session Formatting (matches ingest.ts) ──────────────────────────────────

function formatSession(turns: Turn[], sessionId: string, date: string): string {
  const lines = [`[Session ${sessionId} — ${date}]`];
  for (const turn of turns) {
    const speaker = turn.role === "human" ? "User" : "Assistant";
    lines.push(`${speaker}: ${turn.content}`);
  }
  return lines.join("\n");
}

function chunkContent(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─── Ingest Instance (inline, since MnemoPayLite is in-memory) ──────────────

type RecalledMemory = {
  id: string;
  content: string;
  importance: number;
  score: number;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
};

async function ingestAndRecall(
  instance: LongMemEvalInstance,
  query: string,
  recallLimit: number,
  recallStrategy: "score" | "vector" | "hybrid",
  embeddings: "local" | "bge" | "openai",
  hydeQueries: string[] | null,
  reranker: CrossEncoderReranker | null,
  rerankPool: number,
): Promise<RecalledMemory[]> {
  const agentId = `lme-${instance.question_id}`;
  const agent = MnemoPay.quick(agentId, { recall: recallStrategy, embeddings });

  for (let i = 0; i < instance.haystack_sessions.length; i++) {
    const session = instance.haystack_sessions[i];
    const sessionId = instance.haystack_session_ids[i] ?? `session-${i}`;
    const date = instance.haystack_dates[i] ?? "unknown";
    const content = formatSession(session, sessionId, date);
    const chunks = chunkContent(content, 2000);
    for (const chunk of chunks) {
      await agent.remember(chunk, { tags: [`session:${sessionId}`, `date:${date}`] });
    }
  }

  // Run the original query plus any HyDE-expanded queries, union-dedupe by id,
  // preserving the best score seen across all retrievals.
  const queries = hydeQueries && hydeQueries.length > 0 ? [query, ...hydeQueries] : [query];
  const perQueryLimit = reranker ? Math.max(recallLimit, rerankPool) : recallLimit;

  const seen = new Map<string, RecalledMemory>();
  for (const q of queries) {
    const hits = (await agent.recall(q, perQueryLimit)) as RecalledMemory[];
    for (const h of hits) {
      const prev = seen.get(h.id);
      if (!prev || h.score > prev.score) seen.set(h.id, h);
    }
  }
  let merged = Array.from(seen.values()).sort((a, b) => b.score - a.score);

  if (reranker && merged.length > 1) {
    const pool = merged.slice(0, Math.max(rerankPool, recallLimit));
    const reranked = await reranker.rerank(
      query,
      pool.map((m) => ({ id: m.id, content: m.content, priorScore: m.score })),
      recallLimit,
    );
    const byId = new Map(pool.map((m) => [m.id, m]));
    merged = reranked.map((r) => byId.get(r.item.id)!).filter(Boolean);
  } else {
    merged = merged.slice(0, recallLimit);
  }

  return merged;
}

// ─── Answer Generation ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful assistant with access to a user's conversation history. Your task is to answer questions about past conversations accurately and concisely.

Guidelines:
- Answer based ONLY on the provided conversation history context.
- If the context contains the answer, provide it directly and concisely.
- For temporal reasoning questions (e.g., "how many days between X and Y"), use the session dates provided in the context.
- For knowledge update questions, provide the MOST RECENT information from the context.
- For preference questions, reference the user's stated preferences from the context.
- If the question cannot be answered from the provided context, say so clearly — do NOT make up information.
- Keep answers concise. Do not explain your reasoning unless asked.`;

async function generateAnswer(
  client: Anthropic,
  model: string,
  question: string,
  questionDate: string,
  context: string[]
): Promise<string> {
  const contextBlock = context.length > 0
    ? context.map((c, i) => `--- Retrieved Memory ${i + 1} ---\n${c}`).join("\n\n")
    : "(No relevant memories found)";

  const userPrompt = `Current date: ${questionDate}

Here are relevant excerpts from the user's conversation history:

${contextBlock}

Based on the above conversation history, please answer the following question:

${question}`;

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Extract text from response
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return text.trim();
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`\n=== MnemoPay LongMemEval Evaluation ===`);
  console.log(`Data file:       ${opts.dataFile}`);
  console.log(`Output file:     ${opts.outputFile}`);
  console.log(`Recall limit:    ${opts.recallLimit}`);
  console.log(`Recall strategy: ${opts.recallStrategy}`);
  console.log(`Embeddings:      ${opts.embeddings}`);
  console.log(`HyDE:            ${opts.hyde ? `ON (${opts.hydeProvider}, n=${opts.hydeN})` : "OFF"}`);
  console.log(`Rerank:          ${opts.rerank ? `ON (${opts.rerankModel}, pool=${opts.rerankPool})` : "OFF"}`);
  console.log(`Model:           ${opts.model}`);
  console.log(`Reasoning:       ${opts.reasoning ? "ON" : "OFF"}`);
  if (opts.reasoning && opts.reasoningModel) {
    console.log(`Reasoning model: ${opts.reasoningModel}`);
  }
  console.log(`Concurrency:     ${opts.concurrency}`);

  // Validate API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("\nERROR: ANTHROPIC_API_KEY environment variable is required.");
    process.exit(1);
  }

  // Load dataset
  if (!existsSync(opts.dataFile)) {
    console.error(`\nERROR: Data file not found: ${opts.dataFile}`);
    console.error(`Run: npm run download`);
    process.exit(1);
  }

  const raw = readFileSync(opts.dataFile, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);
  let instances = opts.maxQuestions > 0 ? dataset.slice(0, opts.maxQuestions) : dataset;

  // Resume support: skip already-processed questions
  let existingIds = new Set<string>();
  if (opts.resumeFrom > 0) {
    instances = instances.slice(opts.resumeFrom);
    console.log(`\nResuming from index ${opts.resumeFrom}`);
  } else if (existsSync(opts.outputFile)) {
    // Check for existing results to enable resume
    const existing = readFileSync(opts.outputFile, "utf-8").trim();
    if (existing) {
      for (const line of existing.split("\n")) {
        try {
          const h: Hypothesis = JSON.parse(line);
          existingIds.add(h.question_id);
        } catch {
          // skip malformed lines
        }
      }
      if (existingIds.size > 0) {
        console.log(`\nFound ${existingIds.size} existing results — resuming.`);
        instances = instances.filter((inst) => !existingIds.has(inst.question_id));
      }
    }
  }

  console.log(`\nProcessing ${instances.length} questions.\n`);

  if (instances.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Ensure output directory exists
  mkdirSync(dirname(opts.outputFile), { recursive: true });

  // If starting fresh (no resume), truncate the file
  if (existingIds.size === 0 && opts.resumeFrom === 0) {
    writeFileSync(opts.outputFile, "");
  }

  const client = new Anthropic({ apiKey });
  const reasoner = opts.reasoning
    ? new ReasoningPostProcessor({
        provider: "anthropic",
        apiKey,
        model: opts.reasoningModel || "claude-sonnet-4-20250514",
        includeChainOfThought: true,
      })
    : null;

  // HyDE generator — defaults to Anthropic Haiku, overridable to Groq (free) or OpenAI
  let hydeGen: HyDEGenerator | null = null;
  if (opts.hyde) {
    const hydeKey =
      opts.hydeProvider === "groq"
        ? process.env.GROQ_API_KEY ?? ""
        : opts.hydeProvider === "openai"
          ? process.env.OPENAI_API_KEY ?? ""
          : apiKey;
    if (!hydeKey) {
      console.error(`\nERROR: --hyde enabled but no API key found for provider ${opts.hydeProvider}`);
      process.exit(1);
    }
    hydeGen = new HyDEGenerator({
      provider: opts.hydeProvider,
      apiKey: hydeKey,
      model: opts.hydeModel || undefined,
      numHypotheses: opts.hydeN,
    });
  }

  const reranker = opts.rerank
    ? new CrossEncoderReranker({ model: opts.rerankModel })
    : null;

  const limiter = new RateLimiter(opts.concurrency);

  const t0 = Date.now();
  let completed = 0;
  let errors = 0;

  // Retry helper with exponential backoff for rate limits
  async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const is429 = err.message?.includes("429") || err.status === 429;
        if (is429 && attempt < maxRetries) {
          const delay = Math.min(30000, 5000 * Math.pow(2, attempt)); // 5s, 10s, 20s, 30s, 30s
          console.error(`\n[${label}] Rate limited, retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  // Inter-question delay to respect rate limits (15s when reasoning, 5s otherwise)
  const interQuestionDelay = opts.reasoning ? 15000 : 5000;

  // Process all questions sequentially to respect rate limits
  const promises = instances.map(async (instance, idx) => {
    await limiter.acquire();

    try {
      // Step 0: Optional HyDE expansion — generate hypothetical answers to use as extra queries
      let hydeQueries: string[] | null = null;
      if (hydeGen) {
        const { hypotheses } = await withRetry(
          () => hydeGen!.generate(instance.question),
          instance.question_id + "/hyde",
        );
        hydeQueries = hypotheses;
      }

      // Step 1: Ingest sessions and recall relevant memories (with optional HyDE + rerank)
      const memories = await ingestAndRecall(
        instance,
        instance.question,
        opts.recallLimit,
        opts.recallStrategy,
        opts.embeddings,
        hydeQueries,
        reranker,
        opts.rerankPool,
      );

      // Step 2: Build context — with optional reasoning layer
      let context: string[];
      if (reasoner && memories.length > 0) {
        // Convert memories to RecallResult shape for the reasoner
        const recallResults = memories.map((m) => ({
          id: m.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
          content: m.content,
          importance: m.importance,
          score: m.score,
          vectorScore: undefined,
          combinedScore: m.score,
          createdAt: m.createdAt,
          lastAccessed: m.lastAccessed,
          accessCount: m.accessCount,
          tags: m.tags,
        }));

        const { distilledContext } = await withRetry(
          () => reasoner.distill(instance.question, recallResults).then((r) => r.distilledContext),
          instance.question_id + "/reason"
        );
        context = [distilledContext];
      } else {
        context = memories.map((m) => m.content);
      }

      // Step 3: Generate answer with Claude (with retry)
      const hypothesis = await withRetry(
        () => generateAnswer(client, opts.model, instance.question, instance.question_date, context),
        instance.question_id + "/answer"
      );

      // Step 4: Write result
      const result: Hypothesis = {
        question_id: instance.question_id,
        hypothesis,
      };
      appendFileSync(opts.outputFile, JSON.stringify(result) + "\n");

      completed++;
      const pct = (((completed + errors) / instances.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(
        `\r[${pct}%] ${completed}/${instances.length} done, ${errors} errors — ${elapsed}s elapsed`
      );

      // Delay between questions to stay under rate limits
      if (idx < instances.length - 1) {
        await new Promise((r) => setTimeout(r, interQuestionDelay));
      }
    } catch (err: any) {
      errors++;
      console.error(`\nError on ${instance.question_id}: ${err.message}`);

      // Write a fallback hypothesis so evaluation doesn't skip this question
      const fallback: Hypothesis = {
        question_id: instance.question_id,
        hypothesis: "I don't have enough information to answer this question.",
      };
      appendFileSync(opts.outputFile, JSON.stringify(fallback) + "\n");
    } finally {
      limiter.release();
    }
  });

  await Promise.all(promises);

  const totalMs = Date.now() - t0;

  console.log(`\n\nEvaluation complete:`);
  console.log(`  Questions:  ${completed} answered, ${errors} errors`);
  console.log(`  Time:       ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Output:     ${opts.outputFile}`);
  console.log(`\nNext step: Run LongMemEval's official evaluation:`);
  console.log(`  python3 src/evaluation/evaluate_qa.py gpt-4o ${opts.outputFile} ${opts.dataFile}`);
}

main().catch((err) => {
  console.error("\nFatal error during evaluation:", err);
  process.exit(1);
});
