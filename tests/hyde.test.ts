/**
 * Tests for the HyDE query-expansion generator.
 *
 * No real API calls — we stub global.fetch to assert the parser, the graceful
 * degradation path, and the provider routing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HyDEGenerator } from "../src/recall/hyde.js";

describe("HyDEGenerator — construction", () => {
  it("should construct with anthropic defaults", () => {
    const gen = new HyDEGenerator({ apiKey: "test-key" });
    expect(gen).toBeDefined();
  });

  it("should accept groq provider", () => {
    const gen = new HyDEGenerator({ provider: "groq", apiKey: "test-key" });
    expect(gen).toBeDefined();
  });

  it("should accept openai provider with custom model", () => {
    const gen = new HyDEGenerator({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      numHypotheses: 2,
    });
    expect(gen).toBeDefined();
  });
});

describe("HyDEGenerator — parser", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("parses numbered list from Anthropic response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({
        content: [
          {
            type: "text",
            text: "1. My favorite restaurant is Kura Sushi in Plano.\n2. I love the ramen at Marufuku.\n3. Mr. Max downtown has the best tonkatsu.",
          },
        ],
      }),
    }) as any;

    const gen = new HyDEGenerator({ apiKey: "test-key", numHypotheses: 3 });
    const result = await gen.generate("what is my favorite restaurant?");
    expect(result.hypotheses).toHaveLength(3);
    expect(result.hypotheses[0]).toContain("Kura Sushi");
    expect(result.hypotheses[2]).toContain("Mr. Max");
  });

  it("parses bullet-list output from OpenAI response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({
        choices: [
          {
            message: {
              content: "- I work at Acme as a senior engineer.\n- My job is backend engineering at Acme Corp.",
            },
          },
        ],
      }),
    }) as any;

    const gen = new HyDEGenerator({
      provider: "openai",
      apiKey: "test-key",
      numHypotheses: 2,
    });
    const result = await gen.generate("where does the user work?");
    expect(result.hypotheses).toHaveLength(2);
    expect(result.hypotheses[0]).toContain("Acme");
  });

  it("falls back to raw text when parser finds no list markers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({
        content: [
          { type: "text", text: "The user enjoys hiking on weekends in Colorado." },
        ],
      }),
    }) as any;

    const gen = new HyDEGenerator({ apiKey: "test-key", numHypotheses: 3 });
    const result = await gen.generate("what does the user do for fun?");
    expect(result.hypotheses.length).toBeGreaterThan(0);
    expect(result.hypotheses[0]).toContain("hiking");
  });

  it("degrades gracefully to the original query on fetch failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as any;

    const gen = new HyDEGenerator({ apiKey: "test-key" });
    const result = await gen.generate("what happened last week?");
    expect(result.hypotheses).toEqual(["what happened last week?"]);
  });

  it("degrades gracefully on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }) as any;

    const gen = new HyDEGenerator({ apiKey: "test-key" });
    const result = await gen.generate("where did I eat on Tuesday?");
    expect(result.hypotheses).toEqual(["where did I eat on Tuesday?"]);
  });

  it("reports durationMs on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ content: [{ type: "text", text: "1. Answer A" }] }),
    }) as any;

    const gen = new HyDEGenerator({ apiKey: "test-key" });
    const result = await gen.generate("q");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("HyDEGenerator — provider routing", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("calls the Groq endpoint when provider=groq", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ choices: [{ message: { content: "1. x" } }] }),
    });
    global.fetch = fetchSpy as any;

    const gen = new HyDEGenerator({ provider: "groq", apiKey: "groq-key" });
    await gen.generate("q");
    const url = fetchSpy.mock.calls[0][0];
    expect(String(url)).toContain("groq.com");
  });

  it("calls the Anthropic endpoint when provider=anthropic (default)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ content: [{ type: "text", text: "1. x" }] }),
    });
    global.fetch = fetchSpy as any;

    const gen = new HyDEGenerator({ apiKey: "a-key" });
    await gen.generate("q");
    const url = fetchSpy.mock.calls[0][0];
    expect(String(url)).toContain("anthropic.com");
  });
});
