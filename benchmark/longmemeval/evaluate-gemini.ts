#!/usr/bin/env tsx
/**
 * evaluate-gemini.ts — Uses Google Gemini (free tier, high limits) for answer generation.
 * Tests MnemoPay recall quality on LongMemEval.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { MnemoPay } from "@mnemopay/sdk";
import type { LongMemEvalInstance, Hypothesis, Turn } from "./types.js";

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
    model: get("--model", "gemini-2.0-flash"),
    concurrency: parseInt(get("--concurrency", "2"), 10),
    recallStrategy: get("--recall-strategy", "score") as "score" | "vector" | "hybrid",
  };
}

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
      await agent.remember(chunk, { tags: [`session:${sessionId}`, `date:${date}`] });
    }
  }

  const memories = await agent.recall(query, recallLimit);
  return memories.map((m) => m.content);
}

const SYSTEM_PROMPT = `You are a helpful assistant with access to a user's conversation history. Your task is to answer questions about past conversations accurately and concisely.

Guidelines:
- Answer based ONLY on the provided conversation history context.
- If the context contains the answer, provide it directly and concisely.
- For temporal reasoning questions, use the session dates provided in the context.
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json() as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text.trim();
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs();

  console.log(`\n=== MnemoPay LongMemEval Evaluation (Gemini) ===`);
  console.log(`Data file:       ${opts.dataFile}`);
  console.log(`Output file:     ${opts.outputFile}`);
  console.log(`Recall limit:    ${opts.recallLimit}`);
  console.log(`Recall strategy: ${opts.recallStrategy}`);
  console.log(`Model:           ${opts.model}`);
  console.log(`Concurrency:     ${opts.concurrency}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("\nERROR: GEMINI_API_KEY environment variable is required.");
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
  if (existsSync(opts.outputFile)) {
    const existing = readFileSync(opts.outputFile, "utf-8").trim();
    if (existing) {
      for (const line of existing.split("\n")) {
        try {
          const h: Hypothesis = JSON.parse(line);
          if (h.hypothesis !== "I don't have enough information to answer this question.") {
            existingIds.add(h.question_id);
          }
        } catch { /* skip */ }
      }
      if (existingIds.size > 0) {
        console.log(`\nFound ${existingIds.size} existing good results — resuming.`);
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

  if (existingIds.size === 0) {
    writeFileSync(opts.outputFile, "");
  }

  const t0 = Date.now();
  let completed = 0;
  let errors = 0;

  for (const instance of instances) {
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

      completed++;
      const pct = (((completed + errors) / instances.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(
        `\r[${pct}%] ${completed}/${instances.length} done, ${errors} errors — ${elapsed}s elapsed`
      );

      // Small delay to avoid rate limits (Gemini free: 15 RPM for flash)
      await sleep(4500);
    } catch (err: any) {
      errors++;
      console.error(`\nError on ${instance.question_id}: ${err.message}`);

      if (err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED")) {
        console.log("  Rate limited, waiting 65s...");
        await sleep(65000);
        // Retry once
        try {
          const context = await ingestAndRecall(
            instance, instance.question, opts.recallLimit, opts.recallStrategy
          );
          const hypothesis = await generateAnswer(
            apiKey, opts.model, instance.question, instance.question_date, context
          );
          const result: Hypothesis = { question_id: instance.question_id, hypothesis };
          appendFileSync(opts.outputFile, JSON.stringify(result) + "\n");
          errors--;
          completed++;
          continue;
        } catch { /* fallthrough */ }
      }

      const fallback: Hypothesis = {
        question_id: instance.question_id,
        hypothesis: "I don't have enough information to answer this question.",
      };
      appendFileSync(opts.outputFile, JSON.stringify(fallback) + "\n");
    }
  }

  const totalMs = Date.now() - t0;
  console.log(`\n\nEvaluation complete:`);
  console.log(`  Questions:  ${completed} answered, ${errors} errors`);
  console.log(`  Time:       ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Output:     ${opts.outputFile}`);

  // Self-evaluation
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

    let isCorrect = false;
    if (hyp.includes(goldAnswer)) {
      isCorrect = true;
    } else {
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
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
