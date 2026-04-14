#!/usr/bin/env tsx
/**
 * ingest.ts — Load LongMemEval conversation sessions into MnemoPay memory.
 *
 * For each evaluation instance, we create a dedicated MnemoPay agent and ingest
 * all haystack sessions as memories. Each session is stored as a single memory
 * with the session date and ID in tags for temporal reasoning support.
 *
 * Usage:
 *   npx tsx ingest.ts --data data/longmemeval_oracle.json --out state/
 *   npx tsx ingest.ts --data data/longmemeval_m_cleaned.json --out state/ --concurrency 4
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MnemoPay } from "@mnemopay/sdk";
import type { LongMemEvalInstance, Turn } from "./types.js";

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  return {
    dataFile: get("--data", "data/longmemeval_oracle.json"),
    stateDir: get("--out", "state"),
    concurrency: parseInt(get("--concurrency", "8"), 10),
    maxQuestions: parseInt(get("--max", "0"), 10),
    consolidate: args.includes("--consolidate"),
  };
}

// ─── Session → Memory Content ────────────────────────────────────────────────

/**
 * Flatten a conversation session into a single text block suitable for memory
 * storage. Preserves speaker roles so recall can distinguish user vs assistant.
 */
function formatSession(turns: Turn[], sessionId: string, date: string): string {
  const lines = [`[Session ${sessionId} — ${date}]`];
  for (const turn of turns) {
    const speaker = turn.role === "human" ? "User" : "Assistant";
    lines.push(`${speaker}: ${turn.content}`);
  }
  return lines.join("\n");
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

interface IngestResult {
  questionId: string;
  agentId: string;
  sessionsIngested: number;
  memoriesStored: number;
  consolidated: number;
  durationMs: number;
}

async function ingestInstance(
  instance: LongMemEvalInstance,
  opts: { consolidate: boolean }
): Promise<IngestResult> {
  const t0 = Date.now();
  const agentId = `lme-${instance.question_id}`;
  const agent = MnemoPay.quick(agentId);

  let memoriesStored = 0;

  for (let i = 0; i < instance.haystack_sessions.length; i++) {
    const session = instance.haystack_sessions[i];
    const sessionId = instance.haystack_session_ids[i] ?? `session-${i}`;
    const date = instance.haystack_dates[i] ?? "unknown";

    // Store the full session as one memory unit.
    // Tag with session ID and date for temporal reasoning queries.
    const content = formatSession(session, sessionId, date);

    // Split very long sessions into chunks to stay under MnemoPay's 100KB limit
    // and improve recall granularity.
    const chunks = chunkContent(content, 2000);

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkLabel = chunks.length > 1 ? ` (part ${ci + 1}/${chunks.length})` : "";
      await agent.remember(chunks[ci], {
        tags: [
          `session:${sessionId}`,
          `date:${date}`,
          `question:${instance.question_id}`,
          ...(chunks.length > 1 ? [`chunk:${ci}`] : []),
        ],
      });
      memoriesStored++;
    }
  }

  let consolidated = 0;
  if (opts.consolidate) {
    consolidated = await agent.consolidate();
  }

  return {
    questionId: instance.question_id,
    agentId,
    sessionsIngested: instance.haystack_sessions.length,
    memoriesStored,
    consolidated,
    durationMs: Date.now() - t0,
  };
}

/**
 * Split content into chunks of approximately `maxChars` characters,
 * breaking at newline boundaries to keep turns intact.
 */
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

// ─── Concurrency Limiter ─────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`\n=== MnemoPay LongMemEval Ingestion ===`);
  console.log(`Data file:    ${opts.dataFile}`);
  console.log(`State dir:    ${opts.stateDir}`);
  console.log(`Concurrency:  ${opts.concurrency}`);
  console.log(`Consolidate:  ${opts.consolidate}`);

  // Load dataset
  if (!existsSync(opts.dataFile)) {
    console.error(`\nERROR: Data file not found: ${opts.dataFile}`);
    console.error(`Run: npm run download   (or bash scripts/download-data.sh)`);
    process.exit(1);
  }

  const raw = readFileSync(opts.dataFile, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);
  const instances = opts.maxQuestions > 0 ? dataset.slice(0, opts.maxQuestions) : dataset;

  console.log(`\nLoaded ${dataset.length} instances, processing ${instances.length}.\n`);

  // Ingest all instances
  const t0 = Date.now();
  const results = await mapWithConcurrency(
    instances,
    async (instance, idx) => {
      const result = await ingestInstance(instance, { consolidate: opts.consolidate });
      const pct = (((idx + 1) / instances.length) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] ${idx + 1}/${instances.length} — ${result.questionId} ` +
        `(${result.sessionsIngested} sessions, ${result.memoriesStored} memories, ${result.durationMs}ms)`
      );
      return result;
    },
    opts.concurrency
  );

  const totalMs = Date.now() - t0;
  const totalMemories = results.reduce((s, r) => s + r.memoriesStored, 0);
  const totalSessions = results.reduce((s, r) => s + r.sessionsIngested, 0);

  console.log(`\n\nIngestion complete:`);
  console.log(`  Instances:  ${results.length}`);
  console.log(`  Sessions:   ${totalSessions}`);
  console.log(`  Memories:   ${totalMemories}`);
  console.log(`  Time:       ${(totalMs / 1000).toFixed(1)}s`);

  // Save state manifest so evaluate.ts knows which agents to query
  mkdirSync(opts.stateDir, { recursive: true });
  const manifest = {
    dataFile: opts.dataFile,
    timestamp: new Date().toISOString(),
    instances: results.map((r) => ({
      questionId: r.questionId,
      agentId: r.agentId,
      memoriesStored: r.memoriesStored,
    })),
  };
  const manifestPath = join(opts.stateDir, "ingest-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest saved: ${manifestPath}`);
}

main().catch((err) => {
  console.error("\nFatal error during ingestion:", err);
  process.exit(1);
});
