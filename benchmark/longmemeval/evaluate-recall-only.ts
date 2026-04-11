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
import { MnemoPay } from "@mnemopay/sdk";
import type { LongMemEvalInstance, Turn } from "./types.js";

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
  let total = 0;

  const byType: Record<string, { answerHit: number; sessionHit: number; total: number }> = {};

  const details: Array<{
    qid: string;
    qtype: string;
    question: string;
    answer: string;
    answerFound: boolean;
    sessionFound: boolean;
    recalledSessions: string[];
    answerSessions: string[];
    recallCount: number;
  }> = [];

  for (const inst of instances) {
    const agentId = `lme-recall-${inst.question_id}`;
    const agent = MnemoPay.quick(agentId, { recall: opts.recallStrategy });

    // Ingest all sessions
    for (let i = 0; i < inst.haystack_sessions.length; i++) {
      const session = inst.haystack_sessions[i];
      const sessionId = inst.haystack_session_ids[i] ?? `session-${i}`;
      const date = inst.haystack_dates[i] ?? "unknown";
      const content = formatSession(session, sessionId, date);
      const chunks = chunkContent(content, 8000);
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
    for (const text of recalledTexts) {
      const match = text.match(/\[Session (\S+)/);
      if (match) recalledSessionIds.push(match[1]);
    }
    const sessionFound = recalledSessionIds.some(sid => answerSessionIds.has(sid));

    // Track stats
    const qtype = inst.question_type ?? "unknown";
    if (!byType[qtype]) byType[qtype] = { answerHit: 0, sessionHit: 0, total: 0 };
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

    details.push({
      qid: inst.question_id,
      qtype,
      question: inst.question,
      answer: inst.answer,
      answerFound,
      sessionFound,
      recalledSessions: recalledSessionIds,
      answerSessions: inst.answer_session_ids ?? [],
      recallCount: memories.length,
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

  console.log(`  ANSWER IN RECALLED: ${answerInRecalled}/${total} = ${((answerInRecalled/total)*100).toFixed(1)}%`);
  console.log(`  SESSION HIT RATE:   ${sessionHit}/${total} = ${((sessionHit/total)*100).toFixed(1)}%\n`);

  console.log(`  By Question Type:`);
  console.log(`  ${"─".repeat(56)}`);
  console.log(`  ${"Type".padEnd(30)} ${"Answer Hit".padEnd(13)} ${"Session Hit".padEnd(13)}`);
  console.log(`  ${"─".repeat(56)}`);
  for (const [qtype, stats] of Object.entries(byType).sort()) {
    const aPct = ((stats.answerHit / stats.total) * 100).toFixed(1);
    const sPct = ((stats.sessionHit / stats.total) * 100).toFixed(1);
    console.log(
      `  ${qtype.padEnd(30)} ${`${stats.answerHit}/${stats.total} (${aPct}%)`.padEnd(13)} ${`${stats.sessionHit}/${stats.total} (${sPct}%)`.padEnd(13)}`
    );
  }
  console.log(`  ${"─".repeat(56)}`);

  // Save detailed results
  const outDir = `results/recall_only_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/details.json`, JSON.stringify(details, null, 2));
  writeFileSync(`${outDir}/summary.json`, JSON.stringify({
    recallStrategy: opts.recallStrategy,
    recallLimit: opts.recallLimit,
    totalQuestions: total,
    answerInRecalled: { count: answerInRecalled, pct: ((answerInRecalled/total)*100).toFixed(1) },
    sessionHitRate: { count: sessionHit, pct: ((sessionHit/total)*100).toFixed(1) },
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, {
        total: v.total,
        answerHit: v.answerHit,
        answerHitPct: ((v.answerHit / v.total) * 100).toFixed(1),
        sessionHit: v.sessionHit,
        sessionHitPct: ((v.sessionHit / v.total) * 100).toFixed(1),
      }])
    ),
    timeMs: totalMs,
  }, null, 2));

  console.log(`\n  Results saved: ${outDir}/`);

  // Show some misses
  const misses = details.filter(d => !d.answerFound).slice(0, 5);
  if (misses.length > 0) {
    console.log(`\n  Sample misses (answer NOT in recalled memories):`);
    for (const m of misses) {
      console.log(`    [${m.qtype}] Q: ${m.question.slice(0, 80)}...`);
      console.log(`      Gold: "${m.answer.slice(0, 60)}"`);
      console.log(`      Recalled ${m.recallCount} memories from sessions: [${m.recalledSessions.slice(0, 5).join(", ")}]`);
      console.log(`      Answer sessions: [${m.answerSessions.join(", ")}]`);
      console.log();
    }
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
