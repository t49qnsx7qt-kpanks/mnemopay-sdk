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
import { MnemoPay } from "@mnemopay/sdk";
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

async function ingestAndRecall(
  instance: LongMemEvalInstance,
  query: string,
  recallLimit: number,
  recallStrategy: "score" | "vector" | "hybrid"
): Promise<string[]> {
  const agentId = `lme-${instance.question_id}`;
  const agent = MnemoPay.quick(agentId, { recall: recallStrategy });

  // Ingest all sessions
  for (let i = 0; i < instance.haystack_sessions.length; i++) {
    const session = instance.haystack_sessions[i];
    const sessionId = instance.haystack_session_ids[i] ?? `session-${i}`;
    const date = instance.haystack_dates[i] ?? "unknown";
    const content = formatSession(session, sessionId, date);
    const chunks = chunkContent(content, 8000);

    for (const chunk of chunks) {
      await agent.remember(chunk, {
        tags: [`session:${sessionId}`, `date:${date}`],
      });
    }
  }

  // Recall relevant memories
  const memories = await agent.recall(query, recallLimit);
  return memories.map((m) => m.content);
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
  console.log(`Model:           ${opts.model}`);
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
  const limiter = new RateLimiter(opts.concurrency);

  const t0 = Date.now();
  let completed = 0;
  let errors = 0;

  // Process all questions
  const promises = instances.map(async (instance, idx) => {
    await limiter.acquire();

    try {
      // Step 1: Ingest sessions and recall relevant context
      const context = await ingestAndRecall(
        instance,
        instance.question,
        opts.recallLimit,
        opts.recallStrategy
      );

      // Step 2: Generate answer with Claude
      const hypothesis = await generateAnswer(
        client,
        opts.model,
        instance.question,
        instance.question_date,
        context
      );

      // Step 3: Write result
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
