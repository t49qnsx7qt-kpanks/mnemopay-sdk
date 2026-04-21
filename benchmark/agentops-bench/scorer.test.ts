/**
 * AgentOps scorer — pure tests, no network.
 */

import { describe, it, expect } from "vitest";
import { scoreAgentOps, compareAgentOps, formatAgentOps } from "./scorer.js";

describe("scoreAgentOps", () => {
  it("geometric mean of all-equal pillars equals the pillar value", () => {
    const s = scoreAgentOps({ memory: 0.8, payments: 0.8, identity: 0.8, integrity: 0.8 });
    expect(s.composite).toBeCloseTo(0.8, 5);
    expect(s.arithmeticMean).toBeCloseTo(0.8, 5);
    expect(s.collapsed).toBe(false);
    expect(s.collapsedBy).toBeNull();
  });

  it("zero on any pillar collapses the composite to 0", () => {
    const s = scoreAgentOps({ memory: 0.95, payments: 0, identity: 0.9, integrity: 0.9 });
    expect(s.composite).toBe(0);
    expect(s.collapsed).toBe(true);
    expect(s.collapsedBy).toBe("payments");
    // Arithmetic mean is unaffected
    expect(s.arithmeticMean).toBeCloseTo((0.95 + 0 + 0.9 + 0.9) / 4, 5);
  });

  it("composite matches manual geometric mean for mixed pillars", () => {
    const scores = { memory: 0.85, payments: 0.7, identity: 1.0, integrity: 0.95 };
    const expected = Math.pow(0.85 * 0.7 * 1.0 * 0.95, 1 / 4);
    const s = scoreAgentOps(scores);
    expect(s.composite).toBeCloseTo(expected, 8);
  });

  it("rejects out-of-range pillars", () => {
    expect(() => scoreAgentOps({ memory: -0.1, payments: 0.5, identity: 0.5, integrity: 0.5 }))
      .toThrow(/in \[0, 1\]/);
    expect(() => scoreAgentOps({ memory: 0.5, payments: 1.5, identity: 0.5, integrity: 0.5 }))
      .toThrow(/in \[0, 1\]/);
  });

  it("rejects NaN pillars", () => {
    expect(() => scoreAgentOps({ memory: NaN, payments: 0.5, identity: 0.5, integrity: 0.5 }))
      .toThrow(/not a number/);
  });
});

describe("compareAgentOps", () => {
  it("sorts higher composite first", () => {
    const a = scoreAgentOps({ memory: 0.9, payments: 0.9, identity: 0.9, integrity: 0.9 });
    const b = scoreAgentOps({ memory: 0.7, payments: 0.7, identity: 0.7, integrity: 0.7 });
    expect(compareAgentOps(a, b)).toBeLessThan(0);
    expect(compareAgentOps(b, a)).toBeGreaterThan(0);
  });

  it("uses arithmetic mean as tiebreaker when composites collapse", () => {
    // Both have composite=0 but different arith means
    const a = scoreAgentOps({ memory: 0.95, payments: 0, identity: 0.95, integrity: 0.95 });
    const b = scoreAgentOps({ memory: 0.5, payments: 0, identity: 0.5, integrity: 0.5 });
    expect(a.composite).toBe(0);
    expect(b.composite).toBe(0);
    expect(compareAgentOps(a, b)).toBeLessThan(0); // a is higher-mean, so comes first
  });
});

describe("formatAgentOps", () => {
  it("includes all pillars and the collapse reason when collapsed", () => {
    const s = scoreAgentOps({ memory: 0.9, payments: 0, identity: 0.9, integrity: 0.9 });
    const out = formatAgentOps(s);
    expect(out).toContain("collapsed by payments");
    expect(out).toContain("memory:");
    expect(out).toContain("payments:");
    expect(out).toContain("identity:");
    expect(out).toContain("integrity:");
  });
});
