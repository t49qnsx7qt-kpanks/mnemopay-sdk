/**
 * Tests for the Cross-Encoder Reranker.
 *
 * We don't actually download the 450MB model in CI — we test construction,
 * empty-input handling, and the graceful-degradation path that preserves
 * input order when the pipeline fails to load.
 */

import { describe, it, expect, vi } from "vitest";
import { CrossEncoderReranker } from "../src/recall/rerank.js";

describe("CrossEncoderReranker — construction", () => {
  it("constructs with defaults", () => {
    const rr = new CrossEncoderReranker();
    expect(rr).toBeDefined();
  });

  it("accepts custom model and caps", () => {
    const rr = new CrossEncoderReranker({
      model: "Xenova/bge-reranker-large",
      maxCandidates: 25,
      maxContentChars: 1000,
    });
    expect(rr).toBeDefined();
  });
});

describe("CrossEncoderReranker — empty input", () => {
  it("returns empty array for no candidates", async () => {
    const rr = new CrossEncoderReranker();
    const out = await rr.rerank("query", []);
    expect(out).toEqual([]);
  });
});

describe("CrossEncoderReranker — graceful degradation", () => {
  it("preserves input order and priorScore when pipeline load fails", async () => {
    // Force @xenova/transformers import to throw so getPipeline() falls through
    // to the catch branch in rerank().
    vi.doMock("@xenova/transformers", () => {
      throw new Error("transformers unavailable");
    });

    // Re-import the module so the mock takes effect for this test's instance.
    const { CrossEncoderReranker: Fresh } = await import("../src/recall/rerank.js?t=" + Date.now());
    const rr = new Fresh();

    const candidates = [
      { id: "a", content: "first chunk", priorScore: 0.3 },
      { id: "b", content: "second chunk", priorScore: 0.9 },
      { id: "c", content: "third chunk", priorScore: 0.5 },
    ];

    const out = await rr.rerank("query", candidates);
    // On load failure we return capped candidates in their original order, with
    // rerankScore = priorScore. We do NOT re-sort, because we have no real
    // signal — preserving prior order is the safe fallback.
    expect(out).toHaveLength(3);
    expect(out[0].item.id).toBe("a");
    expect(out[0].rerankScore).toBe(0.3);
    expect(out[1].item.id).toBe("b");
    expect(out[2].item.id).toBe("c");

    vi.doUnmock("@xenova/transformers");
  });

  it("caps candidates at maxCandidates", async () => {
    vi.doMock("@xenova/transformers", () => {
      throw new Error("unavailable");
    });
    const { CrossEncoderReranker: Fresh } = await import(
      "../src/recall/rerank.js?t=" + (Date.now() + 1)
    );
    const rr = new Fresh({ maxCandidates: 3 });
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      content: `chunk ${i}`,
      priorScore: i / 10,
    }));
    const out = await rr.rerank("q", candidates);
    expect(out.length).toBeLessThanOrEqual(3);
    vi.doUnmock("@xenova/transformers");
  });

  it("respects topK when specified", async () => {
    vi.doMock("@xenova/transformers", () => {
      throw new Error("unavailable");
    });
    const { CrossEncoderReranker: Fresh } = await import(
      "../src/recall/rerank.js?t=" + (Date.now() + 2)
    );
    const rr = new Fresh();
    const candidates = [
      { id: "a", content: "x", priorScore: 0.1 },
      { id: "b", content: "y", priorScore: 0.2 },
      { id: "c", content: "z", priorScore: 0.3 },
    ];
    const out = await rr.rerank("q", candidates, 2);
    expect(out).toHaveLength(2);
    vi.doUnmock("@xenova/transformers");
  });
});
