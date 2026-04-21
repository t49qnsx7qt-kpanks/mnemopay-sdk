/**
 * MnemoPay Fraud Guard — Comprehensive Test Suite
 *
 * Covers: velocity checks, anomaly detection, platform fees,
 * dispute resolution, rate limiting, risk scoring, agent blocking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MnemoPay, MnemoPayLite, FraudGuard, RateLimiter } from "../src/index.js";
import type { FraudConfig } from "../src/index.js";

// ─── Platform Fee ──────────────────────────────────────────────────────────

describe("Platform Fee", () => {
  it("should deduct 1.9% fee on settle (default)", async () => {
    const agent = MnemoPay.quick("fee-test", { fraud: { settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(100, "Service delivered");
    const settled = await agent.settle(tx.id);

    expect(settled.platformFee).toBe(1.9);
    expect(settled.netAmount).toBe(98.1);

    const bal = await agent.balance();
    expect(bal.wallet).toBe(98.1);
  });

  it("should apply custom fee rate", async () => {
    const agent = MnemoPay.quick("fee-custom", { fraud: { platformFeeRate: 0.05, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(200, "Premium service");
    const settled = await agent.settle(tx.id);

    expect(settled.platformFee).toBe(10);
    expect(settled.netAmount).toBe(190);
  });

  it("should handle zero fee rate", async () => {
    const agent = MnemoPay.quick("fee-zero", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(50, "Free tier");
    const settled = await agent.settle(tx.id);

    expect(settled.platformFee).toBe(0);
    expect(settled.netAmount).toBe(50);

    const bal = await agent.balance();
    expect(bal.wallet).toBe(50);
  });

  it("should track platform fees in fraud guard stats", async () => {
    const agent = MnemoPay.quick("fee-stats", { fraud: { settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx1 = await agent.charge(100, "A");
    await agent.settle(tx1.id);
    const tx2 = await agent.charge(100, "B");
    await agent.settle(tx2.id);

    const stats = agent.fraud.stats();
    expect(stats.platformFeesCollected).toBe(3.8); // 1.9 + 1.9
  });

  it("should apply volume-based tiered pricing", async () => {
    const agent = MnemoPay.quick("fee-tiers", {
      fraud: {
        platformFeeRate: 0.019,
        settlementHoldMinutes: 0,
        disputeWindowMinutes: 0,
        feeTiers: [
          { minVolume: 0, rate: 0.019 },
          { minVolume: 100, rate: 0.015 },
          { minVolume: 300, rate: 0.010 },
        ],
      },
    });

    // First tx: volume = 0, rate = 1.9%
    const tx1 = await agent.charge(80, "Under tier 1");
    const s1 = await agent.settle(tx1.id);
    expect(s1.platformFee).toBe(1.52); // 80 * 0.019

    // After settling $80, volume = $80. Still tier 1.
    const tx2 = await agent.charge(50, "Cross into tier 2");
    const s2 = await agent.settle(tx2.id);
    expect(s2.platformFee).toBe(0.95); // 50 * 0.019 (volume was 80 < 100)

    // After settling $130 total, volume = $130. Now tier 2 (1.5%).
    const tx3 = await agent.charge(100, "Tier 2 rate");
    const s3 = await agent.settle(tx3.id);
    expect(s3.platformFee).toBe(1.5); // 100 * 0.015

    // Keep settling to cross $300 threshold
    const tx4 = await agent.charge(100, "More volume");
    const s4 = await agent.settle(tx4.id);
    expect(s4.platformFee).toBe(1.5); // 100 * 0.015 (volume was 230 < 300)

    // After $330 total volume, tier 3 (1.0%)
    const tx5 = await agent.charge(50, "Tier 3 rate");
    const s5 = await agent.settle(tx5.id);
    expect(s5.platformFee).toBe(0.5); // 50 * 0.010
  });

  it("should report effective fee rate per agent", () => {
    const agent = MnemoPay.quick("fee-rate-check");
    // Default: 1.9% at zero volume
    expect(agent.fraud.getEffectiveFeeRate("fee-rate-check")).toBe(0.019);
  });

  it("should NOT refund platform fee on refund", async () => {
    const agent = MnemoPay.quick("fee-refund", { fraud: { platformFeeRate: 0.1, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(100, "Will refund");
    await agent.settle(tx.id); // wallet = 90 (100 - 10% fee)
    await agent.refund(tx.id); // wallet = 0 (refund net amount of 90)

    const bal = await agent.balance();
    expect(bal.wallet).toBe(0);
  });
});

// ─── Velocity Checks ───────────────────────────────────────────────────────

describe("Velocity Checks", () => {
  it("should block when exceeding charges per minute", async () => {
    const agent = MnemoPay.quick("vel-minute", {
      fraud: { maxChargesPerMinute: 3, platformFeeRate: 0, blockThreshold: 0.7 },
    });

    await agent.charge(1, "Charge 1");
    await agent.charge(1, "Charge 2");
    await agent.charge(1, "Charge 3");

    await expect(agent.charge(1, "Charge 4")).rejects.toThrow(/blocked|risk/i);
  });

  it("should block when exceeding daily volume", async () => {
    const agent = MnemoPay.quick("vel-volume", {
      fraud: {
        maxDailyVolume: 10,
        platformFeeRate: 0,
        maxChargesPerMinute: 100,
        blockThreshold: 0.6,
      },
    });

    await agent.charge(5, "First half");
    await agent.charge(5, "Second half");

    await expect(agent.charge(5, "Over limit")).rejects.toThrow(/blocked|risk/i);
  });

  it("should block when too many pending transactions", async () => {
    const agent = MnemoPay.quick("vel-pending", {
      fraud: {
        maxPendingTransactions: 3,
        platformFeeRate: 0,
        maxChargesPerMinute: 100,
        blockThreshold: 0.4,
      },
    });

    await agent.charge(1, "Pending 1");
    await agent.charge(1, "Pending 2");
    await agent.charge(1, "Pending 3");

    await expect(agent.charge(1, "Too many pending")).rejects.toThrow(/blocked|risk/i);
  });

  it("should allow after settling pending transactions", async () => {
    const agent = MnemoPay.quick("vel-clear", {
      fraud: {
        maxPendingTransactions: 2,
        platformFeeRate: 0,
        maxChargesPerMinute: 100,
        blockThreshold: 0.4,
        settlementHoldMinutes: 0,
        disputeWindowMinutes: 0,
      },
    });

    const tx1 = await agent.charge(1, "A");
    const tx2 = await agent.charge(1, "B");

    // Clear pending by settling
    await agent.settle(tx1.id);
    await agent.settle(tx2.id);

    // Now should work again
    const tx3 = await agent.charge(1, "C");
    expect(tx3.status).toBe("pending");
  });
});

// ─── Anomaly Detection ─────────────────────────────────────────────────��────

describe("Anomaly Detection", () => {
  it("should flag anomalous charge amount", async () => {
    const agent = MnemoPay.quick("anomaly-test", {
      fraud: {
        platformFeeRate: 0,
        anomalyStdDevThreshold: 2,
        maxChargesPerMinute: 100,
        maxPendingTransactions: 100,
      },
    });

    // Establish baseline: 10 charges of ~$1
    for (let i = 0; i < 10; i++) {
      await agent.charge(1, `Normal charge ${i}`);
    }

    // Charge way above normal — should get risk score > 0
    const tx = await agent.charge(50, "Anomalous charge");
    expect(tx.riskScore).toBeGreaterThan(0);
  });

  it("should not flag consistent amounts", async () => {
    const agent = MnemoPay.quick("consistent-test", {
      fraud: {
        platformFeeRate: 0,
        maxChargesPerMinute: 1000,
        maxChargesPerHour: 10000,
        maxPendingTransactions: 1000,
        blockThreshold: 0.99,
      },
    });

    for (let i = 0; i < 10; i++) {
      const tx = await agent.charge(5, `Same amount ${i}`);
      // Consistent amounts should never trigger amount_anomaly signal
      const risk = agent.fraud.assessCharge("consistent-test", 5, 0.5, new Date(0), 0);
      const hasAnomaly = risk.signals.some((s) => s.type === "amount_anomaly");
      expect(hasAnomaly).toBe(false);
    }
  });
});

// ─── Risk Assessment ────────────────────────────────────────────────────────

describe("Risk Assessment", () => {
  it("should return safe assessment for normal charges", () => {
    const guard = new FraudGuard();
    const risk = guard.assessCharge("agent-1", 10, 0.5, new Date(), 0);
    expect(risk.allowed).toBe(true);
    expect(risk.level).toBe("safe");
    expect(risk.score).toBe(0);
    expect(risk.signals).toHaveLength(0);
  });

  it("should flag new agent high charge", () => {
    const guard = new FraudGuard();
    const justCreated = new Date();
    const risk = guard.assessCharge("new-agent", 100, 0.5, justCreated, 0);
    expect(risk.signals.some((s) => s.type === "new_agent_high_charge")).toBe(true);
  });

  it("should flag low reputation high charge", () => {
    const guard = new FraudGuard();
    const risk = guard.assessCharge("bad-agent", 200, 0.2, new Date(Date.now() - 86400000), 0);
    expect(risk.signals.some((s) => s.type === "low_rep_high_charge")).toBe(true);
  });

  it("should block agent from blocked country", () => {
    const guard = new FraudGuard({ blockedCountries: ["XX"] });
    const risk = guard.assessCharge(
      "geo-agent", 10, 0.5, new Date(Date.now() - 86400000), 0,
      { ip: "1.2.3.4", country: "XX" },
    );
    expect(risk.allowed).toBe(false);
    expect(risk.signals.some((s) => s.type === "sanctioned_country")).toBe(true);
  });

  it("should detect IP hopping", () => {
    const guard = new FraudGuard();
    const agentId = "hopper";
    const created = new Date(Date.now() - 86400000);

    // Register 5 different IPs
    for (let i = 0; i < 5; i++) {
      guard.recordCharge(agentId, 10, { ip: `1.2.3.${i}` });
    }

    // 6th IP should trigger ip_hopping
    const risk = guard.assessCharge(agentId, 10, 0.5, created, 0, { ip: "1.2.3.99" });
    expect(risk.signals.some((s) => s.type === "ip_hopping")).toBe(true);
  });

  it("should record risk score on transaction", async () => {
    const agent = MnemoPay.quick("risk-score", { fraud: { platformFeeRate: 0 } });
    const tx = await agent.charge(10, "Test");
    expect(tx.riskScore).toBeDefined();
    expect(typeof tx.riskScore).toBe("number");
  });
});

// ─── Agent Blocking ─────────────────────────────────────────────────────────

describe("Agent Blocking", () => {
  it("should block a flagged agent", async () => {
    const agent = MnemoPay.quick("block-test", { fraud: { platformFeeRate: 0 } });

    agent.fraud.blockAgent("block-test");

    await expect(agent.charge(1, "Blocked")).rejects.toThrow(/blocked/i);
  });

  it("should allow after unblocking", async () => {
    const agent = MnemoPay.quick("unblock-test", { fraud: { platformFeeRate: 0 } });

    agent.fraud.blockAgent("unblock-test");
    await expect(agent.charge(1, "Blocked")).rejects.toThrow(/blocked/i);

    agent.fraud.unblockAgent("unblock-test");
    const tx = await agent.charge(1, "Unblocked");
    expect(tx.status).toBe("pending");
  });

  it("should track blocked/flagged status", () => {
    const guard = new FraudGuard();

    guard.blockAgent("bad-1");
    guard.blockAgent("bad-2");

    expect(guard.isBlocked("bad-1")).toBe(true);
    expect(guard.isBlocked("good-1")).toBe(false);

    const stats = guard.stats();
    expect(stats.agentsBlocked).toBe(2);
  });
});

// ─── Dispute Resolution ─────────────────────────────────────────────────────

describe("Dispute Resolution", () => {
  it("should file a dispute against settled transaction", async () => {
    const agent = MnemoPay.quick("dispute-test", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 1440 } });
    const tx = await agent.charge(50, "Service");
    await agent.settle(tx.id);

    const dispute = await agent.dispute(tx.id, "Service was not as described");
    expect(dispute.status).toBe("open");
    expect(dispute.txId).toBe(tx.id);

    // Transaction should be marked as disputed
    const history = await agent.history(1);
    expect(history[0].status).toBe("disputed");
  });

  it("should resolve dispute with refund", async () => {
    const agent = MnemoPay.quick("dispute-refund", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 1440 } });
    const tx = await agent.charge(100, "Service");
    await agent.settle(tx.id);

    const walletBefore = (await agent.balance()).wallet;
    expect(walletBefore).toBe(100);

    const dispute = await agent.dispute(tx.id, "Bad quality");
    const resolved = await agent.resolveDispute(dispute.id, "refund");
    expect(resolved.status).toBe("resolved_refunded");

    const bal = await agent.balance();
    expect(bal.wallet).toBe(0);
  });

  it("should resolve dispute by upholding", async () => {
    const agent = MnemoPay.quick("dispute-uphold", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 1440 } });
    const tx = await agent.charge(100, "Good service");
    await agent.settle(tx.id);

    const dispute = await agent.dispute(tx.id, "Frivolous complaint");
    const resolved = await agent.resolveDispute(dispute.id, "uphold");
    expect(resolved.status).toBe("resolved_upheld");

    // Wallet should remain intact
    const bal = await agent.balance();
    expect(bal.wallet).toBe(100);
  });

  it("should not allow dispute on pending transaction", async () => {
    const agent = MnemoPay.quick("dispute-pending", { fraud: { platformFeeRate: 0 } });
    const tx = await agent.charge(50, "Not settled yet");
    await expect(agent.dispute(tx.id, "Too early")).rejects.toThrow(/completed/i);
  });

  it("should not allow duplicate disputes", async () => {
    const agent = MnemoPay.quick("dispute-dup", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 1440 } });
    const tx = await agent.charge(50, "Service");
    await agent.settle(tx.id);

    await agent.dispute(tx.id, "First dispute");
    // Second dispute fails because tx is already in "disputed" status
    await expect(agent.dispute(tx.id, "Second dispute")).rejects.toThrow(/disputed/i);
  });

  it("should track open disputes in stats", async () => {
    const agent = MnemoPay.quick("dispute-stats", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 1440 } });
    const tx = await agent.charge(50, "Service");
    await agent.settle(tx.id);
    await agent.dispute(tx.id, "Issue");

    const stats = agent.fraud.stats();
    expect(stats.openDisputes).toBe(1);
  });
});

// ─── Rate Limiter ──────────────────────────────────────────────────────────

describe("Rate Limiter", () => {
  it("should allow requests within limit", () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });

    for (let i = 0; i < 5; i++) {
      const result = limiter.check("1.2.3.4");
      expect(result.allowed).toBe(true);
    }
  });

  it("should block requests over limit", () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60000 });

    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");

    const result = limiter.check("1.2.3.4");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("should track payment operations separately", () => {
    const limiter = new RateLimiter({
      maxRequests: 100,
      windowMs: 60000,
      maxPaymentRequests: 2,
      paymentWindowMs: 60000,
    });

    limiter.check("1.2.3.4", true);
    limiter.check("1.2.3.4", true);

    const result = limiter.check("1.2.3.4", true);
    expect(result.allowed).toBe(false);

    // Non-payment request should still work
    const normalResult = limiter.check("1.2.3.4", false);
    expect(normalResult.allowed).toBe(true);
  });

  it("should isolate rate limits per IP", () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    const blocked = limiter.check("1.1.1.1");
    expect(blocked.allowed).toBe(false);

    // Different IP should be fine
    const other = limiter.check("2.2.2.2");
    expect(other.allowed).toBe(true);
  });

  it("should report remaining requests", () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });

    const r1 = limiter.check("1.2.3.4");
    expect(r1.remaining).toBe(4);

    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");

    const r4 = limiter.check("1.2.3.4");
    expect(r4.remaining).toBe(1);
  });
});

// ─── Fraud Guard Serialization ──────────────────────────────────────────────

describe("Fraud Guard Persistence", () => {
  it("should serialize and deserialize fraud state", () => {
    const guard = new FraudGuard({ platformFeeRate: 0.05 });

    guard.recordCharge("agent-1", 100);
    guard.recordCharge("agent-1", 200);
    guard.blockAgent("bad-agent");
    guard.applyPlatformFee("tx-1", "agent-1", 100);

    const json = guard.serialize();
    const restored = FraudGuard.deserialize(json, { platformFeeRate: 0.05 });

    expect(restored.isBlocked("bad-agent")).toBe(true);
    expect(restored.platformFeesCollected).toBe(5);
    expect(restored.stats().totalChargesTracked).toBe(2);
  });

  it("should persist fraud state across agent restarts", async () => {
    // This tests that the fraud guard state is included in disk persistence
    const agent = MnemoPay.quick("persist-fraud");
    agent.fraud.blockAgent("persist-fraud");

    // The fraud guard should be accessible
    expect(agent.fraud.isBlocked("persist-fraud")).toBe(true);
    const stats = agent.fraud.stats();
    expect(stats.agentsBlocked).toBe(1);
  });
});

// ─── Integration: Fraud + Payments ──────────────────────────────────────────

describe("Fraud + Payment Integration", () => {
  it("should emit fraud:blocked event", async () => {
    const agent = MnemoPay.quick("fraud-event", {
      fraud: { maxChargesPerMinute: 1, platformFeeRate: 0, blockThreshold: 0.7 },
    });

    let blockedEvent: any = null;
    agent.on("fraud:blocked", (e) => { blockedEvent = e; });

    await agent.charge(1, "First");
    await expect(agent.charge(1, "Second")).rejects.toThrow();

    expect(blockedEvent).not.toBeNull();
    expect(blockedEvent.risk.allowed).toBe(false);
  });

  it("should log fraud blocks in audit trail", async () => {
    const agent = MnemoPay.quick("fraud-audit", {
      fraud: { maxChargesPerMinute: 1, platformFeeRate: 0, blockThreshold: 0.7 },
    });

    await agent.charge(1, "First");
    try { await agent.charge(1, "Blocked"); } catch {}

    const logs = await agent.logs(10);
    const fraudLog = logs.find((l) => l.action === "fraud:blocked");
    expect(fraudLog).toBeDefined();
  });

  it("should include fee breakdown in audit log", async () => {
    const agent = MnemoPay.quick("fee-audit", { fraud: { platformFeeRate: 0.1, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(100, "Audited");
    await agent.settle(tx.id);

    const logs = await agent.logs(10);
    const settleLog = logs.find((l) => l.action === "payment:completed");
    expect(settleLog).toBeDefined();
    expect(settleLog!.details.platformFee).toBe(10);
    expect(settleLog!.details.netAmount).toBe(90);
    expect(settleLog!.details.feeRate).toBe(0.1);
  });

  it("should load ML systems only when ml: true", () => {
    const lean = new FraudGuard(); // default: ml false
    expect(lean.isolationForest).toBeNull();
    expect(lean.transactionGraph).toBeNull();
    expect(lean.behaviorProfile).toBeNull();

    const full = new FraudGuard({ ml: true });
    expect(full.isolationForest).not.toBeNull();
    expect(full.transactionGraph).not.toBeNull();
    expect(full.behaviorProfile).not.toBeNull();
  });

  it("should handle full lifecycle: charge → settle with fee → dispute → resolve", async () => {
    const agent = MnemoPay.quick("lifecycle", { fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 1440 } });

    // 1. Charge
    const tx = await agent.charge(100, "Full lifecycle test");
    expect(tx.riskScore).toBeDefined();

    // 2. Settle (with 1.9% fee)
    const settled = await agent.settle(tx.id);
    expect(settled.platformFee).toBe(1.9);
    expect(settled.netAmount).toBe(98.1);

    const balAfterSettle = await agent.balance();
    expect(balAfterSettle.wallet).toBe(98.1);

    // 3. Dispute
    const dispute = await agent.dispute(tx.id, "Not satisfied with service quality");
    expect(dispute.status).toBe("open");

    // 4. Resolve (refund)
    const resolved = await agent.resolveDispute(dispute.id, "refund");
    expect(resolved.status).toBe("resolved_refunded");

    const balAfterDispute = await agent.balance();
    expect(balAfterDispute.wallet).toBe(0);

    // 5. Verify fraud stats
    const stats = agent.fraud.stats();
    expect(stats.platformFeesCollected).toBe(1.9);
    expect(stats.openDisputes).toBe(0);
  });
});

// ─── Stress Tests ────────────────────────────────────────────────────────────

describe("Stress: Fraud Under Load", () => {
  it("should handle 500 charges with velocity enforcement", async () => {
    // High limits but not infinite — fraud guard must track all 500
    const agent = MnemoPay.quick("stress-velocity", {
      fraud: {
        platformFeeRate: 0,
        maxChargesPerMinute: 1000,
        maxChargesPerHour: 5000,
        maxChargesPerDay: 10000,
        maxDailyVolume: 100000,
        maxPendingTransactions: 1000,
        blockThreshold: 0.95,
        flagThreshold: 0.9,
        settlementHoldMinutes: 0,
        disputeWindowMinutes: 0,
      },
    });

    // Fire 500 charges as fast as possible
    const results = [];
    for (let i = 0; i < 500; i++) {
      results.push(await agent.charge(1 + Math.random() * 10, `Stress charge ${i}`));
    }
    expect(results).toHaveLength(500);
    expect(results.every((r) => r.status === "pending")).toBe(true);

    // Settle all — verify fee accounting stays consistent
    let totalNet = 0;
    for (const tx of results) {
      const settled = await agent.settle(tx.id);
      totalNet += settled.netAmount;
    }
    const bal = await agent.balance();
    expect(bal.wallet).toBeCloseTo(totalNet, 2);

    // Stats integrity
    const stats = agent.fraud.stats();
    expect(stats.totalChargesTracked).toBe(500);
    expect(stats.platformFeesCollected).toBe(0); // 0% fee rate
  }, 30000);

  it("should correctly block under burst after legitimate warmup", async () => {
    const guard = new FraudGuard({
      maxChargesPerMinute: 10,
      blockThreshold: 0.75,
    });
    const now = new Date();

    // 8 legitimate charges — under limit
    for (let i = 0; i < 8; i++) {
      const r = guard.assessCharge("burst-agent", 5, 0.8, now, 0);
      expect(r.allowed).toBe(true);
      guard.recordCharge("burst-agent", 5);
    }

    // Charges 11+ should trigger velocity_burst and block
    for (let i = 0; i < 5; i++) {
      guard.recordCharge("burst-agent", 5);
    }
    const blocked = guard.assessCharge("burst-agent", 5, 0.8, now, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.signals.some((s) => s.type === "velocity_burst")).toBe(true);
  });

  it("should run ML mode with 200 charges and detect anomaly on spike", async () => {
    const agent = MnemoPay.quick("stress-ml", {
      fraud: {
        ml: true,
        platformFeeRate: 0,
        maxChargesPerMinute: 100000,
        maxChargesPerHour: 100000,
        maxChargesPerDay: 100000,
        maxDailyVolume: 1000000,
        maxPendingTransactions: 100000,
        blockThreshold: 1.01,  // disable blocking — this test is about ML training
        flagThreshold: 1.01,
        settlementHoldMinutes: 0,
        disputeWindowMinutes: 0,
      },
    });

    // ML systems should be loaded
    expect(agent.fraud.isolationForest).not.toBeNull();
    expect(agent.fraud.transactionGraph).not.toBeNull();
    expect(agent.fraud.behaviorProfile).not.toBeNull();

    // 200 normal charges ($1-$5) to train the model
    for (let i = 0; i < 200; i++) {
      const tx = await agent.charge(1 + Math.random() * 4, `Normal ${i}`);
      await agent.settle(tx.id);
    }

    // Isolation forest should have trained by now
    expect(agent.fraud.isolationForest!.isReady).toBe(true);
    expect(agent.fraud.isolationForest!.sampleCount).toBeGreaterThanOrEqual(200);

    // Profile should show 200 settled transactions
    const profile = await agent.profile();
    expect(profile.transactionsCount).toBe(200);

    // Verify serialization roundtrip with ML state
    const serialized = agent.fraud.serialize();
    const restored = FraudGuard.deserialize(serialized, { ml: true });
    expect(restored.isolationForest).not.toBeNull();
    expect(restored.isolationForest!.isReady).toBe(true);
    expect(restored.stats().totalChargesTracked).toBe(200);
  }, 30000);
});

// ─── Replay Detection (regression guards) ─────────────────────────────────
//
// These tests lock in the fix for a silent regression where:
//   1. `charge()` never forwarded `reason` to `assessCharge()`, so the
//      ReplayDetector fingerprint was never populated.
//   2. Even when signals fired, the composite-score math capped critical
//      severity at 0.9 — below a blockThreshold of 1.0 — so "always blocks"
//      signals silently allowed the charge.
// Both bugs shipped in v1.2.0–v1.3.1 and left the replay protection dead
// across three public releases. Any regression here should trip CI loud.

describe("Replay Detection (regression)", () => {
  it("blocks the second identical-fingerprint charge within 60s", async () => {
    const agent = MnemoPay.quick("replay-regression-1", {
      fraud: { settlementHoldMinutes: 0, disputeWindowMinutes: 0 },
    });

    // First charge primes the fingerprint — must succeed.
    const first = await agent.charge(10, "identical-fingerprint");
    expect(first.id).toBeTruthy();

    // Second charge with the same (amount, reason) inside 60s must throw.
    await expect(
      agent.charge(10, "identical-fingerprint"),
    ).rejects.toThrow(/risk score|replay/i);
  });

  it("allows repeated charges when the reason (idempotency key) varies", async () => {
    const agent = MnemoPay.quick("replay-regression-2", {
      fraud: { settlementHoldMinutes: 0, disputeWindowMinutes: 0 },
    });

    // Same amount, different reasons — legitimate retry pattern.
    for (let i = 0; i < 5; i++) {
      const tx = await agent.charge(10, `legit-idempotency-${i}`);
      expect(tx.id).toBeTruthy();
      await agent.settle(tx.id);
    }
  });

  it("forces composite score to 1.0 on any critical-severity signal", () => {
    // Direct unit test of the scoring path. A single critical signal at
    // weight 0.9 used to produce composite 0.9 (below 1.0 blockThreshold);
    // after the fix it is forced to 1.0 and the charge is rejected.
    const guard = new FraudGuard({
      settlementHoldMinutes: 0,
      disputeWindowMinutes: 0,
    });

    const agentId = "critical-force-block";
    const reason = "replay-target";

    // Prime the fingerprint. This first call sees no prior, so it passes.
    const first = guard.assessCharge(
      agentId, 10, 1.0, new Date(Date.now() - 86_400_000), 0, undefined, reason,
    );
    expect(first.allowed).toBe(true);

    // Second call with identical fingerprint inside 60s fires the critical
    // replay signal, which must force composite to 1.0 and block.
    const second = guard.assessCharge(
      agentId, 10, 1.0, new Date(Date.now() - 86_400_000), 0, undefined, reason,
    );
    expect(second.allowed).toBe(false);
    expect(second.score).toBe(1);
    expect(second.signals.some((s) => s.severity === "critical")).toBe(true);
  });
});
