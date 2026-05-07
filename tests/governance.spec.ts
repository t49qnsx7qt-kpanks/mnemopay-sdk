/**
 * Smoke tests for the governance module folded from Praetor on 2026-05-06.
 * Covers FiscalGate (budget reserve/settle/release) + Article 12 bundle export.
 */

import { describe, it, expect } from "vitest";
import {
  MerkleAudit,
  validateCharter,
  runMission,
  buildArticle12Bundle,
  MockPayments,
  type Charter,
  type MissionResult,
} from "../src/governance/index.js";

const baseCharter: Charter = {
  name: "test-mission",
  goal: "smoke-test the governance fold",
  budget: { maxUsd: 1.0, approvalThresholdUsd: 0.1 },
  agents: [{ role: "research" }],
  outputs: ["text"],
  compliance: { article12: true },
};

describe("governance/charter", () => {
  it("validates a well-formed charter", () => {
    expect(() => validateCharter(baseCharter)).not.toThrow();
  });

  it("rejects missing budget", () => {
    expect(() => validateCharter({ ...baseCharter, budget: undefined })).toThrow(/budget/);
  });

  it("rejects empty agents", () => {
    expect(() => validateCharter({ ...baseCharter, agents: [] })).toThrow(/agents/);
  });
});

describe("governance/audit MerkleAudit", () => {
  it("appends events and chains hashes", () => {
    const a = new MerkleAudit();
    a.record("a", { x: 1 });
    a.record("b", { x: 2 });
    expect(a.getEvents().length).toBe(2);
    expect(a.getChain().length).toBe(2);
    expect(a.verify()).toBe(true);
  });

  it("verify() detects tampered events", () => {
    const a = new MerkleAudit();
    a.record("ok", { v: 1 });
    a.record("ok", { v: 2 });
    expect(a.verify()).toBe(true);
    // mutate via JSON serialize/deserialize
    const j = a.toJSON();
    j.events[0].data = { v: 999 };
    const b = MerkleAudit.fromJSON(j);
    expect(b.verify()).toBe(false);
  });

  it("listeners fire for each record", () => {
    const a = new MerkleAudit();
    const seen: string[] = [];
    const off = a.on((ev) => seen.push(ev.type));
    a.record("x", {});
    a.record("y", {});
    off();
    a.record("z", {});
    expect(seen).toEqual(["x", "y"]);
  });
});

describe("governance/runtime FiscalGate runMission", () => {
  it("settles the actual spend on success", async () => {
    const audit = new MerkleAudit();
    const payments = new MockPayments();
    const result = await runMission({
      charter: baseCharter,
      payments,
      agents: { run: async () => ({ outputs: ["done"], spentUsd: 0.45 }) },
      audit: {
        record: (t, d) => audit.record(t, d),
        finalize: () => audit.finalize(),
      },
    });
    expect(result.status).toBe("ok");
    expect(result.spentUsd).toBe(0.45);
    expect(payments.getHolds().size).toBe(0); // settled
  });

  it("halts when over budget and releases the hold", async () => {
    const audit = new MerkleAudit();
    const payments = new MockPayments();
    const result = await runMission({
      charter: baseCharter,
      payments,
      agents: { run: async () => ({ outputs: ["done"], spentUsd: 5.0 }) },
      audit: {
        record: (t, d) => audit.record(t, d),
        finalize: () => audit.finalize(),
      },
    });
    expect(result.status).toBe("halted");
    expect(payments.getHolds().size).toBe(0); // released
  });

  it("returns error and releases on agent throw", async () => {
    const audit = new MerkleAudit();
    const payments = new MockPayments();
    const result = await runMission({
      charter: baseCharter,
      payments,
      agents: { run: async () => { throw new Error("boom"); } },
      audit: {
        record: (t, d) => audit.record(t, d),
        finalize: () => audit.finalize(),
      },
    });
    expect(result.status).toBe("error");
    expect(result.spentUsd).toBe(0);
    expect(payments.getHolds().size).toBe(0); // released
  });
});

describe("governance/article12 buildArticle12Bundle", () => {
  it("produces 5 files with checksums + a bundle digest", async () => {
    const audit = new MerkleAudit();
    const payments = new MockPayments();
    const result: MissionResult = await runMission({
      charter: baseCharter,
      payments,
      agents: { run: async () => ({ outputs: ["o1", "o2"], spentUsd: 0.32 }) },
      audit: {
        record: (t, d) => audit.record(t, d),
        finalize: () => audit.finalize(),
      },
    });

    const bundle = buildArticle12Bundle({
      charter: baseCharter,
      result,
      audit,
      retentionMonths: 6,
      operatorId: "smoke-test-llc",
    });

    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["chain.txt", "events.csv", "events.json", "manifest.json", "mission.json"]);
    expect(bundle.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const f of bundle.files) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(f.body.length).toBeGreaterThan(0);
    }

    // mission.json should embed the legal basis + retention block
    const mission = bundle.files.find((f) => f.path === "mission.json")!;
    expect(mission.body).toContain("EU AI Act Article 12");
    expect(mission.body).toContain("\"retention\"");
    expect(mission.body).toContain("\"months\": 6");
  });

  it("defaults retention to 6 months when not specified", () => {
    const audit = new MerkleAudit();
    audit.record("genesis", {});
    const bundle = buildArticle12Bundle({
      charter: baseCharter,
      result: {
        charterName: "test",
        status: "ok",
        spentUsd: 0,
        outputs: [],
        auditDigest: audit.finalize(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      audit,
    });
    const manifest = JSON.parse(bundle.files.find((f) => f.path === "manifest.json")!.body);
    expect(manifest.retentionMonths).toBe(6);
  });
});
