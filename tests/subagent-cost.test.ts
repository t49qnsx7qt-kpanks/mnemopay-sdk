/**
 * Tests for per-subagent cost attribution via the MnemoPay ledger.
 *
 * Pipeline under test:
 *   - 1 Opus 4.7 lead agent  (orchestrates, does reasoning)
 *   - 2 Sonnet 4.6 workers   (research, analysis)
 *   - 1 Haiku 4.5 formatter  (output formatting)
 *
 * Verifies:
 *   1. Cost math matches 2026 Anthropic list pricing.
 *   2. Cache savings are computed correctly (0.9× saving vs full input rate).
 *   3. subagentCostBreakdown() returns entries sorted by totalCostUsd desc.
 *   4. subagentCostBreakdown() filters correctly by time range.
 *   5. Double-entry ledger stays balanced after attributions.
 *   6. totalCost() and totalCacheSavings() are sums of all records.
 *   7. Unknown model throws a clear error.
 *   8. Integration via MnemoPayLite.subagentCosts works end-to-end.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SubagentCostTracker, computeSubagentCost, MODEL_PRICING } from "../src/subagent-cost.js";
import { Ledger } from "../src/ledger.js";
import { MnemoPay } from "../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Round to 6 decimal places for float comparison */
function r6(n: number) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Compute expected cost manually for verification */
function expectedCost(params: {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTtl?: "5m" | "1h";
}) {
  const p = MODEL_PRICING[params.modelId];
  const M = 1_000_000;
  const cacheRead = params.cacheReadTokens ?? 0;
  const cacheWrite = params.cacheWriteTokens ?? 0;
  const ttl = params.cacheWriteTtl ?? "5m";

  const inputCost = (params.inputTokens / M) * p.inputPerMillion;
  const outputCost = (params.outputTokens / M) * p.outputPerMillion;
  const cacheReadCost = (cacheRead / M) * p.inputPerMillion * p.cacheReadMultiplier;
  const writeMultiplier = ttl === "1h" ? p.cacheWrite1hMultiplier : p.cacheWrite5mMultiplier;
  const cacheWriteCost = (cacheWrite / M) * p.inputPerMillion * writeMultiplier;

  const fullReadCost = (cacheRead / M) * p.inputPerMillion;
  const cacheSavings = Math.max(0, fullReadCost - cacheReadCost);

  return {
    totalCostUsd: r6(inputCost + outputCost + cacheReadCost + cacheWriteCost),
    cacheSavingsUsd: r6(cacheSavings),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("computeSubagentCost() — pricing math", () => {
  it("Opus 4.7: 1M input + 1M output = $5.00 + $25.00 = $30.00", () => {
    const { totalCostUsd } = computeSubagentCost({
      modelId: "claude-opus-4-7",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(r6(totalCostUsd)).toBe(30.0);
  });

  it("Sonnet 4.6: 1M input + 1M output = $3.00 + $15.00 = $18.00", () => {
    const { totalCostUsd } = computeSubagentCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(r6(totalCostUsd)).toBe(18.0);
  });

  it("Haiku 4.5: 1M input + 1M output = $1.00 + $5.00 = $6.00", () => {
    const { totalCostUsd } = computeSubagentCost({
      modelId: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(r6(totalCostUsd)).toBe(6.0);
  });

  it("cache read tokens billed at 0.1× input rate", () => {
    // Sonnet 4.6: $3/M input. 1M cache reads = 0.1 × $3 = $0.30
    const { totalCostUsd } = computeSubagentCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(r6(totalCostUsd)).toBeCloseTo(0.30, 5);
  });

  it("cache savings = 0.9× the full input cost of cache-read tokens", () => {
    // Sonnet: $3/M. 1M read → full cost $3.00, actual $0.30, savings $2.70
    const { cacheSavingsUsd } = computeSubagentCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(r6(cacheSavingsUsd)).toBeCloseTo(2.70, 5);
  });

  it("1h cache write = 2× input rate (vs 1.25× for 5-min)", () => {
    // Sonnet: $3/M. 1M write at 1h → $6.00; at 5m → $3.75
    const { totalCostUsd: cost1h } = computeSubagentCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWriteTtl: "1h",
    });
    const { totalCostUsd: cost5m } = computeSubagentCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWriteTtl: "5m",
    });
    expect(r6(cost1h)).toBeCloseTo(6.0, 5);
    expect(r6(cost5m)).toBeCloseTo(3.75, 5);
  });

  it("throws on unknown model", () => {
    expect(() => computeSubagentCost({
      modelId: "gpt-4o", // not in table
      inputTokens: 1000,
      outputTokens: 500,
    })).toThrow(/Unknown modelId/);
  });

  it("throws on negative inputTokens", () => {
    expect(() => computeSubagentCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: -1,
      outputTokens: 100,
    })).toThrow(/inputTokens/);
  });
});

describe("SubagentCostTracker — attribution and breakdown", () => {
  let ledger: Ledger;
  let tracker: SubagentCostTracker;

  const PARENT = "opus-orchestrator";
  const WORKER_A = "sonnet-researcher-1";
  const WORKER_B = "sonnet-researcher-2";
  const FORMATTER = "haiku-formatter";

  beforeEach(() => {
    ledger = new Ledger();
    tracker = new SubagentCostTracker(ledger);

    // Opus lead: heavy reasoning call
    tracker.attributeSubagentCost({
      parentAgentId: PARENT,
      subagentId: PARENT,
      subagentRole: "lead-orchestrator",
      modelId: "claude-opus-4-7",
      inputTokens: 3000,
      outputTokens: 1500,
      cacheReadTokens: 8500,  // MnemoPay recall block — 1h cached
      cacheWriteTokens: 500,
      cacheWriteTtl: "1h",
      timestamp: "2026-04-21T10:00:00.000Z",
    });

    // Sonnet researcher 1
    tracker.attributeSubagentCost({
      parentAgentId: PARENT,
      subagentId: WORKER_A,
      subagentRole: "researcher",
      modelId: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 8500,
      cacheWriteTtl: "1h",
      timestamp: "2026-04-21T10:01:00.000Z",
    });

    // Sonnet researcher 2
    tracker.attributeSubagentCost({
      parentAgentId: PARENT,
      subagentId: WORKER_B,
      subagentRole: "researcher",
      modelId: "claude-sonnet-4-6",
      inputTokens: 4000,
      outputTokens: 1800,
      cacheReadTokens: 8500,
      cacheWriteTtl: "1h",
      timestamp: "2026-04-21T10:02:00.000Z",
    });

    // Haiku formatter
    tracker.attributeSubagentCost({
      parentAgentId: PARENT,
      subagentId: FORMATTER,
      subagentRole: "formatter",
      modelId: "claude-haiku-4-5",
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 8500,
      cacheWriteTtl: "1h",
      timestamp: "2026-04-21T10:03:00.000Z",
    });
  });

  it("breakdown has one entry per distinct subagent", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    expect(breakdown).toHaveLength(4);
  });

  it("breakdown is sorted by totalCostUsd descending", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    for (let i = 1; i < breakdown.length; i++) {
      expect(breakdown[i - 1].totalCostUsd).toBeGreaterThanOrEqual(breakdown[i].totalCostUsd);
    }
  });

  it("Opus lead has the highest cost", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    expect(breakdown[0].subagentId).toBe(PARENT);
  });

  it("Haiku formatter has the lowest cost", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    expect(breakdown[breakdown.length - 1].subagentId).toBe(FORMATTER);
  });

  it("cost values match manual pricing computation", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const opusEntry = breakdown.find(e => e.subagentId === PARENT)!;

    const expected = expectedCost({
      modelId: "claude-opus-4-7",
      inputTokens: 3000,
      outputTokens: 1500,
      cacheReadTokens: 8500,
      cacheWriteTokens: 500,
      cacheWriteTtl: "1h",
    });
    expect(r6(opusEntry.totalCostUsd)).toBeCloseTo(expected.totalCostUsd, 5);
  });

  it("cacheSavingsUsd is positive and equals 0.9× cacheReadTokens × inputRate", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const sonnetEntry = breakdown.find(e => e.subagentId === WORKER_A)!;

    const expected = expectedCost({
      modelId: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 8500,
      cacheWriteTtl: "1h",
    });
    expect(r6(sonnetEntry.cacheSavingsUsd)).toBeCloseTo(expected.cacheSavingsUsd, 5);
    expect(sonnetEntry.cacheSavingsUsd).toBeGreaterThan(0);
  });

  it("token fields are summed correctly per subagent", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const workerAEntry = breakdown.find(e => e.subagentId === WORKER_A)!;
    expect(workerAEntry.totalInputTokens).toBe(5000);
    expect(workerAEntry.totalOutputTokens).toBe(2000);
  });

  it("time-range filter: sinceTs excludes early entries", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT, {
      sinceTs: "2026-04-21T10:01:30.000Z", // only rows after researcher-1
    });
    // Should include researcher-2 and formatter only
    expect(breakdown).toHaveLength(2);
    const ids = breakdown.map(e => e.subagentId);
    expect(ids).toContain(WORKER_B);
    expect(ids).toContain(FORMATTER);
  });

  it("time-range filter: untilTs excludes late entries", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT, {
      untilTs: "2026-04-21T10:01:30.000Z", // only lead + researcher-1
    });
    expect(breakdown).toHaveLength(2);
    const ids = breakdown.map(e => e.subagentId);
    expect(ids).toContain(PARENT);
    expect(ids).toContain(WORKER_A);
  });

  it("totalCost() equals sum of all breakdown entries' costs", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const sumFromBreakdown = r6(breakdown.reduce((s, e) => s + e.totalCostUsd, 0));
    const fromTotal = r6(tracker.totalCost(PARENT));
    expect(fromTotal).toBeCloseTo(sumFromBreakdown, 4);
  });

  it("totalCacheSavings() equals sum of all breakdown savings", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const sumFromBreakdown = r6(breakdown.reduce((s, e) => s + e.cacheSavingsUsd, 0));
    const fromTotal = r6(tracker.totalCacheSavings(PARENT));
    expect(fromTotal).toBeCloseTo(sumFromBreakdown, 4);
  });

  it("ledger stays balanced after all attributions", () => {
    const summary = ledger.verify();
    expect(summary.balanced).toBe(true);
    expect(summary.imbalance).toBe(0);
  });

  it("eventCount is 1 per distinct subagent in this test (no aggregation needed)", () => {
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    for (const entry of breakdown) {
      expect(entry.eventCount).toBe(1);
    }
  });

  it("a second attribution for the same subagent is aggregated", () => {
    // Add a second call for WORKER_A
    tracker.attributeSubagentCost({
      parentAgentId: PARENT,
      subagentId: WORKER_A,
      subagentRole: "researcher",
      modelId: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      timestamp: "2026-04-21T10:10:00.000Z",
    });

    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const workerAEntry = breakdown.find(e => e.subagentId === WORKER_A)!;
    expect(workerAEntry.eventCount).toBe(2);
    expect(workerAEntry.totalInputTokens).toBe(6000);  // 5000 + 1000
  });

  it("different parentAgentId does not appear in breakdown", () => {
    tracker.attributeSubagentCost({
      parentAgentId: "other-parent",
      subagentId: "other-sub",
      subagentRole: "analyst",
      modelId: "claude-haiku-4-5",
      inputTokens: 500,
      outputTokens: 200,
    });
    const breakdown = tracker.subagentCostBreakdown(PARENT);
    const ids = breakdown.map(e => e.subagentId);
    expect(ids).not.toContain("other-sub");
  });
});

describe("MnemoPayLite integration via agent.subagentCosts", () => {
  it("subagentCosts tracker is available on MnemoPay.quick() instance", () => {
    const agent = MnemoPay.quick("orch-agent");
    expect(agent.subagentCosts).toBeDefined();
    expect(typeof agent.subagentCosts.attributeSubagentCost).toBe("function");
    expect(typeof agent.subagentCosts.subagentCostBreakdown).toBe("function");
  });

  it("tracks costs and the ledger reflects them", () => {
    const agent = MnemoPay.quick("orch-agent-2");

    agent.subagentCosts.attributeSubagentCost({
      parentAgentId: "orch-agent-2",
      subagentId: "sub-sonnet",
      subagentRole: "worker",
      modelId: "claude-sonnet-4-6",
      inputTokens: 10_000,
      outputTokens: 4_000,
    });

    // Ledger should have the entry
    const summary = agent.ledger.verify();
    expect(summary.balanced).toBe(true);
    expect(summary.entryCount).toBeGreaterThanOrEqual(2);

    // Breakdown should show the subagent
    const breakdown = agent.subagentCosts.subagentCostBreakdown("orch-agent-2");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].subagentId).toBe("sub-sonnet");
    expect(breakdown[0].totalCostUsd).toBeGreaterThan(0);
  });

  it("cache savings are non-zero when cacheReadTokens are provided", () => {
    const agent = MnemoPay.quick("orch-agent-3");

    agent.subagentCosts.attributeSubagentCost({
      parentAgentId: "orch-agent-3",
      subagentId: "sub-haiku",
      subagentRole: "formatter",
      modelId: "claude-haiku-4-5",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 50_000,  // large recall cache — should produce significant savings
    });

    const breakdown = agent.subagentCosts.subagentCostBreakdown("orch-agent-3");
    expect(breakdown[0].cacheSavingsUsd).toBeGreaterThan(0);
  });
});
