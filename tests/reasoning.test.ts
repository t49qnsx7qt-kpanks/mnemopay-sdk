/**
 * Tests for the LLM Reasoning Post-Processor.
 *
 * Tests the parser (unit) and the full pipeline (integration, requires API key).
 */

import { describe, it, expect } from "vitest";
import { ReasoningPostProcessor } from "../src/reasoning/post-processor.js";
import type { RecallResult } from "../src/recall/engine.js";

// ─── Parser Tests (no API calls) ────────────────────────────────────────────

describe("ReasoningPostProcessor — parser", () => {
  // We test the parser indirectly through the public API by mocking fetch

  it("should construct with anthropic defaults", () => {
    const rp = new ReasoningPostProcessor({
      apiKey: "test-key",
    });
    expect(rp).toBeDefined();
  });

  it("should construct with openai provider", () => {
    const rp = new ReasoningPostProcessor({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });
    expect(rp).toBeDefined();
  });

  it("should return empty result for empty memories", async () => {
    const rp = new ReasoningPostProcessor({ apiKey: "test-key" });
    const result = await rp.reason("what happened?", []);
    expect(result.facts).toEqual([]);
    expect(result.rankedIds).toEqual([]);
    expect(result.durationMs).toBe(0);
  });
});

// ─── Mock-based Pipeline Tests ──────────────────────────────────────────────

describe("ReasoningPostProcessor — pipeline", () => {
  const mockMemories: RecallResult[] = [
    {
      id: "mem-1",
      content: "[Session abc — 2024-03-15]\nUser: I started a new job on March 1st.\nAssistant: Congratulations!",
      importance: 0.8,
      score: 0.7,
      vectorScore: 0.85,
      combinedScore: 0.82,
      createdAt: new Date("2024-03-15"),
      lastAccessed: new Date("2024-03-15"),
      accessCount: 1,
      tags: ["session:abc", "date:2024-03-15"],
    },
    {
      id: "mem-2",
      content: "[Session def — 2024-04-14]\nUser: It's been a while since I started my job.\nAssistant: How's it going?",
      importance: 0.6,
      score: 0.5,
      vectorScore: 0.72,
      combinedScore: 0.65,
      createdAt: new Date("2024-04-14"),
      lastAccessed: new Date("2024-04-14"),
      accessCount: 1,
      tags: ["session:def", "date:2024-04-14"],
    },
  ];

  it("should handle API errors gracefully", async () => {
    // Mock fetch to return an error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_api_key" }), {
        status: 401,
        statusText: "Unauthorized",
      });

    const rp = new ReasoningPostProcessor({ apiKey: "bad-key" });

    await expect(rp.reason("how many days?", mockMemories)).rejects.toThrow(
      /Anthropic API error 401/
    );

    globalThis.fetch = originalFetch;
  });

  it("should parse structured LLM output correctly", async () => {
    const mockResponse = {
      content: [
        {
          type: "text",
          text: `REASONING:
Session abc on 2024-03-15 mentions the user started a new job on March 1st, 2024.
Session def on 2024-04-14 mentions it's been a while.
Days between March 1 and April 14 = 31 (March) - 1 + 14 = 44 days.

FACTS:
- User started a new job on 2024-03-01
- As of 2024-04-14, user has been at the job for 44 days
- User indicated positive sentiment about the job

RANKED: 1,2`,
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 });

    const rp = new ReasoningPostProcessor({
      apiKey: "test-key",
      includeChainOfThought: true,
    });
    const result = await rp.reason("How many days has the user been at their job?", mockMemories);

    expect(result.facts).toHaveLength(3);
    expect(result.facts[0]).toContain("2024-03-01");
    expect(result.facts[1]).toContain("44 days");
    expect(result.rankedIds).toEqual(["mem-1", "mem-2"]);
    expect(result.reasoning).toContain("44 days");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    globalThis.fetch = originalFetch;
  });

  it("distill() should produce a formatted context string", async () => {
    const mockResponse = {
      content: [
        {
          type: "text",
          text: `REASONING:
The user mentioned starting March 1st.

FACTS:
- Job started 2024-03-01
- 44 days elapsed

RANKED: 1,2`,
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 });

    const rp = new ReasoningPostProcessor({
      apiKey: "test-key",
      includeChainOfThought: true,
    });
    const { distilledContext, result } = await rp.distill(
      "How long at the job?",
      mockMemories
    );

    expect(distilledContext).toContain("Reasoning:");
    expect(distilledContext).toContain("Extracted facts:");
    expect(distilledContext).toContain("Source memories");
    expect(distilledContext).toContain("Job started 2024-03-01");
    expect(result.facts).toHaveLength(2);

    globalThis.fetch = originalFetch;
  });

  it("should handle malformed LLM output without crashing", async () => {
    const mockResponse = {
      content: [
        {
          type: "text",
          text: "This is just random text without any structure",
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 });

    const rp = new ReasoningPostProcessor({ apiKey: "test-key" });
    const result = await rp.reason("test?", mockMemories);

    // Should still return valid structure even with garbage output
    expect(result.facts).toBeDefined();
    expect(result.rankedIds).toBeDefined();
    // All memory IDs should still be present (appended as unranked)
    expect(result.rankedIds).toContain("mem-1");
    expect(result.rankedIds).toContain("mem-2");

    globalThis.fetch = originalFetch;
  });
});
