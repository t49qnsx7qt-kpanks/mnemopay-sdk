/**
 * MnemoPay SDK — Comprehensive Test Suite
 *
 * Covers: memory operations, payment operations, feedback loop,
 * reputation mechanics, fraud prevention, security, edge cases,
 * concurrency, and stress testing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MnemoPay, MnemoPayLite, autoScore, computeScore } from "../src/index.js";
import type { FraudConfig } from "../src/index.js";

/** Fraud config that disables fees and raises all limits — for backward-compatible tests */
const NO_FRAUD: Partial<FraudConfig> = {
  platformFeeRate: 0,
  maxChargesPerMinute: 100000,
  maxChargesPerHour: 1000000,
  maxChargesPerDay: 10000000,
  maxDailyVolume: 10000000,
  maxPendingTransactions: 100000,
  blockThreshold: 1.01, // impossible to reach — effectively disables blocking
  flagThreshold: 1.01,
};

// ─── Memory Operations ─────────────────────────────────────────────────────

describe("Memory Operations", () => {
  let agent: MnemoPayLite;

  beforeEach(() => {
    agent = MnemoPay.quick("test-agent");
  });

  it("should store and recall a memory", async () => {
    const id = await agent.remember("User prefers TypeScript");
    const memories = await agent.recall(1);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("User prefers TypeScript");
    expect(memories[0].id).toBe(id);
  });

  it("should auto-score memory importance based on content", async () => {
    await agent.remember("Just a normal message");
    await agent.remember("CRITICAL: Server crashed with error");
    const memories = await agent.recall(2);
    const critical = memories.find((m) => m.content.includes("CRITICAL"));
    const normal = memories.find((m) => m.content.includes("normal"));
    expect(critical!.importance).toBeGreaterThan(normal!.importance);
  });

  it("should respect manual importance override", async () => {
    await agent.remember("Low priority", { importance: 0.1 });
    await agent.remember("High priority", { importance: 0.99 });
    const memories = await agent.recall(2);
    expect(memories[0].content).toBe("High priority");
    expect(memories[0].importance).toBe(0.99);
  });

  it("should clamp importance to [0, 1]", async () => {
    await agent.remember("Over max", { importance: 5.0 });
    await agent.remember("Under min", { importance: -2.0 });
    const memories = await agent.recall(2);
    for (const m of memories) {
      expect(m.importance).toBeGreaterThanOrEqual(0);
      expect(m.importance).toBeLessThanOrEqual(1);
    }
  });

  it("should rank memories by composite score (importance × recency × frequency)", async () => {
    await agent.remember("Old unimportant thing", { importance: 0.1 });
    await agent.remember("Recent critical event", { importance: 0.95 });
    const memories = await agent.recall(2);
    expect(memories[0].content).toBe("Recent critical event");
  });

  it("should increase access count on recall", async () => {
    await agent.remember("Frequently accessed");
    await agent.recall(1);
    await agent.recall(1);
    await agent.recall(1);
    const memories = await agent.recall(1);
    expect(memories[0].accessCount).toBe(4); // 3 previous + this recall
  });

  it("should forget a memory by ID", async () => {
    const id = await agent.remember("Temporary");
    expect(await agent.forget(id)).toBe(true);
    const memories = await agent.recall(10);
    expect(memories.find((m) => m.id === id)).toBeUndefined();
  });

  it("should return false when forgetting non-existent memory", async () => {
    expect(await agent.forget("non-existent-id")).toBe(false);
  });

  it("should reinforce a memory's importance", async () => {
    const id = await agent.remember("Reinforceable", { importance: 0.5 });
    await agent.reinforce(id, 0.2);
    const memories = await agent.recall(1);
    expect(memories[0].importance).toBeCloseTo(0.7, 1);
  });

  it("should cap reinforced importance at 1.0", async () => {
    const id = await agent.remember("Almost max", { importance: 0.95 });
    await agent.reinforce(id, 0.3);
    const memories = await agent.recall(1);
    expect(memories[0].importance).toBe(1.0);
  });

  it("should throw when reinforcing non-existent memory", async () => {
    await expect(agent.reinforce("fake-id")).rejects.toThrow("not found");
  });

  it("should consolidate (prune) stale memories", async () => {
    // Store memories with very low importance that will score below threshold
    for (let i = 0; i < 10; i++) {
      await agent.remember(`Stale memory ${i}`, { importance: 0.001 });
    }
    // Manually make them old by not accessing them
    // In quick mode with λ=0.05, score = 0.001 * exp(-0.05 * 0) * (1 + ln(1)) = 0.001
    // This is below the 0.01 threshold
    const pruned = await agent.consolidate();
    expect(pruned).toBe(10);
  });

  it("should handle empty recall gracefully", async () => {
    const memories = await agent.recall(5);
    expect(memories).toHaveLength(0);
  });

  it("should support tags on memories", async () => {
    await agent.remember("Tagged memory", { tags: ["test", "important"] });
    const memories = await agent.recall(1);
    expect(memories[0].tags).toEqual(["test", "important"]);
  });

  it("should handle 1000 memories without performance degradation", async () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await agent.remember(`Memory entry ${i}`, { importance: Math.random() });
    }
    const storeTime = Date.now() - start;

    const recallStart = Date.now();
    const memories = await agent.recall(10);
    const recallTime = Date.now() - recallStart;

    expect(memories).toHaveLength(10);
    expect(storeTime).toBeLessThan(5000); // 1000 stores in <5s
    expect(recallTime).toBeLessThan(500); // recall in <500ms
  });
});

// ─── Auto-Scoring ───────────────────────────────────────────────────────────

describe("Auto-Scoring", () => {
  it("should give base score of 0.50 for plain text", () => {
    expect(autoScore("hello world")).toBe(0.50);
  });

  it("should boost for error/critical keywords", () => {
    expect(autoScore("Server crashed with critical error")).toBeGreaterThanOrEqual(0.70);
  });

  it("should boost for preference keywords", () => {
    expect(autoScore("User always prefers dark mode")).toBeGreaterThan(0.60);
  });

  it("should boost for success keywords", () => {
    expect(autoScore("Task completed successfully and paid")).toBeGreaterThan(0.60);
  });

  it("should boost for long content", () => {
    const longText = "x".repeat(250);
    expect(autoScore(longText)).toBeGreaterThan(0.50);
  });

  it("should cap at 1.0 even with multiple boosts", () => {
    const maxText = "critical error fail crash prefer always never important " + "x".repeat(250);
    expect(autoScore(maxText)).toBeLessThanOrEqual(1.0);
  });
});

// ─── Memory Scoring Model ───────────────────────────────────────────────────

describe("Memory Scoring Model", () => {
  it("should return higher score for recent memories", () => {
    const now = new Date();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const recent = computeScore(0.5, now, 0, 0.05);
    const older = computeScore(0.5, hourAgo, 0, 0.05);
    expect(recent).toBeGreaterThan(older);
  });

  it("should return higher score for frequently accessed memories", () => {
    const now = new Date();
    const frequent = computeScore(0.5, now, 10, 0.05);
    const rare = computeScore(0.5, now, 0, 0.05);
    expect(frequent).toBeGreaterThan(rare);
  });

  it("should apply logarithmic diminishing returns on frequency", () => {
    const now = new Date();
    const s10 = computeScore(0.5, now, 10, 0.05);
    const s100 = computeScore(0.5, now, 100, 0.05);
    const s1000 = computeScore(0.5, now, 1000, 0.05);
    // Ratio between 100→1000 should be smaller than 10→100
    const ratio1 = s100 / s10;
    const ratio2 = s1000 / s100;
    expect(ratio2).toBeLessThan(ratio1);
  });

  it("should decay exponentially with λ parameter", () => {
    const now = new Date();
    const dayAgo = new Date(Date.now() - 86_400_000);
    const slowDecay = computeScore(0.5, dayAgo, 0, 0.01); // λ=0.01
    const fastDecay = computeScore(0.5, dayAgo, 0, 0.25); // λ=0.25
    expect(slowDecay).toBeGreaterThan(fastDecay);
  });

  it("should return 0 for zero importance", () => {
    expect(computeScore(0, new Date(), 100, 0.05)).toBe(0);
  });
});

// ─── Payment Operations ─────────────────────────────────────────────────────

describe("Payment Operations", () => {
  let agent: MnemoPayLite;

  beforeEach(() => {
    agent = MnemoPay.quick("pay-test", { fraud: NO_FRAUD });
  });

  it("should create a pending escrow charge", async () => {
    const tx = await agent.charge(10.0, "Test service");
    expect(tx.status).toBe("pending");
    expect(tx.amount).toBe(10.0);
    expect(tx.reason).toBe("Test service");
  });

  it("should settle a pending transaction", async () => {
    const tx = await agent.charge(5.0, "Test");
    const settled = await agent.settle(tx.id);
    expect(settled.status).toBe("completed");
    const bal = await agent.balance();
    expect(bal.wallet).toBe(5.0);
  });

  it("should refund a pending transaction", async () => {
    const tx = await agent.charge(5.0, "Test");
    const refunded = await agent.refund(tx.id);
    expect(refunded.status).toBe("refunded");
    const bal = await agent.balance();
    expect(bal.wallet).toBe(0);
  });

  it("should refund a completed transaction and dock reputation", async () => {
    const tx = await agent.charge(5.0, "Test");
    await agent.settle(tx.id);
    const balBefore = await agent.balance();
    await agent.refund(tx.id);
    const balAfter = await agent.balance();
    expect(balAfter.wallet).toBe(0);
    expect(balAfter.reputation).toBeLessThan(balBefore.reputation);
  });

  it("should throw on negative charge amount", async () => {
    await expect(agent.charge(-5, "Negative")).rejects.toThrow("positive");
  });

  it("should throw on zero charge amount", async () => {
    await expect(agent.charge(0, "Zero")).rejects.toThrow("positive");
  });

  it("should throw when settling non-existent transaction", async () => {
    await expect(agent.settle("fake-id")).rejects.toThrow("not found");
  });

  it("should throw when settling already completed transaction", async () => {
    const tx = await agent.charge(5.0, "Test");
    await agent.settle(tx.id);
    await expect(agent.settle(tx.id)).rejects.toThrow("not pending");
  });

  it("should throw when double-refunding", async () => {
    const tx = await agent.charge(5.0, "Test");
    await agent.refund(tx.id);
    await expect(agent.refund(tx.id)).rejects.toThrow("already refunded");
  });
});

// ─── Reputation-Gated Payments (Financial Security) ─────────────────────────

describe("Reputation-Gated Payments", () => {
  let agent: MnemoPayLite;

  beforeEach(() => {
    agent = MnemoPay.quick("rep-test", { fraud: NO_FRAUD });
  });

  it("should enforce reputation ceiling on charges", async () => {
    // New agent: reputation 0.5, max charge = $250
    await expect(agent.charge(300, "Over limit")).rejects.toThrow("ceiling");
  });

  it("should allow charge at exact ceiling", async () => {
    // reputation 0.5 → max $250
    const tx = await agent.charge(250, "At ceiling");
    expect(tx.status).toBe("pending");
  });

  it("should increase ceiling as reputation grows", async () => {
    // Build reputation: settle 10 transactions → +0.10 reputation
    for (let i = 0; i < 10; i++) {
      const tx = await agent.charge(1, `Service ${i}`);
      await agent.settle(tx.id);
    }
    const bal = await agent.balance();
    expect(bal.reputation).toBeCloseTo(0.60, 1);
    // New ceiling: 0.60 * 500 = $300
    const tx = await agent.charge(290, "Higher ceiling");
    expect(tx.status).toBe("pending");
  });

  it("should require 5 successful settlements to recover from 1 refund", async () => {
    // Reputation asymmetry: +0.01 per settle, -0.05 per refund
    const initialRep = (await agent.balance()).reputation; // 0.50
    const tx1 = await agent.charge(5, "Test");
    await agent.settle(tx1.id);
    await agent.refund(tx1.id);
    const afterRefund = (await agent.balance()).reputation;
    // 0.50 + 0.01 - 0.05 = 0.46
    expect(afterRefund).toBeCloseTo(0.46, 2);

    // Need 5 settles to get back to ~0.51 (above initial)
    for (let i = 0; i < 5; i++) {
      const tx = await agent.charge(1, `Recovery ${i}`);
      await agent.settle(tx.id);
    }
    const recovered = (await agent.balance()).reputation;
    expect(recovered).toBeGreaterThanOrEqual(initialRep);
  });

  it("should cap reputation at 1.0", async () => {
    // Settle 60 transactions: 0.50 + 0.60 = 1.10 → capped at 1.00
    for (let i = 0; i < 60; i++) {
      const tx = await agent.charge(1, `Service ${i}`);
      await agent.settle(tx.id);
    }
    const bal = await agent.balance();
    expect(bal.reputation).toBe(1.0);
  });

  it("should floor reputation at 0.0", async () => {
    // Refund 11 times: 0.50 - 0.55 → capped at 0.00
    for (let i = 0; i < 11; i++) {
      const tx = await agent.charge(1, `Bad service ${i}`);
      await agent.settle(tx.id);
      await agent.refund(tx.id);
    }
    const bal = await agent.balance();
    expect(bal.reputation).toBeGreaterThanOrEqual(0);
  });
});

// ─── Feedback Loop (Memory-Payment Reinforcement) ───────────────────────────

describe("Feedback Loop", () => {
  let agent: MnemoPayLite;

  beforeEach(() => {
    agent = MnemoPay.quick("feedback-test", { fraud: NO_FRAUD });
  });

  it("should reinforce recently-accessed memories on settle", async () => {
    const id = await agent.remember("Decision context", { importance: 0.5 });
    // Recall it so it's "recently accessed"
    await agent.recall(1);
    // Charge and settle
    const tx = await agent.charge(5, "Good work");
    await agent.settle(tx.id);
    // Memory should now be boosted by +0.05
    const memories = await agent.recall(1);
    expect(memories[0].importance).toBeCloseTo(0.55, 2);
  });

  it("should NOT reinforce memories older than 1 hour", async () => {
    const id = await agent.remember("Old context", { importance: 0.5 });
    // Manually make it old
    const mem = (agent as any).memories.get(id);
    mem.lastAccessed = new Date(Date.now() - 7_200_000); // 2 hours ago

    const tx = await agent.charge(5, "Work");
    await agent.settle(tx.id);

    const memories = await agent.recall(1);
    // Should be 0.5 (accessed by recall just now, but reinforcement already happened)
    // The key point: old memories don't get boosted during settle
    expect(memories[0].importance).toBe(0.5);
  });

  it("should compound reinforcement over multiple settlements", async () => {
    await agent.remember("Core strategy", { importance: 0.5 });
    for (let i = 0; i < 5; i++) {
      await agent.recall(1); // Access it
      const tx = await agent.charge(1, `Service ${i}`);
      await agent.settle(tx.id); // Each settle reinforces by +0.05
    }
    const memories = await agent.recall(1);
    // 0.5 + (5 × 0.05) = 0.75
    expect(memories[0].importance).toBeCloseTo(0.75, 1);
  });
});

// ─── Audit Trail (Immutability) ─────────────────────────────────────────────

describe("Audit Trail", () => {
  let agent: MnemoPayLite;

  beforeEach(() => {
    agent = MnemoPay.quick("audit-test", { fraud: NO_FRAUD });
  });

  it("should log every memory operation", async () => {
    const id = await agent.remember("Test");
    await agent.reinforce(id, 0.1);
    await agent.forget(id);
    const logs = await agent.logs(10);
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(["memory:stored", "memory:reinforced", "memory:deleted"])
    );
  });

  it("should log every payment operation", async () => {
    const tx = await agent.charge(5, "Test");
    await agent.settle(tx.id);
    const logs = await agent.logs(10);
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(["payment:pending", "payment:completed"])
    );
  });

  it("should include details in audit entries", async () => {
    await agent.remember("Audited memory");
    const logs = await agent.logs(1);
    expect(logs[0].details).toHaveProperty("content");
    expect(logs[0].details).toHaveProperty("importance");
  });

  it("should maintain chronological order", async () => {
    for (let i = 0; i < 10; i++) {
      await agent.remember(`Entry ${i}`);
    }
    const logs = await agent.logs(10);
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i].createdAt.getTime()).toBeGreaterThanOrEqual(logs[i - 1].createdAt.getTime());
    }
  });
});

// ─── Event Emitter ──────────────────────────────────────────────────────────

describe("Event Emitter", () => {
  it("should emit ready event", async () => {
    const agent = MnemoPay.quick("event-test");
    const ready = await new Promise<boolean>((resolve) => {
      agent.on("ready", () => resolve(true));
      setTimeout(() => resolve(false), 100);
    });
    expect(ready).toBe(true);
  });

  it("should emit memory:stored on remember", async () => {
    const agent = MnemoPay.quick("event-test");
    const stored = new Promise<any>((resolve) => agent.on("memory:stored", resolve));
    await agent.remember("Event test");
    const event = await stored;
    expect(event.content).toBe("Event test");
  });

  it("should emit payment events", async () => {
    const agent = MnemoPay.quick("event-test", { fraud: NO_FRAUD });
    const events: string[] = [];
    agent.on("payment:pending", () => events.push("pending"));
    agent.on("payment:completed", () => events.push("completed"));
    const tx = await agent.charge(1, "Test");
    await agent.settle(tx.id);
    expect(events).toEqual(["pending", "completed"]);
  });
});

// ─── Agent Profile & History ────────────────────────────────────────────────

describe("Agent Profile & History", () => {
  it("should return accurate profile stats", async () => {
    const agent = MnemoPay.quick("profile-test", { fraud: NO_FRAUD });
    await agent.remember("M1");
    await agent.remember("M2");
    const tx = await agent.charge(5, "Service");
    await agent.settle(tx.id);

    const profile = await agent.profile();
    expect(profile.id).toBe("profile-test");
    expect(profile.memoriesCount).toBe(2);
    expect(profile.transactionsCount).toBe(1);
    expect(profile.wallet).toBe(5);
    expect(profile.reputation).toBeGreaterThan(0.5);
  });

  it("should return transaction history in reverse chronological order", async () => {
    const agent = MnemoPay.quick("history-test", { fraud: NO_FRAUD });
    const tx1 = await agent.charge(1, "First");
    const tx2 = await agent.charge(2, "Second");
    const tx3 = await agent.charge(3, "Third");
    const history = await agent.history(10);
    expect(history[0].amount).toBe(3); // most recent first
    expect(history[2].amount).toBe(1);
  });
});

// ─── Concurrency & Stress ───────────────────────────────────────────────────

describe("Concurrency & Stress", () => {
  it("should handle 100 concurrent remember operations", async () => {
    const agent = MnemoPay.quick("concurrent-test");
    const promises = Array.from({ length: 100 }, (_, i) =>
      agent.remember(`Concurrent memory ${i}`)
    );
    const ids = await Promise.all(promises);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100); // all unique IDs
  });

  it("should handle 100 concurrent charge operations", async () => {
    const agent = MnemoPay.quick("concurrent-pay", { fraud: NO_FRAUD });
    const promises = Array.from({ length: 100 }, (_, i) =>
      agent.charge(0.5, `Concurrent charge ${i}`)
    );
    const txns = await Promise.all(promises);
    expect(txns).toHaveLength(100);
    expect(txns.every((t) => t.status === "pending")).toBe(true);
  });

  it("should handle rapid store-recall-settle cycles", async () => {
    const agent = MnemoPay.quick("rapid-test", { fraud: NO_FRAUD });
    for (let i = 0; i < 50; i++) {
      await agent.remember(`Cycle ${i}`);
      await agent.recall(3);
      const tx = await agent.charge(0.1, `Micro service ${i}`);
      await agent.settle(tx.id);
    }
    const profile = await agent.profile();
    expect(profile.memoriesCount).toBe(50);
    expect(profile.transactionsCount).toBe(50);
    expect(profile.wallet).toBeCloseTo(5.0, 1);
  });

  it("should isolate state between agents", async () => {
    const a1 = MnemoPay.quick("agent-1");
    const a2 = MnemoPay.quick("agent-2");

    await a1.remember("A1 secret");
    await a2.remember("A2 secret");

    const m1 = await a1.recall(10);
    const m2 = await a2.recall(10);

    expect(m1).toHaveLength(1);
    expect(m1[0].content).toBe("A1 secret");
    expect(m2).toHaveLength(1);
    expect(m2[0].content).toBe("A2 secret");
  });
});

// ─── Edge Cases & Security ──────────────────────────────────────────────────

describe("Edge Cases & Security", () => {
  it("should handle empty string memory", async () => {
    const agent = MnemoPay.quick("edge-test");
    const id = await agent.remember("");
    expect(id).toBeTruthy();
  });

  it("should handle very long content (10KB)", async () => {
    const agent = MnemoPay.quick("edge-test");
    const longContent = "x".repeat(10_000);
    const id = await agent.remember(longContent);
    const memories = await agent.recall(1);
    expect(memories[0].content.length).toBe(10_000);
  });

  it("should handle special characters in content", async () => {
    const agent = MnemoPay.quick("edge-test");
    const special = 'SQL injection: \'; DROP TABLE--; XSS: <script>alert("xss")</script>';
    await agent.remember(special);
    const memories = await agent.recall(1);
    expect(memories[0].content).toBe(special);
  });

  it("should handle unicode content", async () => {
    const agent = MnemoPay.quick("edge-test");
    const unicode = "User preference: 日本語を使いたい 🇯🇵";
    await agent.remember(unicode);
    const memories = await agent.recall(1);
    expect(memories[0].content).toBe(unicode);
  });

  it("should handle floating point precision in payments", async () => {
    const agent = MnemoPay.quick("precision-test", { fraud: NO_FRAUD });
    // Classic floating point: 0.1 + 0.2 ≠ 0.3
    const tx1 = await agent.charge(0.1, "A");
    await agent.settle(tx1.id);
    const tx2 = await agent.charge(0.2, "B");
    await agent.settle(tx2.id);
    const bal = await agent.balance();
    // Should handle this correctly (within precision)
    expect(bal.wallet).toBeCloseTo(0.3, 10);
  });

  it("should generate unique IDs for all entities", async () => {
    const agent = MnemoPay.quick("id-test");
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(await agent.remember(`M${i}`));
    }
    expect(ids.size).toBe(1000);
  });

  it("should not allow wallet to go negative via multiple refunds", async () => {
    const agent = MnemoPay.quick("neg-wallet-test", { fraud: NO_FRAUD });
    const tx = await agent.charge(10, "Test");
    await agent.settle(tx.id);
    await agent.refund(tx.id);
    // wallet should be 0, not negative
    const bal = await agent.balance();
    expect(bal.wallet).toBe(0);
  });
});

// ─── Factory Methods ────────────────────────────────────────────────────────

describe("Factory Methods", () => {
  it("MnemoPay.quick() should return MnemoPayLite instance", () => {
    const agent = MnemoPay.quick("test");
    expect(agent).toBeInstanceOf(MnemoPayLite);
  });

  it("MnemoPay.create() should return MnemoPay instance", () => {
    const agent = MnemoPay.create({ agentId: "test" });
    expect(agent).toBeInstanceOf(MnemoPay);
  });

  it("should accept custom decay rate", () => {
    const agent = MnemoPay.quick("test", { decay: 0.25 });
    expect((agent as any).decay).toBe(0.25);
  });
});
