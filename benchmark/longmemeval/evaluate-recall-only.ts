#!/usr/bin/env tsx
/**
 * evaluate-recall-only.ts — Test MnemoPay's recall quality directly
 * by checking if retrieved memories contain the gold answer.
 * No LLM needed — pure recall precision test.
 *
 * For each question:
 *   1. Ingest all haystack sessions into MnemoPay
 *   2. Recall top-K memories for the question
 *   3. Check if any recalled memory contains the answer
 *   4. Check if the correct answer session was retrieved
 *
 * Usage:
 *   npx tsx evaluate-recall-only.ts --data data/longmemeval_oracle.json --max 50
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { MnemoPay, bgeStats } from "@mnemopay/sdk";
import type { LongMemEvalInstance, Turn } from "./types.js";

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    dataFile: get("--data", "data/longmemeval_oracle.json"),
    recallLimit: parseInt(get("--recall-limit", "20"), 10),
    maxQuestions: parseInt(get("--max", "0"), 10),
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

function containsAnswer(text: string, answer: string | number): boolean {
  const textLower = text.toLowerCase();
  const answerStr = String(answer);
  const answerLower = answerStr.toLowerCase().trim();

  // Direct containment
  if (textLower.includes(answerLower)) return true;

  // Key words match (for multi-word answers)
  const words = answerLower.split(/\s+/).filter(w => w.length > 3);
  if (words.length >= 2) {
    const matched = words.filter(w => textLower.includes(w));
    return matched.length / words.length >= 0.7;
  } else if (words.length === 1) {
    return textLower.includes(words[0]);
  }

  return false;
}

async function main() {
  const opts = parseArgs();

  console.log(`\n=== MnemoPay Recall-Only Evaluation ===`);
  console.log(`Data file:       ${opts.dataFile}`);
  console.log(`Recall limit:    ${opts.recallLimit}`);
  console.log(`Recall strategy: ${opts.recallStrategy}`);
  console.log(`Max questions:   ${opts.maxQuestions || "all"}`);

  const raw = readFileSync(opts.dataFile, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);
  const instances = opts.maxQuestions > 0 ? dataset.slice(0, opts.maxQuestions) : dataset;

  console.log(`\nProcessing ${instances.length} questions...\n`);

  const t0 = Date.now();

  let answerInRecalled = 0;
  let sessionHit = 0;
  let allSessionsHit = 0;
  let total = 0;

  const byType: Record<string, { answerHit: number; sessionHit: number; allSessionsHit: number; total: number }> = {};

  const details: Array<{
    qid: string;
    qtype: string;
    question: string;
    answer: string;
    answerFound: boolean;
    sessionFound: boolean;
    allSessionsFound: boolean;
    recalledSessions: string[];
    recalledSnippets: Array<{ sessionId: string; firstLine: string }>;
    answerSessions: string[];
    recallCount: number;
    haystackSize: number;
  }> = [];

  const haystackSizes: number[] = [];

  for (const inst of instances) {
    const agentId = `lme-recall-${inst.question_id}`;
    const agent = MnemoPay.quick(agentId, {
      recall: opts.recallStrategy,
      embeddings: "bge",
    });

    // Ingest all sessions
    for (let i = 0; i < inst.haystack_sessions.length; i++) {
      const session = inst.haystack_sessions[i];
      const sessionId = inst.haystack_session_ids[i] ?? `session-${i}`;
      const date = inst.haystack_dates[i] ?? "unknown";
      const content = formatSession(session, sessionId, date);
      const chunks = chunkContent(content, 2000);
      for (const chunk of chunks) {
        await agent.remember(chunk, { tags: [`session:${sessionId}`, `date:${date}`] });
      }
    }

    // Recall
    const memories = await agent.recall(inst.question, opts.recallLimit);
    const recalledTexts = memories.map(m => m.content);
    const recalledJoined = recalledTexts.join("\n");

    // Check 1: Does any recalled memory contain the gold answer?
    const answerFound = containsAnswer(recalledJoined, inst.answer);

    // Check 2: Were the correct answer sessions retrieved?
    const answerSessionIds = new Set(inst.answer_session_ids ?? []);
    const recalledSessionIds: string[] = [];
    const recalledSnippets: Array<{ sessionId: string; firstLine: string }> = [];
    for (const text of recalledTexts) {
      const match = text.match(/\[Session (\S+)/);
      if (match) {
        const sid = match[1];
        recalledSessionIds.push(sid);
        const lines = text.split("\n");
        const firstContent = lines.slice(1).find(l => l.trim().length > 0) ?? "";
        recalledSnippets.push({ sessionId: sid, firstLine: firstContent.slice(0, 200) });
      }
    }
    const sessionFound = recalledSessionIds.some(sid => answerSessionIds.has(sid));
    const recalledSet = new Set(recalledSessionIds);
    const allSessionsFound = answerSessionIds.size > 0
      && Array.from(answerSessionIds).every(sid => recalledSet.has(sid));

    // Track stats
    const qtype = inst.question_type ?? "unknown";
    if (!byType[qtype]) byType[qtype] = { answerHit: 0, sessionHit: 0, allSessionsHit: 0, total: 0 };
    byType[qtype].total++;
    total++;

    if (answerFound) {
      answerInRecalled++;
      byType[qtype].answerHit++;
    }
    if (sessionFound) {
      sessionHit++;
      byType[qtype].sessionHit++;
    }
    if (allSessionsFound) {
      allSessionsHit++;
      byType[qtype].allSessionsHit++;
    }

    const haystackSize = inst.haystack_sessions.length;
    haystackSizes.push(haystackSize);

    details.push({
      qid: inst.question_id,
      qtype,
      question: inst.question,
      answer: inst.answer,
      answerFound,
      sessionFound,
      allSessionsFound,
      recalledSessions: recalledSessionIds,
      recalledSnippets,
      answerSessions: inst.answer_session_ids ?? [],
      recallCount: memories.length,
      haystackSize,
    });

    const pct = ((total / instances.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(
      `\r[${pct}%] ${total}/${instances.length} — answer hit: ${answerInRecalled}/${total} (${((answerInRecalled/total)*100).toFixed(1)}%) — ${elapsed}s`
    );
  }

  const totalMs = Date.now() - t0;

  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`  MnemoPay LongMemEval Recall Results`);
  console.log(`${"=".repeat(60)}\n`);

  console.log(`  Recall Strategy:    ${opts.recallStrategy}`);
  console.log(`  Recall Limit:       ${opts.recallLimit}`);
  console.log(`  Questions Evaluated: ${total}`);
  console.log(`  Time:               ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Avg per question:   ${(totalMs / total / 1000).toFixed(2)}s\n`);

  console.log(`  ANSWER IN RECALLED:     ${answerInRecalled}/${total} = ${((answerInRecalled/total)*100).toFixed(1)}%`);
  console.log(`  SESSION-RECALL@20 ANY:  ${sessionHit}/${total} = ${((sessionHit/total)*100).toFixed(1)}%`);
  console.log(`  SESSION-RECALL@20 ALL:  ${allSessionsHit}/${total} = ${((allSessionsHit/total)*100).toFixed(1)}%\n`);

  console.log(`  By Question Type:`);
  console.log(`  ${"─".repeat(78)}`);
  console.log(`  ${"Type".padEnd(30)} ${"Any-Gold".padEnd(18)} ${"All-Gold".padEnd(18)}`);
  console.log(`  ${"─".repeat(78)}`);
  for (const [qtype, stats] of Object.entries(byType).sort()) {
    const anyPct = ((stats.sessionHit / stats.total) * 100).toFixed(1);
    const allPct = ((stats.allSessionsHit / stats.total) * 100).toFixed(1);
    console.log(
      `  ${qtype.padEnd(30)} ${`${stats.sessionHit}/${stats.total} (${anyPct}%)`.padEnd(18)} ${`${stats.allSessionsHit}/${stats.total} (${allPct}%)`.padEnd(18)}`
    );
  }
  console.log(`  ${"─".repeat(78)}\n`);

  const sortedHaystack = [...haystackSizes].sort((a, b) => a - b);
  const hMin = sortedHaystack[0] ?? 0;
  const hMedian = percentile(sortedHaystack, 50);
  const hP90 = percentile(sortedHaystack, 90);
  const hMax = sortedHaystack[sortedHaystack.length - 1] ?? 0;
  console.log(`  Haystack sessions per question: min=${hMin}, median=${hMedian}, p90=${hP90}, max=${hMax}`);

  // Rank worst: missed all gold sessions, then missed any gold session
  const worst10 = [...details]
    .map(d => ({
      ...d,
      _rank: (d.sessionFound ? 1 : 0) * 1000 + (d.allSessionsFound ? 1 : 0) * 100 + (d.answerFound ? 1 : 0),
    }))
    .sort((a, b) => a._rank - b._rank)
    .slice(0, 10)
    .map(d => ({
      qid: d.qid,
      qtype: d.qtype,
      question: d.question,
      goldSessions: d.answerSessions,
      retrievedTop20: d.recalledSnippets,
      sessionFound: d.sessionFound,
      allSessionsFound: d.allSessionsFound,
    }));

  const runConfig = {
    dataFile: opts.dataFile,
    recallStrategy: opts.recallStrategy,
    recallLimit: opts.recallLimit,
    chunkSize: 2000,
    chunkAlignment: "line-aligned",
    embedder: {
      provider: "bge",
      model: bgeStats.model,
      dimensions: bgeStats.dimensions,
      loadTimeMs: bgeStats.loadTimeMs,
      totalEmbedTimeMs: bgeStats.totalEmbedTimeMs,
      embedCount: bgeStats.embedCount,
      avgEmbedMs: bgeStats.embedCount > 0
        ? +(bgeStats.totalEmbedTimeMs / bgeStats.embedCount).toFixed(2)
        : 0,
      loaded: bgeStats.loaded,
    },
    topK: opts.recallLimit,
    gitSha: getGitSha(),
    node: process.version,
    timestamp: new Date().toISOString(),
  };

  // Save detailed results
  const outDir = `results/recall_only_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/details.json`, JSON.stringify(details, null, 2));
  writeFileSync(`${outDir}/worst10.json`, JSON.stringify(worst10, null, 2));
  writeFileSync(`${outDir}/summary.json`, JSON.stringify({
    runConfig,
    totalQuestions: total,
    answerInRecalled: { count: answerInRecalled, pct: ((answerInRecalled/total)*100).toFixed(1) },
    sessionRecallAt20_anyGold: { count: sessionHit, pct: ((sessionHit/total)*100).toFixed(1) },
    sessionRecallAt20_allGold: { count: allSessionsHit, pct: ((allSessionsHit/total)*100).toFixed(1) },
    haystackDistribution: {
      min: hMin,
      median: hMedian,
      p90: hP90,
      max: hMax,
    },
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, {
        total: v.total,
        answerHit: v.answerHit,
        answerHitPct: ((v.answerHit / v.total) * 100).toFixed(1),
        sessionHit_anyGold: v.sessionHit,
        sessionHit_anyGoldPct: ((v.sessionHit / v.total) * 100).toFixed(1),
        sessionHit_allGold: v.allSessionsHit,
        sessionHit_allGoldPct: ((v.allSessionsHit / v.total) * 100).toFixed(1),
      }])
    ),
    timeMs: totalMs,
  }, null, 2));

  console.log(`\n  Results saved: ${outDir}/`);

  console.log(`\n  Worst 10 questions (ranked by missed gold sessions):\n`);
  for (let i = 0; i < worst10.length; i++) {
    const w = worst10[i];
    console.log(`  #${i + 1} [${w.qtype}] qid=${w.qid}`);
    console.log(`    Q: ${w.question}`);
    console.log(`    Gold sessions: [${w.goldSessions.join(", ")}]`);
    console.log(`    Retrieved top-20:`);
    for (const s of w.retrievedTop20) {
      console.log(`      - ${s.sessionId} | ${s.firstLine}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
