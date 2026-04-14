import { describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

import { SQLiteStorage, type PersistedState } from "../../src/storage/sqlite.js";
import { RecallEngine } from "../../src/recall/engine.js";

type Topic =
  | "finance"
  | "health"
  | "travel"
  | "tech"
  | "food"
  | "history"
  | "science"
  | "sports"
  | "music"
  | "movies";

const TOPICS: Topic[] = [
  "finance",
  "health",
  "travel",
  "tech",
  "food",
  "history",
  "science",
  "sports",
  "music",
  "movies",
];

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function makeMemoryContent(topic: Topic, idx: number): string {
  const factToken = `${topic.toUpperCase()}_FACT_${idx}`;
  const flavor: Record<Topic, string> = {
    finance: `Budget plan: ${factToken}. Track cashflow monthly; watch volatility; diversify ETFs; avoid high fees.`,
    health: `Health note: ${factToken}. Sleep 7-8 hours; walk daily; hydrate; manage stress; log symptoms.`,
    travel: `Travel tip: ${factToken}. Book flights early; pack layers; check weather; keep backup documents.`,
    tech: `Tech reminder: ${factToken}. Use idempotency keys; cache embeddings; rate-limit calls; monitor latency.`,
    food: `Food idea: ${factToken}. Cook slow; taste as you go; balance salt/acid; keep pantry staples.`,
    history: `History fact: ${factToken}. Remember dates; link causes/effects; compare sources; avoid anachronisms.`,
    science: `Science lab: ${factToken}. Control variables; record measurements; repeat experiments; analyze residuals.`,
    sports: `Sports strategy: ${factToken}. Warm up properly; practice fundamentals; review game film; stay consistent.`,
    music: `Music goal: ${factToken}. Practice scales; keep rhythm; listen critically; record and improve.`,
    movies: `Movie review: ${factToken}. Note themes; analyze character arcs; watch director’s cuts; compare adaptations.`,
  };
  return flavor[topic];
}

function makeRecallQuery(topic: Topic, idx: number): string {
  const factToken = `${topic.toUpperCase()}_FACT_${idx}`;
  const variants = [
    `Find the memory about ${factToken}.`,
    `Which note mentions ${factToken} and the key idea?`,
    `Recall: ${factToken} — what was the plan?`,
    `Look up ${factToken} related details.`,
    `I need the ${factToken} memory for my summary.`,
  ];
  return variants[idx % variants.length];
}

function buildSyntheticDataset(seed = 20240515) {
  const rng = mulberry32(seed);

  // 500 memories inline across topics
  const totalMemories = 500;
  const memories: Array<{
    id: string;
    topic: Topic;
    content: string;
  }> = [];

  for (let i = 0; i < totalMemories; i++) {
    const topic = pick(rng, TOPICS);
    memories.push({
      id: randomUUID(),
      topic,
      content: makeMemoryContent(topic, i),
    });
  }

  // Build 50 recall queries that each target a specific memory.
  // Deterministic selection: take memory i where i maps to query bucket.
  const queries: Array<{ memoryId: string; topic: Topic; idxInDataset: number; query: string }> = [];
  for (let i = 0; i < 50; i++) {
    const targetIdx = i * 10; // 0..490 step 10 within 500
    const m = memories[targetIdx];
    // Align query to the same index so FTS + vector can match "TOPIC_FACT_targetIdx".
    const query = makeRecallQuery(m.topic, targetIdx);
    queries.push({ memoryId: m.id, topic: m.topic, idxInDataset: targetIdx, query });
  }

  return { memories, queries };
}

describe("LongMemEval (synthetic) - hybrid FTS5 + vector retrieval", () => {
  test(
    "hit-rate@5 should be high with hybrid retrieval",
    async () => {
      const tmpDir = os.tmpdir();
      const dbPath = path.join(
        tmpDir,
        `mnemopay-longmem-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
      );

      const storage = new SQLiteStorage(dbPath);
      const agentId = "longmem-agent";
      const createdAt = new Date().toISOString();

      const { memories, queries } = buildSyntheticDataset(20240515);

      // Save 500 memories via SQLiteStorage
      const state: PersistedState = {
        agentId,
        wallet: 0,
        reputation: 0.5,
        createdAt,
        memories: memories.map((m, idx) => ({
          id: m.id,
          agentId,
          content: m.content,
          importance: 0.2 + ((idx % 10) / 10) * 0.8,
          score: 0, // score is not used for recall ranking in our benchmark; engine uses m.score in hybrid base
          createdAt,
          lastAccessed: createdAt,
          accessCount: 0,
          tags: JSON.stringify([m.topic]),
        })),
        transactions: [],
        auditLog: [],
      };

      storage.save(state);

      const loaded = storage.load(agentId);
      if (!loaded) throw new Error("Failed to load persisted state");

      console.log(
        "[debug] first3 loaded memoryIds:",
        loaded.memories.slice(0, 3).map((m) => m.id)
      );
      console.log(
        "[debug] first3 query target memoryIds:",
        queries.slice(0, 3).map((q) => q.memoryId)
      );

      // Convert loaded memories to the shape expected by RecallEngine.search
      const allMemories = loaded.memories.map((m) => {
        const tags = typeof m.tags === "string" ? JSON.parse(m.tags || "[]") : [];
        return {
          id: m.id,
          content: m.content,
          importance: m.importance,
          score: m.importance, // proxy so normalizedScore isn't always 0
          createdAt: new Date(m.createdAt),
          lastAccessed: new Date(m.lastAccessed),
          accessCount: m.accessCount,
          tags,
        };
      });

      // RecallEngine with hybrid strategy + SQLite FTS5 candidate selection
      const recallEngine = new RecallEngine({
        strategy: "hybrid",
        embeddingProvider: "local",
        dimensions: 384,
        scoreWeight: 0.4,
        vectorWeight: 0.6,
        sqliteStorage: {
          searchMemoriesFTS: (p) => storage.searchMemoriesFTS(p),
        },
        sqliteAgentId: agentId,
        ftsCandidateLimit: 80,
        ftsWeight: 0.15,
      });

      const topK = 5;
      let hits = 0;

      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const results = await recallEngine.search(q.query, allMemories, topK);
        const ids = results.map((r) => r.id);
        if (ids.includes(q.memoryId)) hits++;

        if (i === 0) {
          console.log("[debug] first query expected:", q.memoryId);
          console.log(
            "[debug] first query top5:",
            results.slice(0, 5).map((r) => ({ id: r.id, combinedScore: r.combinedScore }))
          );
        }
      }

      const hitRate = hits / queries.length;
      // eslint-disable-next-line no-console
      console.log(`[longmem] hit@${topK} = ${hits}/${queries.length} = ${(hitRate * 100).toFixed(1)}%`);

      storage.close();

      // Synthetic benchmark target. With FTS+vector should be reliably high.
      expect(hitRate).toBeGreaterThanOrEqual(0.8);
    },
    { timeout: 120_000 }
  );
});
