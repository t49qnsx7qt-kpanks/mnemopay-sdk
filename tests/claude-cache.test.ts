/**
 * Tests for 1-hour Claude prompt cache integration.
 *
 * Verifies:
 *   1. formatForClaudeCache() output shape has cache_control.type === "ephemeral"
 *      and cache_control.ttl === 3600 (1 hour).
 *   2. Two recalls with the same memories produce byte-identical text (stable prefix).
 *   3. Static MnemoPayLite.formatForClaudeCache() method works identically.
 *   4. The recall() overload with { formatForClaudeCache: true } returns a ClaudeCacheBlock.
 *   5. Custom TTL and prefix options are respected.
 *   6. Empty memory array produces a valid (empty) block.
 *   7. Sorting is stable regardless of input order.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { formatForClaudeCache, serializeMemoriesForCache } from "../src/claude-cache.js";
import { MnemoPay } from "../src/index.js";
import type { Memory } from "../src/index.js";
import type { ClaudeCacheBlock } from "../src/index.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMemory(id: string, content: string, importance = 0.7): Memory {
  return {
    id,
    agentId: "test-agent",
    content,
    importance,
    score: 0.6,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastAccessed: new Date("2026-01-02T00:00:00Z"),
    accessCount: 3,
    tags: ["test"],
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("formatForClaudeCache()", () => {
  it("returns a block with type=text", () => {
    const memories = [makeMemory("mem-1", "User prefers monthly billing")];
    const block = formatForClaudeCache(memories);
    expect(block.type).toBe("text");
  });

  it("cache_control.type is ephemeral", () => {
    const block = formatForClaudeCache([makeMemory("m1", "hello")]);
    expect(block.cache_control.type).toBe("ephemeral");
  });

  it("cache_control.ttl is 3600 (1 hour) by default", () => {
    const block = formatForClaudeCache([makeMemory("m1", "hello")]);
    expect(block.cache_control.ttl).toBe(3600);
  });

  it("custom ttlSeconds is respected", () => {
    const block = formatForClaudeCache([makeMemory("m1", "hello")], { ttlSeconds: 300 });
    expect(block.cache_control.ttl).toBe(300);
  });

  it("text starts with the default [Memory Cache] prefix", () => {
    const block = formatForClaudeCache([makeMemory("m1", "foo")]);
    expect(block.text).toMatch(/^\[Memory Cache\]/);
  });

  it("custom prefix is used when provided", () => {
    const block = formatForClaudeCache([makeMemory("m1", "foo")], { prefix: "[Context]" });
    expect(block.text).toMatch(/^\[Context\]/);
  });

  it("includes memory id and content in text", () => {
    const block = formatForClaudeCache([makeMemory("mem-abc", "User prefers dark mode")]);
    expect(block.text).toContain("mem-abc");
    expect(block.text).toContain("User prefers dark mode");
  });

  it("does not include score by default (score would break cache stability)", () => {
    const m = makeMemory("m1", "foo");
    m.score = 0.12345678;
    const block = formatForClaudeCache([m]);
    expect(block.text).not.toContain("0.12345678");
  });

  it("includes score when includeScore=true", () => {
    const m = makeMemory("m1", "foo");
    m.score = 0.9;
    const block = formatForClaudeCache([m], { includeScore: true });
    expect(block.text).toContain("score=");
  });
});

describe("Cache prefix stability", () => {
  it("two calls with the same memories produce byte-identical text", () => {
    const memories = [
      makeMemory("mem-b", "Second memory content"),
      makeMemory("mem-a", "First memory content"),
      makeMemory("mem-c", "Third memory content"),
    ];

    const block1 = formatForClaudeCache(memories);
    const block2 = formatForClaudeCache(memories);

    expect(block1.text).toBe(block2.text);
  });

  it("input order does not affect output (sorted by id)", () => {
    const memoriesABC = [
      makeMemory("mem-a", "A content"),
      makeMemory("mem-b", "B content"),
      makeMemory("mem-c", "C content"),
    ];
    const memoriesCBA = [
      makeMemory("mem-c", "C content"),
      makeMemory("mem-b", "B content"),
      makeMemory("mem-a", "A content"),
    ];

    const block1 = formatForClaudeCache(memoriesABC);
    const block2 = formatForClaudeCache(memoriesCBA);

    expect(block1.text).toBe(block2.text);
  });

  it("different importance values produce different text (no false cache hits)", () => {
    const m1 = makeMemory("mem-x", "Same content", 0.5);
    const m2 = makeMemory("mem-x", "Same content", 0.9);

    const block1 = formatForClaudeCache([m1]);
    const block2 = formatForClaudeCache([m2]);

    expect(block1.text).not.toBe(block2.text);
  });
});

describe("Empty memories", () => {
  it("handles empty array gracefully", () => {
    const block = formatForClaudeCache([]);
    expect(block.type).toBe("text");
    expect(block.cache_control.ttl).toBe(3600);
    // Should just have the prefix line with no memory lines
    const lines = block.text.split("\n").filter(Boolean);
    expect(lines.length).toBe(1); // just the prefix
  });
});

describe("MnemoPayLite.formatForClaudeCache (static method)", () => {
  it("is callable as a static method and returns the same shape", () => {
    const memories = [makeMemory("static-1", "static content")];
    const block = MnemoPay.formatForClaudeCache(memories);
    expect(block.type).toBe("text");
    expect(block.cache_control.type).toBe("ephemeral");
    expect(block.cache_control.ttl).toBe(3600);
    expect(block.text).toContain("static-1");
  });

  it("static result is byte-identical to module-level formatForClaudeCache()", () => {
    const memories = [makeMemory("m1", "consistency check")];
    const fromStatic = MnemoPay.formatForClaudeCache(memories);
    const fromModule = formatForClaudeCache(memories);
    expect(fromStatic.text).toBe(fromModule.text);
  });
});

describe("recall() with formatForClaudeCache option (MnemoPayLite integration)", () => {
  it("returns a ClaudeCacheBlock when formatForClaudeCache=true", async () => {
    const agent = MnemoPay.quick("cache-test-agent");
    await agent.remember("User prefers dark mode", { importance: 0.8 });
    await agent.remember("Last order was $45 for API access", { importance: 0.7 });

    // Call with the new overload
    const block = await (agent as any).recall("preferences", 5, { formatForClaudeCache: true }) as ClaudeCacheBlock;

    expect(block.type).toBe("text");
    expect(block.cache_control.type).toBe("ephemeral");
    expect(block.cache_control.ttl).toBe(3600);
    expect(typeof block.text).toBe("string");
    expect(block.text).toContain("[Memory Cache]");
  });

  it("two identical recalls produce byte-identical text (cache would hit)", async () => {
    const agent = MnemoPay.quick("cache-stability-agent");
    await agent.remember("Preference: dark mode", { importance: 0.9 });
    await agent.remember("Preference: monthly billing", { importance: 0.8 });

    const block1 = await (agent as any).recall("preferences", 10, { formatForClaudeCache: true }) as ClaudeCacheBlock;
    const block2 = await (agent as any).recall("preferences", 10, { formatForClaudeCache: true }) as ClaudeCacheBlock;

    // Text must be byte-identical for the cache to hit
    expect(block1.text).toBe(block2.text);
  });
});

describe("serializeMemoriesForCache() — low-level", () => {
  it("produces one line per memory plus the prefix", () => {
    const memories = [
      makeMemory("m1", "first"),
      makeMemory("m2", "second"),
    ];
    const text = serializeMemoriesForCache(memories);
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(3); // prefix + 2 memories
  });

  it("sorts by id lexicographically", () => {
    const memories = [
      makeMemory("z-last", "last"),
      makeMemory("a-first", "first"),
    ];
    const text = serializeMemoriesForCache(memories);
    const lines = text.split("\n").filter(Boolean);
    expect(lines[1]).toContain("a-first");
    expect(lines[2]).toContain("z-last");
  });
});
