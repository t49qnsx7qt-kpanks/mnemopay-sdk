/**
 * Recall Engine Edge Cases — Test Suite
 *
 * Specifically targets:
 * 1. Concurrent forget + search race conditions
 * 2. Dimension mismatches during provider "switches"
 * 3. OpenAI failure handling (via mocks)
 * 4. Cache consistency
 */

import { describe, it, expect, vi } from "vitest";
import { RecallEngine, cosineSimilarity } from "../src/recall/engine.js";

describe("RecallEngine Edge Cases", () => {
  
  it("should handle forget during search race condition", async () => {
    const engine = new RecallEngine({ strategy: "vector" });
    const memories = [
      { id: "race-1", content: "Memory to be forgotten", importance: 0.5, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [] }
    ];

    // Mock getOrEmbed to simulate a delay, then delete the vector mid-search
    const originalGetOrEmbed = engine.getOrEmbed.bind(engine);
    vi.spyOn(engine, "getOrEmbed").mockImplementation(async (id, content) => {
      const result = await originalGetOrEmbed(id, content);
      // Simulate deletion happening EXACTLY after embedding is generated but before scoring
      engine.remove(id); 
      return result;
    });

    const results = await engine.search("memory", memories, 1);
    
    // Should not throw, and should handle missing vector gracefully (vectorScore 0)
    expect(results).toHaveLength(1);
    expect(results[0].vectorScore).toBe(0);
  });

  it("should throw informative error on dimension mismatch", () => {
    const vec384 = new Float32Array(384).fill(1.0);
    const vec1536 = new Float32Array(1536).fill(1.0);
    
    expect(() => cosineSimilarity(vec384, vec1536)).toThrow("Dimension mismatch: 384 vs 1536");
  });

  it("should handle empty memory list in search", async () => {
    const engine = new RecallEngine({ strategy: "vector" });
    const results = await engine.search("anything", [], 5);
    expect(results).toHaveLength(0);
  });

  it("should handle extremely long queries for local provider", async () => {
    const engine = new RecallEngine({ strategy: "vector" });
    const longQuery = "word ".repeat(5000);
    const memories = [{ id: "1", content: "word", importance: 0.5, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [] }];
    
    const results = await engine.search(longQuery, memories, 1);
    expect(results).toHaveLength(1);
  });

  it("should validate that hybrid weights MUST sum to 1.0", () => {
    expect(() => new RecallEngine({ 
      strategy: "hybrid", 
      scoreWeight: 0.8, 
      vectorWeight: 0.8 
    })).toThrow("sum to ~1.0");
  });

  it("should handle OpenAI API errors by falling back to localEmbed", async () => {
    // Force OpenAI provider without real key
    const engine = new RecallEngine({ 
      strategy: "vector", 
      embeddingProvider: "openai", 
      openaiApiKey: "fake-key",
      dimensions: 1536 // Local embed will now produce 1536 dims
    });
    
    // Mock fetch to simulate failure
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized")
    });

    const memories = [{ id: "1", content: "A memory about software deployment and testing", importance: 0.5, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [] }];
    
    // Should NOT throw anymore, but return a result using local fallback
    const results = await engine.search("how to deploy software", memories, 1);
    expect(results).toHaveLength(1);
    expect(results[0].combinedScore).toBeGreaterThan(0);
  });

  it("MnemoPayLite.purgeStaleVectors should sync cache with memories Map", async () => {
    const { MnemoPay } = await import("../src/index.js");
    const agent = MnemoPay.quick("purge-test", { recall: "vector" });
    
    // Create a memory (populates vector cache)
    const id = await agent.remember("Vector memory content");
    expect(agent.recallEngine.stats().cachedEmbeddings).toBe(1);
    
    // Manually delete memory from Map (simulating cache drift or direct manipulation)
    (agent as any).memories.delete(id);
    expect(agent.recallEngine.stats().cachedEmbeddings).toBe(1); // Still in vector cache
    
    // Purge
    const count = await agent.purgeStaleVectors();
    expect(count).toBe(1);
    expect(agent.recallEngine.stats().cachedEmbeddings).toBe(0); // Now purged
  });
});

