#!/usr/bin/env tsx
/**
 * evaluate-azure-openai.ts — LongMemEval with Azure OpenAI as the answer
 * generator. Mirrors evaluate.ts; swaps Anthropic Claude for Azure GPT-4o
 * so the number is apples-to-apples against Mem0 (93.4% on S) and Zep
 * (71.2% on S), both of which benchmarked on GPT-4o.
 *
 * Env required:
 *   AZURE_OPENAI_ENDPOINT  e.g. https://mnemopay-openai.openai.azure.com/
 *   AZURE_OPENAI_KEY       api-key for the resource
 *   AZURE_OPENAI_DEPLOYMENT  deployment name (default: gpt-4o)
 *
 * Usage:
 *   npx tsx evaluate-azure-openai.ts \
 *     --data data/longmemeval_s_cleaned.json \
 *     --out results/s_azure_gpt4o/hypothesis.jsonl \
 *     --recall-limit 20
 */

import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1", ...dns.getServers()]);

process.on("uncaughtException", (e) => { console.error("\nUNCAUGHT:", e); process.exit(2); });
process.on("unhandledRejection", (e) => { console.error("\nUNHANDLED:", e); process.exit(3); });

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { MnemoPay, SQLiteStorage } from "@mnemopay/sdk";
import type { LongMemEvalInstance, Hypothesis, Turn } from "./types.js";

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    dataFile: get("--data", "data/longmemeval_s_cleaned.json"),
    outputFile: get("--out", "results/s_azure_gpt4o/hypothesis.jsonl"),
    recallLimit: parseInt(get("--recall-limit", "30"), 10),
    maxQuestions: parseInt(get("--max", "0"), 10),
    resumeFrom: parseInt(get("--resume", "0"), 10),
    deployment: get("--deployment", process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o"),
    apiVersion: get("--api-version", "2024-10-21"),
    concurrency: parseInt(get("--concurrency", "4"), 10),
    recallStrategy: get("--recall-strategy", "hybrid") as "score" | "vector" | "hybrid",
    embeddings: get("--embeddings", "bge") as "bge" | "local" | "openai",
    interDelayMs: parseInt(get("--inter-delay", "1000"), 10),
    sessionLevel: !args.includes("--no-session-level"),
    maxContextChars: parseInt(get("--max-context-chars", "80000"), 10),
    ingestMode: get("--ingest-mode", "chunk") as "chunk" | "session",
  };
}

// ─── Session Formatting ──────────────────────────────────────────────────────

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

// ─── Ingest + Recall ─────────────────────────────────────────────────────────

async function ingestAndRecall(
  instance: LongMemEvalInstance,
  query: string,
  recallLimit: number,
  recallStrategy: "score" | "vector" | "hybrid",
  embeddings: "bge" | "local" | "openai",
  sessionLevel: boolean,
  maxContextChars: number,
  ingestMode: "chunk" | "session"
): Promise<string[]> {
  const agentId = `lme-s-${instance.question_id}`;
  // In-memory SQLite for this agent only — gives hybrid recall a real BM25/FTS5
  // lexical channel. When MnemoPay.quick() sees a SQLiteStorage in opts.storage,
  // it auto-wires it as sqliteStorage in the RecallEngine (see src/index.ts).
  // :memory: avoids disk I/O and is reclaimed when we call disconnect().
  const sqliteStorage = recallStrategy === "hybrid" ? new SQLiteStorage(":memory:") : undefined;
  const agent = MnemoPay.quick(agentId, {
    recall: recallStrategy,
    embeddings,
    openaiApiKey: embeddings === "openai" ? (process.env.OPENAI_API_KEY || "") : undefined,
    storage: sqliteStorage,
  });

  try {
    // Map session_id → full session text (session-level expansion)
    const sessionText = new Map<string, string>();
    for (let i = 0; i < instance.haystack_sessions.length; i++) {
      const session = instance.haystack_sessions[i];
      const sessionId = instance.haystack_session_ids[i] ?? `session-${i}`;
      const date = instance.haystack_dates[i] ?? "unknown";
      const content = formatSession(session, sessionId, date);
      sessionText.set(sessionId, content);
      if (ingestMode === "session") {
        const preview = content.length > 1800 ? content.slice(0, 1800) : content;
        await agent.remember(preview, { tags: [`session:${sessionId}`, `date:${date}`] });
      } else {
        for (const chunk of chunkContent(content, 2000)) {
          await agent.remember(chunk, { tags: [`session:${sessionId}`, `date:${date}`] });
        }
      }
    }

    const recalled: any[] = await agent.recall(query, recallLimit);

    if (!sessionLevel) {
      return recalled.map((m) => m.content);
    }

    const seen = new Set<string>();
    const out: string[] = [];
    let total = 0;
    for (const m of recalled) {
      const tag = (m.tags || []).find((t: string) => t.startsWith("session:")) as string | undefined;
      if (!tag) {
        if (total + m.content.length > maxContextChars) break;
        out.push(m.content);
        total += m.content.length;
        continue;
      }
      const sid = tag.slice("session:".length);
      if (seen.has(sid)) continue;
      const full = sessionText.get(sid);
      if (!full) continue;
      if (total + full.length > maxContextChars) break;
      seen.add(sid);
      out.push(full);
      total += full.length;
    }
    return out;
  } finally {
    // Free the SQLite handle (in-memory DB) + any vector caches. Without this
    // we leak one connection per question across 500q runs.
    try { await agent.disconnect(); } catch { /* swallow — best effort */ }
  }
}

// ─── Azure OpenAI ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful assistant with access to a user's conversation history. Your task is to answer questions about past conversations accurately and concisely.

Guidelines:
- Answer based ONLY on the provided conversation history context.
- If the context contains the answer, provide it directly and concisely.
- For temporal reasoning questions (e.g., "how many days between X and Y"), use the session dates provided in the context.
- For knowledge update questions, provide the MOST RECENT information from the context.
- For preference questions, reference the user's stated preferences from the context.
- If the question cannot be answered from the provided context, say so clearly — do NOT make up information.
- Keep answers concise. Do not explain your reasoning unless asked.`;

async function azureChat(
  endpoint: string,
  apiKey: string,
  deployment: string,
  apiVersion: string,
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

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const body = {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 512,
    temperature: 0,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  const j: any = await res.json();
  const content = j?.choices?.[0]?.message?.content || "";
  return String(content).trim();
}

// ─── Concurrency Limiter ────────────────────────────────────────────────────

class RateLimiter {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private maxConcurrent: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) { this.running++; return; }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve(); });
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
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
  const apiKey = process.env.AZURE_OPENAI_KEY || "";

  if (!endpoint || !apiKey) {
    console.error("ERROR: AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY env vars required.");
    process.exit(1);
  }
  if (!existsSync(opts.dataFile)) {
    console.error(`ERROR: Data file not found: ${opts.dataFile}`);
    process.exit(1);
  }

  console.log(`\n=== MnemoPay LongMemEval-S (Azure OpenAI) ===`);
  console.log(`Endpoint:     ${endpoint}`);
  console.log(`Deployment:   ${opts.deployment}`);
  console.log(`Data file:    ${opts.dataFile}`);
  console.log(`Output:       ${opts.outputFile}`);
  console.log(`Recall limit: ${opts.recallLimit}`);
  console.log(`Recall:       ${opts.recallStrategy} (embeddings=${opts.embeddings})`);
  console.log(`Ingest mode:  ${opts.ingestMode}`);
  console.log(`Session-lvl:  ${opts.sessionLevel ? "ON" : "off"} (max ${opts.maxContextChars} chars)`);
  console.log(`Concurrency:  ${opts.concurrency}`);

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
        } catch {}
      }
      if (existingIds.size > 0) {
        console.log(`\nFound ${existingIds.size} existing results — resuming.`);
        instances = instances.filter((i) => !existingIds.has(i.question_id));
      }
    }
  }

  console.log(`\nProcessing ${instances.length} questions.\n`);
  if (instances.length === 0) { console.log("Nothing to do."); return; }

  mkdirSync(dirname(opts.outputFile), { recursive: true });
  if (existingIds.size === 0 && opts.resumeFrom === 0) writeFileSync(opts.outputFile, "");

  const limiter = new RateLimiter(opts.concurrency);
  const t0 = Date.now();
  let completed = 0;
  let errors = 0;

  async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try { return await fn(); }
      catch (err: any) {
        const msg = String(err?.message || "");
        const is429 = err.status === 429 || msg.includes("429");
        const is5xx = err.status >= 500 && err.status < 600;
        const isNet = msg.includes("fetch failed")
          || msg.includes("ECONNRESET")
          || msg.includes("ETIMEDOUT")
          || msg.includes("ENOTFOUND")
          || msg.includes("EAI_AGAIN")
          || err.code === "UND_ERR_SOCKET";
        if ((is429 || is5xx || isNet) && attempt < maxRetries) {
          const delay = Math.min(30000, 3000 * Math.pow(2, attempt));
          console.error(`\n[${label}] ${err.status || err.code || "net"} retry ${attempt + 1}/${maxRetries} in ${delay/1000}s`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  const promises = instances.map(async (instance, idx) => {
    await limiter.acquire();
    try {
      const context = await withRetry(
        () => ingestAndRecall(
          instance, instance.question, opts.recallLimit, opts.recallStrategy,
          opts.embeddings, opts.sessionLevel, opts.maxContextChars, opts.ingestMode
        ),
        `recall:${instance.question_id}`
      );
      const hypothesis = await withRetry(
        () => azureChat(endpoint, apiKey, opts.deployment, opts.apiVersion, instance.question, instance.question_date, context),
        instance.question_id
      );
      appendFileSync(opts.outputFile, JSON.stringify({ question_id: instance.question_id, hypothesis } satisfies Hypothesis) + "\n");
      completed++;
      const pct = (((completed + errors) / instances.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`\r[${pct}%] ${completed}/${instances.length} done, ${errors} errors — ${elapsed}s`);
      if (idx < instances.length - 1 && opts.interDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.interDelayMs));
      }
    } catch (err: any) {
      errors++;
      console.error(`\nError on ${instance.question_id}: ${err.message}`);
      appendFileSync(opts.outputFile, JSON.stringify({
        question_id: instance.question_id,
        hypothesis: "I don't have enough information to answer this question.",
      } satisfies Hypothesis) + "\n");
    } finally {
      limiter.release();
    }
  });

  await Promise.all(promises);
  const totalMs = Date.now() - t0;
  console.log(`\n\nDone: ${completed} answered, ${errors} errors, ${(totalMs/1000).toFixed(1)}s`);
  console.log(`\nJudge next:`);
  console.log(`  cd longmemeval-repo && python3 src/evaluation/evaluate_qa.py gpt-4o ../${opts.outputFile} ../${opts.dataFile}`);
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
