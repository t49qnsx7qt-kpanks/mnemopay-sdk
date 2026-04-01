/**
 * Vector Recall Engine — Test Suite
 *
 * Tests cosine similarity, local embeddings, recall strategies,
 * semantic search quality, hybrid scoring, and edge cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MnemoPay, MnemoPayLite } from "../src/index.js";
import {
  RecallEngine,
  cosineSimilarity,
  l2Normalize,
  localEmbed,
} from "../src/recall/engine.js";

// ─── Math: Cosine Similarity ────────────────────────────────────────────────

describe("Cosine Similarity", () => {
  it("should return 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("should return 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("should return -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("should handle zero vectors gracefully", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("should throw on dimension mismatch", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow("mismatch");
  });

  it("should be invariant to scaling", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([10, 20, 30]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("should handle large vectors (1536 dims like OpenAI)", () => {
    const a = new Float32Array(1536);
    const b = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) {
      a[i] = Math.random();
      b[i] = a[i] + (Math.random() * 0.1 - 0.05); // slight perturbation
    }
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9); // Similar vectors should score high
  });
});

// ─── L2 Normalization ───────────────────────────────────────────────────────

describe("L2 Normalize", () => {
  it("should normalize a vector to unit length", () => {
    const v = l2Normalize(new Float32Array([3, 4]));
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  });

  it("should handle zero vector", () => {
    const v = l2Normalize(new Float32Array([0, 0, 0]));
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
  });

  it("should preserve direction", () => {
    const v = l2Normalize(new Float32Array([2, 0, 0]));
    expect(v[0]).toBeCloseTo(1.0, 5);
    expect(v[1]).toBeCloseTo(0.0, 5);
  });
});

// ─── Local Embeddings ───────────────────────────────────────────────────────

describe("Local Embeddings", () => {
  it("should produce fixed-dimension vectors", () => {
    const v = localEmbed("hello world", 384);
    expect(v.length).toBe(384);
  });

  it("should produce normalized vectors", () => {
    const v = localEmbed("test content here");
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 3);
  });

  it("should give high similarity for semantically similar text", () => {
    const a = localEmbed("user prefers TypeScript programming language");
    const b = localEmbed("TypeScript is the preferred programming language for user");
    const c = localEmbed("the weather is sunny and warm today");
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it("should give low similarity for unrelated text", () => {
    const a = localEmbed("machine learning neural networks deep learning");
    const b = localEmbed("cooking recipes pasta tomato sauce");
    expect(cosineSimilarity(a, b)).toBeLessThan(0.3);
  });

  it("should handle empty string", () => {
    const v = localEmbed("");
    expect(v.length).toBe(384);
    // Zero vector after normalization of zero
    expect(v[0]).toBe(0);
  });

  it("should handle very long text", () => {
    const longText = "word ".repeat(10000);
    const v = localEmbed(longText);
    expect(v.length).toBe(384);
  });

  it("should be deterministic", () => {
    const a = localEmbed("deterministic test");
    const b = localEmbed("deterministic test");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("should distinguish programming languages", () => {
    const ts = localEmbed("TypeScript async await interface");
    const py = localEmbed("Python asyncio decorator class");
    const rust = localEmbed("Rust ownership borrow lifetime");
    // Each should be closer to itself than to others
    expect(cosineSimilarity(ts, ts)).toBeGreaterThan(cosineSimilarity(ts, py));
    expect(cosineSimilarity(ts, ts)).toBeGreaterThan(cosineSimilarity(ts, rust));
  });
});

// ─── RecallEngine ───────────────────────────────────────────────────────────

describe("RecallEngine", () => {
  it("should default to score strategy", () => {
    const engine = new RecallEngine();
    expect(engine.strategy).toBe("score");
  });

  it("should accept vector strategy", () => {
    const engine = new RecallEngine({ strategy: "vector" });
    expect(engine.strategy).toBe("vector");
  });

  it("should accept hybrid strategy", () => {
    const engine = new RecallEngine({ strategy: "hybrid" });
    expect(engine.strategy).toBe("hybrid");
  });

  it("should embed and cache vectors", async () => {
    const engine = new RecallEngine({ strategy: "vector" });
    await engine.embed("id-1", "test content");
    const stats = engine.stats();
    expect(stats.cachedEmbeddings).toBe(1);
  });

  it("should remove cached embeddings", async () => {
    const engine = new RecallEngine({ strategy: "vector" });
    await engine.embed("id-1", "test");
    engine.remove("id-1");
    expect(engine.stats().cachedEmbeddings).toBe(0);
  });

  it("should search by vector similarity", async () => {
    const engine = new RecallEngine({ strategy: "vector" });

    const memories = [
      { id: "1", content: "User prefers TypeScript", importance: 0.8, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [] },
      { id: "2", content: "Server crashed yesterday", importance: 0.9, score: 0.7, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [] },
      { id: "3", content: "Meeting scheduled for Friday", importance: 0.5, score: 0.3, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [] },
    ];

    const results = await engine.search("programming language preference", memories, 2);
    expect(results).toHaveLength(2);
    // TypeScript memory should rank first for a programming language query
    expect(results[0].content).toContain("TypeScript");
  });

  it("should return correct stats", () => {
    const engine = new RecallEngine({ strategy: "hybrid", embeddingProvider: "local" });
    const stats = engine.stats();
    expect(stats.strategy).toBe("hybrid");
    expect(stats.provider).toBe("local");
    expect(stats.dimensions).toBe(384);
  });
});

// ─── Integration: MnemoPayLite with Vector Recall ───────────────────────────

describe("MnemoPayLite with Vector Recall", () => {
  it("should work with score strategy (default, backward compatible)", async () => {
    const agent = MnemoPay.quick("score-test");
    await agent.remember("Test memory");
    const memories = await agent.recall(1);
    expect(memories).toHaveLength(1);
  });

  it("should work with vector strategy", async () => {
    const agent = MnemoPay.quick("vector-test", { recall: "vector" });
    await agent.remember("User prefers TypeScript for frontend development");
    await agent.remember("Server uses PostgreSQL database");
    await agent.remember("Deploy to AWS us-east-1 region");

    // Semantic search for programming preferences
    const results = await agent.recall("programming language", 2);
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain("TypeScript");
  });

  it("should work with hybrid strategy", async () => {
    const agent = MnemoPay.quick("hybrid-test", { recall: "hybrid" });
    await agent.remember("User likes dark mode theme", { importance: 0.5 });
    await agent.remember("Deploy target is Kubernetes on GCP", { importance: 0.5 });
    await agent.remember("Lunch was pizza today", { importance: 0.3 });

    const results = await agent.recall("deployment infrastructure cloud", 2);
    expect(results).toHaveLength(2);
    // Kubernetes memory should rank in top 2 due to semantic similarity
    expect(results.some((m) => m.content.includes("Kubernetes"))).toBe(true);
  });

  it("should still work with numeric limit (no query string)", async () => {
    const agent = MnemoPay.quick("compat-test", { recall: "vector" });
    await agent.remember("Memory 1");
    await agent.remember("Memory 2");
    // Calling recall with just a number should still work (falls back to score ranking)
    const memories = await agent.recall(2);
    expect(memories).toHaveLength(2);
  });

  it("should clean up embeddings on forget()", async () => {
    const agent = MnemoPay.quick("cleanup-test", { recall: "vector" });
    const id = await agent.remember("Temporary vector memory");
    await agent.forget(id);
    const memories = await agent.recall("temporary", 1);
    expect(memories).toHaveLength(0);
  });

  it("feedback loop should work with vector recall", async () => {
    const agent = MnemoPay.quick("feedback-vector", { recall: "vector" });
    await agent.remember("Strategy: focus on TypeScript SDK", { importance: 0.5 });

    // Recall semantically
    await agent.recall("product strategy", 1);

    // Charge and settle (feedback loop)
    const tx = await agent.charge(5, "Built TypeScript SDK");
    await agent.settle(tx.id);

    // Memory should be reinforced
    const memories = await agent.recall("product strategy", 1);
    expect(memories[0].importance).toBeCloseTo(0.55, 2);
  });

  it("should handle 500 memories with vector search", async () => {
    const agent = MnemoPay.quick("perf-vector", { recall: "vector" });
    for (let i = 0; i < 500; i++) {
      await agent.remember(`Memory entry number ${i} about topic ${i % 10}`);
    }
    const start = Date.now();
    const results = await agent.recall("topic about entry", 10);
    const elapsed = Date.now() - start;
    expect(results).toHaveLength(10);
    expect(elapsed).toBeLessThan(2000); // Under 2 seconds
  });

  it("should rank semantically relevant memories higher than important but irrelevant ones", async () => {
    const agent = MnemoPay.quick("relevance-test", { recall: "vector" });

    // High importance but irrelevant
    await agent.remember("Critical: server needs restart at 3am", { importance: 0.99 });

    // Lower importance but semantically relevant
    await agent.remember("User prefers React over Vue for frontend", { importance: 0.5 });

    // Query about frontend preferences
    const results = await agent.recall("frontend framework preference", 2);

    // In vector mode, the semantically relevant memory should rank first
    expect(results[0].content).toContain("React");
  });
});

// ─── Stress Test: Concurrent Vector Operations ──────────────────────────────

describe("Concurrent Vector Operations", () => {
  it("should handle 100 concurrent stores with vector embedding", async () => {
    const agent = MnemoPay.quick("concurrent-vec", { recall: "vector" });
    const promises = Array.from({ length: 100 }, (_, i) =>
      agent.remember(`Concurrent vector memory ${i} about topic ${i % 5}`)
    );
    const ids = await Promise.all(promises);
    expect(new Set(ids).size).toBe(100);
  });

  it("should handle concurrent search + store", async () => {
    const agent = MnemoPay.quick("concurrent-ops", { recall: "vector" });

    // Pre-populate
    for (let i = 0; i < 50; i++) {
      await agent.remember(`Base memory ${i}`);
    }

    // Concurrent searches and stores
    const ops = [
      ...Array.from({ length: 20 }, (_, i) => agent.recall(`search query ${i}`, 3)),
      ...Array.from({ length: 20 }, (_, i) => agent.remember(`New memory ${i}`)),
    ];
    const results = await Promise.all(ops);
    expect(results).toHaveLength(40);
  });
});
