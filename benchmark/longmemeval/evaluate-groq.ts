#!/usr/bin/env tsx
/**
 * evaluate-groq.ts — Same as evaluate.ts but uses Groq (free Llama 3.3 70B)
 * instead of Claude for answer generation. Tests MnemoPay recall quality
 * without requiring Anthropic API credits.
 *
 * Usage:
 *   GROQ_API_KEY=gsk_... npx tsx evaluate-groq.ts --data data/longmemeval_oracle.json --out results/hypothesis.jsonl --max 50
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { MnemoPay } from "@mnemopay/sdk";
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
    model: get("--model", "llama-3.3-70b-versatile"),
    concurrency: parseInt(get("--concurrency", "2"), 10), // Lower for Groq rate limits
    recallStrategy: get("--recall-strategy", "score") as "score" | "vector" | "hybrid",
  };
}

// ─── Session Formatting ─────────────────────────────────────────────────────

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

// ─── Ingest Instance ─────────────────────────────────────────────────────────

async function ingestAndRecall(
  instance: LongMemEvalInstance,
  query: string,
  recallLimit: number,
  recallStrategy: "score" | "vector" | "hybrid"
): Promise<string[]> {
  const agentId = `lme-${instance.question_id}`;
  const agent = MnemoPay.quick(agentId, { recall: recallStrategy });

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

  const memories = await agent.recall(query, recallLimit);
  return memories.map((m) => m.content);
}

// ─── Groq Answer Generation (OpenAI-compatible) ─────────────────────────────

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
  apiKey: string,
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

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data = await response.json() as any;
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

// ─── Rate Limiter with per-minute throttle ──────────────────────────────────

class RateLimiter {
  private queue: (() => void)[] = [];
  private running = 0;
  private timestamps: number[] = [];

  constructor(private maxConcurrent: number, private maxPerMinute: number = 28) {}

  async acquire(): Promise<void> {
    // Enforce per-minute rate limit
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60000);
    if (this.timestamps.length >= this.maxPerMinute) {
      const waitMs = 60000 - (now - this.timestamps[0]) + 100;
      await new Promise(r => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());

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

  console.log(`\n=== MnemoPay LongMemEval Evaluation (Groq) ===`);
  console.log(`Data file:       ${opts.dataFile}`);
  console.log(`Output file:     ${opts.outputFile}`);
  console.log(`Recall limit:    ${opts.recallLimit}`);
  console.log(`Recall strategy: ${opts.recallStrategy}`);
  console.log(`Model:           ${opts.model}`);
  console.log(`Concurrency:     ${opts.concurrency}`);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("\nERROR: GROQ_API_KEY environment variable is required.");
    process.exit(1);
  }

  if (!existsSync(opts.dataFile)) {
    console.error(`\nERROR: Data file not found: ${opts.dataFile}`);
    process.exit(1);
  }

  const raw = readFileSync(opts.dataFile, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);
  let instances = opts.maxQuestions > 0 ? dataset.slice(0, opts.maxQuestions) : dataset;

  // Resume support
  let existingIds = new Set<string>();
  if (opts.resumeFrom > 0) {
    instances = instances.slice(opts.resumeFrom);
  } else if (existsSync(opts.outputFile)) {
    const existing = readFileSync(opts.outputFile, "utf-8").trim();
    if (existing) {
      for (const line of existing.split("\n")) {
        try {
          const h: Hypothesis = JSON.parse(line);
          existingIds.add(h.question_id);
        } catch { /* skip */ }
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

  mkdirSync(dirname(opts.outputFile), { recursive: true });

  if (existingIds.size === 0 && opts.resumeFrom === 0) {
    writeFileSync(opts.outputFile, "");
  }

  const limiter = new RateLimiter(opts.concurrency, 28); // Groq free: 30/min, leave headroom

  const t0 = Date.now();
  let completed = 0;
  let errors = 0;

  // Process sequentially to respect Groq rate limits better
  for (const instance of instances) {
    await limiter.acquire();

    try {
      const context = await ingestAndRecall(
        instance,
        instance.question,
        opts.recallLimit,
        opts.recallStrategy
      );

      const hypothesis = await generateAnswer(
        apiKey,
        opts.model,
        instance.question,
        instance.question_date,
        context
      );

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

      // Rate limit? Wait and retry once
      if (err.message.includes("429") || err.message.includes("rate")) {
        console.log("  Rate limited, waiting 60s...");
        await new Promise(r => setTimeout(r, 60000));
        try {
          const context = await ingestAndRecall(
            instance,
            instance.question,
            opts.recallLimit,
            opts.recallStrategy
          );
          const hypothesis = await generateAnswer(
            apiKey,
            opts.model,
            instance.question,
            instance.question_date,
            context
          );
          const result: Hypothesis = { question_id: instance.question_id, hypothesis };
          appendFileSync(opts.outputFile, JSON.stringify(result) + "\n");
          errors--;
          completed++;
        } catch {
          const fallback: Hypothesis = {
            question_id: instance.question_id,
            hypothesis: "I don't have enough information to answer this question.",
          };
          appendFileSync(opts.outputFile, JSON.stringify(fallback) + "\n");
        }
      } else {
        const fallback: Hypothesis = {
          question_id: instance.question_id,
          hypothesis: "I don't have enough information to answer this question.",
        };
        appendFileSync(opts.outputFile, JSON.stringify(fallback) + "\n");
      }
    } finally {
      limiter.release();
    }
  }

  const totalMs = Date.now() - t0;

  console.log(`\n\nEvaluation complete:`);
  console.log(`  Questions:  ${completed} answered, ${errors} errors`);
  console.log(`  Time:       ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Output:     ${opts.outputFile}`);

  // ─── Self-Evaluation (since we don't have GPT-4o for judging) ─────────────
  // Do a simple keyword/exact-match self-evaluation against the gold answers
  console.log(`\n=== Quick Self-Evaluation ===`);

  const hypotheses: Map<string, string> = new Map();
  const hypLines = readFileSync(opts.outputFile, "utf-8").trim().split("\n");
  for (const line of hypLines) {
    try {
      const h: Hypothesis = JSON.parse(line);
      hypotheses.set(h.question_id, h.hypothesis);
    } catch { /* skip */ }
  }

  let correct = 0;
  let total = 0;
  let byType: Record<string, { correct: number; total: number }> = {};

  const fullDataset: LongMemEvalInstance[] = JSON.parse(readFileSync(opts.dataFile, "utf-8"));
  const evaluated = fullDataset.filter(inst => hypotheses.has(inst.question_id));

  for (const inst of evaluated) {
    const hyp = hypotheses.get(inst.question_id)!.toLowerCase();
    const goldAnswer = (typeof inst.answer === "string" ? inst.answer : String(inst.answer)).toLowerCase().trim();
    const qtype = inst.question_type ?? "unknown";

    if (!byType[qtype]) byType[qtype] = { correct: 0, total: 0 };
    byType[qtype].total++;
    total++;

    // Check if gold answer appears in the hypothesis
    let isCorrect = false;
    // Exact containment check
    if (hyp.includes(goldAnswer)) {
      isCorrect = true;
    } else {
      // Check individual significant words (for multi-word answers)
      const words = goldAnswer.split(/\s+/).filter(w => w.length > 3);
      if (words.length >= 2) {
        const matched = words.filter(w => hyp.includes(w));
        isCorrect = matched.length / words.length >= 0.7;
      } else if (words.length === 1) {
        isCorrect = hyp.includes(words[0]);
      }
    }

    if (isCorrect) {
      correct++;
      byType[qtype].correct++;
    }
  }

  console.log(`\nKeyword-Match Accuracy (approximate):`);
  console.log(`  Overall: ${correct}/${total} = ${total > 0 ? ((correct/total)*100).toFixed(1) : 0}%`);
  console.log(`\n  By question type:`);
  for (const [qtype, stats] of Object.entries(byType).sort()) {
    const pct = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(1) : "0.0";
    console.log(`    ${qtype}: ${stats.correct}/${stats.total} = ${pct}%`);
  }

  console.log(`\nNote: This is keyword-match, not GPT-4o judge. Real scores may differ.`);
  console.log(`For official evaluation, set OPENAI_API_KEY and run:`);
  console.log(`  python3 longmemeval-repo/src/evaluation/evaluate_qa.py gpt-4o ${opts.outputFile} ${opts.dataFile}`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
