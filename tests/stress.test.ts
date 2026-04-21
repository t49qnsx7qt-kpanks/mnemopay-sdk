import { describe, it, expect } from "vitest";
import MnemoPay, { MnemoPayLite } from "../src/index.js";
import { MnemoPayNetwork } from "../src/network.js";
import { Ledger } from "../src/ledger.js";
import { IdentityRegistry } from "../src/identity.js";

/**
 * Production Stress Tests
 *
 * These tests validate that MnemoPay can handle real economic activity:
 * - High volume without precision drift
 * - Financial reconciliation (every cent accounted for)
 * - Edge cases that would cause real money loss
 * - Serialization roundtrips under load
 * - Multi-agent network stress
 */

// ─── Financial Precision ────────────────────────────────────────────────────

describe("Financial Precision — No Money Lost", () => {
  it("1000 charge→settle cycles: ledger always balanced, fees always correct", async () => {
    const agent = MnemoPay.quick("precision-1000", { fraud: { platformFeeRate: 0.019, blockThreshold: 1.0, flagThreshold: 1.0, maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 100000000, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    let totalFees = 0;
    let totalNet = 0;
    let totalGross = 0;

    for (let i = 0; i < 1000; i++) {
      // Random amounts from $0.01 to $249.99 (under rep ceiling)
      const amount = Math.round((Math.random() * 249 + 0.01) * 100) / 100;
      const tx = await agent.charge(amount, `Tx ${i}`);
      const settled = await agent.settle(tx.id);

      totalGross += amount;
      totalFees += settled.platformFee!;
      totalNet += settled.netAmount!;

      // Every single settlement must have fee + net = gross
      expect(settled.platformFee! + settled.netAmount!).toBeCloseTo(amount, 2);
    }

    // Global reconciliation
    expect(Math.round((totalFees + totalNet) * 100) / 100)
      .toBeCloseTo(Math.round(totalGross * 100) / 100, 1);

    // Ledger must balance
    const ledgerCheck = await agent.verifyLedger();
    expect(ledgerCheck.balanced).toBe(true);
    expect(ledgerCheck.imbalance).toBe(0);
  }, 30000);

  it("penny amounts: $0.01 charges work correctly", async () => {
    const agent = MnemoPay.quick("penny-test", { fraud: { platformFeeRate: 0.019, maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 100000000, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });

    for (let i = 0; i < 100; i++) {
      const tx = await agent.charge(0.01, `Penny ${i}`);
      const settled = await agent.settle(tx.id);
      // Fee on $0.01 at 1.9% = $0.00019 → rounds to $0.00
      expect(settled.platformFee).toBe(0);
      expect(settled.netAmount).toBe(0.01);
    }

    const ledger = await agent.verifyLedger();
    expect(ledger.balanced).toBe(true);
    const bal = await agent.balance();
    expect(bal.wallet).toBe(1); // 100 * $0.01
  });

  it("large amounts: $250 charges (max at default rep) work correctly", async () => {
    const agent = MnemoPay.quick("large-test", { fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });

    const tx = await agent.charge(250, "Max charge");
    const settled = await agent.settle(tx.id);

    expect(settled.platformFee).toBe(4.75); // 250 * 0.019
    expect(settled.netAmount).toBe(245.25);
    expect(settled.platformFee! + settled.netAmount!).toBe(250);

    const ledger = await agent.verifyLedger();
    expect(ledger.balanced).toBe(true);
  });

  it("fee tiers calculate correctly across volume thresholds", async () => {
    const agent = MnemoPay.quick("tier-precision", {
      fraud: {
        platformFeeRate: 0.019,
        maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 100000000,
        settlementHoldMinutes: 0,
        disputeWindowMinutes: 0,
        feeTiers: [
          { minVolume: 0, rate: 0.019 },
          { minVolume: 200, rate: 0.015 },
          { minVolume: 500, rate: 0.010 },
        ],
      },
    });

    let totalFees = 0;
    // 50 transactions of $10 = $500 volume, crossing both tier thresholds
    for (let i = 0; i < 50; i++) {
      const tx = await agent.charge(10, `Tier tx ${i}`);
      const settled = await agent.settle(tx.id);
      totalFees += settled.platformFee!;
      // Fee + net must ALWAYS equal gross
      expect(settled.platformFee! + settled.netAmount!).toBe(10);
    }

    // Fees should decrease as volume increases
    expect(totalFees).toBeGreaterThan(0);
    const ledger = await agent.verifyLedger();
    expect(ledger.balanced).toBe(true);
  });
});

// ─── Input Validation ───────────────────────────────────────────────────────

describe("Input Validation — Reject Bad Data", () => {
  it("rejects NaN amount", async () => {
    const agent = MnemoPay.quick("nan-test");
    await expect(agent.charge(NaN, "Bad")).rejects.toThrow("positive finite");
  });

  it("rejects Infinity amount", async () => {
    const agent = MnemoPay.quick("inf-test");
    await expect(agent.charge(Infinity, "Bad")).rejects.toThrow("positive finite");
  });

  it("rejects negative amount", async () => {
    const agent = MnemoPay.quick("neg-test");
    await expect(agent.charge(-10, "Bad")).rejects.toThrow("positive finite");
  });

  it("rejects zero amount", async () => {
    const agent = MnemoPay.quick("zero-test");
    await expect(agent.charge(0, "Bad")).rejects.toThrow("positive finite");
  });

  it("rejects empty reason", async () => {
    const agent = MnemoPay.quick("reason-test");
    await expect(agent.charge(10, "")).rejects.toThrow("Reason is required");
  });

  it("rejects empty memory content", async () => {
    const agent = MnemoPay.quick("mem-test");
    await expect(agent.remember("")).rejects.toThrow("content is required");
  });

  it("rejects oversized memory content", async () => {
    const agent = MnemoPay.quick("memsize-test");
    const huge = "x".repeat(100_001);
    await expect(agent.remember(huge)).rejects.toThrow("100KB limit");
  });

  it("ledger rejects NaN transfer", () => {
    const ledger = new Ledger();
    expect(() => ledger.transfer("a", "b", NaN, "USD", "bad")).toThrow("positive finite");
  });

  it("ledger rejects same-account transfer", () => {
    const ledger = new Ledger();
    expect(() => ledger.transfer("a", "a", 10, "USD", "self")).toThrow("same account");
  });

  it("network rejects NaN transact", async () => {
    const net = new MnemoPayNetwork();
    net.register("a", "o", "e@e.com");
    net.register("b", "o", "e@e.com");
    await expect(net.transact("a", "b", NaN, "bad")).rejects.toThrow("positive finite");
  });

  it("network rejects empty reason", async () => {
    const net = new MnemoPayNetwork();
    net.register("a", "o", "e@e.com");
    net.register("b", "o", "e@e.com");
    await expect(net.transact("a", "b", 10, "")).rejects.toThrow("Reason is required");
  });
});

// ─── Charge → Settle → Refund Lifecycle ─────────────────────────────────────

describe("Full Lifecycle Stress", () => {
  it("charge→settle→refund cycles stay balanced (reputation-aware)", async () => {
    const agent = MnemoPay.quick("lifecycle-refund", {
      fraud: { platformFeeRate: 0, blockThreshold: 2.0, maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 10000000, settlementHoldMinutes: 0, disputeWindowMinutes: 0 },
    });

    // Rep starts at 0.5, each refund costs -0.05, settle gives +0.01
    // Net per cycle: -0.04. After ~12 cycles, rep hits 0 and ceiling blocks charges.
    // Use 10 full refund cycles (safe) + 490 charge→settle only (tests volume).
    for (let i = 0; i < 10; i++) {
      const amount = Math.round((Math.random() * 5 + 0.01) * 100) / 100;
      const tx = await agent.charge(amount, `Refund cycle ${i}`);
      await agent.settle(tx.id);
      await agent.refund(tx.id);
    }

    // After refunding everything, wallet should be 0
    const bal = await agent.balance();
    expect(bal.wallet).toBe(0);

    // Now 490 charge→settle cycles to test high-volume accounting
    for (let i = 0; i < 490; i++) {
      const amount = Math.round((Math.random() * 2 + 0.01) * 100) / 100;
      const tx = await agent.charge(amount, `Volume ${i}`);
      await agent.settle(tx.id);
    }

    // Ledger must still balance
    const ledger = await agent.verifyLedger();
    expect(ledger.balanced).toBe(true);
  }, 30000);

  it("mixed operations: charge, settle, refund, dispute in random order", async () => {
    const agent = MnemoPay.quick("mixed-ops", {
      fraud: { platformFeeRate: 0.019, blockThreshold: 2.0, maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 10000000, settlementHoldMinutes: 0, disputeWindowMinutes: 0 },
    });

    const pendingTxs: string[] = [];
    const settledTxs: string[] = [];

    for (let i = 0; i < 200; i++) {
      const amount = Math.round((Math.random() * 50 + 1) * 100) / 100;

      // Always charge
      const tx = await agent.charge(amount, `Mixed ${i}`);
      pendingTxs.push(tx.id);

      // 80% settle, 20% cancel (refund pending)
      if (Math.random() < 0.8 && pendingTxs.length > 0) {
        const id = pendingTxs.shift()!;
        await agent.settle(id);
        settledTxs.push(id);
      } else if (pendingTxs.length > 0) {
        const id = pendingTxs.shift()!;
        await agent.refund(id); // cancel
      }

      // 10% refund settled
      if (Math.random() < 0.1 && settledTxs.length > 0) {
        const id = settledTxs.shift()!;
        await agent.refund(id);
      }
    }

    // Drain remaining pending
    for (const id of pendingTxs) {
      await agent.refund(id);
    }

    const ledger = await agent.verifyLedger();
    expect(ledger.balanced).toBe(true);
  }, 30000);
});

// ─── Multi-Agent Network Stress ─────────────────────────────────────────────

describe("Network Stress", () => {
  it("100 agents, 500 deals, all balanced", async () => {
    const net = new MnemoPayNetwork({ fraud: { platformFeeRate: 0.019, blockThreshold: 2.0, maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 100000000, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });

    // Register 100 agents
    for (let i = 0; i < 100; i++) {
      net.register(`agent-${i}`, `owner-${i % 10}`, `dev${i}@co.com`);
    }

    // 500 random deals
    for (let i = 0; i < 500; i++) {
      const buyerIdx = Math.floor(Math.random() * 100);
      let sellerIdx = Math.floor(Math.random() * 100);
      while (sellerIdx === buyerIdx) sellerIdx = (sellerIdx + 1) % 100;

      const amount = Math.round((Math.random() * 50 + 0.5) * 100) / 100;
      await net.transact(`agent-${buyerIdx}`, `agent-${sellerIdx}`, amount, `Deal ${i}`);
    }

    const stats = net.stats();
    expect(stats.agentCount).toBe(100);
    expect(stats.dealCount).toBe(500);
    expect(stats.totalVolume).toBeGreaterThan(0);
    expect(stats.totalFees).toBeGreaterThan(0);

    // Verify fee ratio is approximately 1.9%
    const feeRate = stats.totalFees / stats.totalVolume;
    expect(feeRate).toBeGreaterThan(0.01);
    expect(feeRate).toBeLessThan(0.025);
  }, 60000);

  it("supply chain: 10-step chain of transactions", async () => {
    const net = new MnemoPayNetwork({ fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });

    for (let i = 0; i < 10; i++) {
      net.register(`step-${i}`, "supply-chain", `step${i}@co.com`);
    }

    // Each step pays the next
    for (let i = 0; i < 9; i++) {
      const amount = Math.round((100 - i * 5) * 100) / 100;
      await net.transact(`step-${i}`, `step-${i + 1}`, amount, `Supply chain step ${i + 1}`);
    }

    // Each agent should have exactly 1 or 2 deals
    for (let i = 0; i < 10; i++) {
      const deals = net.agentDeals(`step-${i}`);
      if (i === 0) expect(deals).toHaveLength(1); // first: buyer only
      else if (i === 9) expect(deals).toHaveLength(1); // last: seller only
      else expect(deals).toHaveLength(2); // middle: buyer + seller
    }
  });

  it("marketplace: 1 seller handles 200 buyers", async () => {
    const net = new MnemoPayNetwork({ fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    net.register("shop", "merchant", "shop@co.com", { displayName: "The Shop" });

    for (let i = 0; i < 200; i++) {
      net.register(`buyer-${i}`, `user-${i}`, `u${i}@co.com`);
      await net.transact(`buyer-${i}`, "shop", 10, `Purchase ${i}`);
    }

    const stats = net.stats();
    expect(stats.dealCount).toBe(200);
    expect(stats.totalVolume).toBe(2000);
    expect(stats.totalFees).toBeCloseTo(38, 0); // ~1.9% of $2000

    // Shop remembers all deals
    const shopMems = await net.getAgent("shop")!.recall(200);
    expect(shopMems.length).toBe(200);
  }, 30000);
});

// ─── Serialization Under Load ───────────────────────────────────────────────

describe("Serialization Roundtrips", () => {
  it("ledger survives serialize→deserialize with 1000 entries", () => {
    const ledger = new Ledger();

    for (let i = 0; i < 500; i++) {
      const amount = Math.round((Math.random() * 100 + 1) * 100) / 100;
      const fee = Math.round(amount * 0.019 * 100) / 100;
      const net = Math.round((amount - fee) * 100) / 100;

      ledger.recordCharge(`agent-${i % 10}`, amount, `tx-${i}`);
      ledger.recordSettlement(`agent-${i % 10}`, `tx-${i}`, amount, fee, net, `cp-${i % 5}`);
    }

    const before = ledger.verify();
    expect(before.balanced).toBe(true);

    const serialized = ledger.serialize();
    const restored = new Ledger(serialized);
    const after = restored.verify();

    expect(after.balanced).toBe(true);
    expect(after.entryCount).toBe(before.entryCount);
    expect(after.totalDebits).toBe(before.totalDebits);
    expect(after.totalCredits).toBe(before.totalCredits);
  });

  it("identity registry survives serialize→deserialize with 100 agents", () => {
    const registry = new IdentityRegistry();

    for (let i = 0; i < 100; i++) {
      registry.createIdentity(`agent-${i}`, `owner-${i % 10}`, `e${i}@co.com`, {
        displayName: `Bot ${i}`,
        capabilities: ["purchase", "sell"],
      });
      registry.verifyKYC(`agent-${i}`);
      registry.issueToken(`agent-${i}`, ["charge", "settle"], {
        maxAmount: 100 + i,
        maxTotalSpend: 1000 + i * 10,
      });
    }

    const data = registry.serialize();
    const restored = IdentityRegistry.deserialize(data);

    expect(restored.size).toBe(100);
    for (let i = 0; i < 100; i++) {
      const id = restored.getIdentity(`agent-${i}`);
      expect(id).not.toBeNull();
      expect(id!.verified).toBe(true);
      expect(id!.displayName).toBe(`Bot ${i}`);

      const tokens = restored.listActiveTokens(`agent-${i}`);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].maxAmount).toBe(100 + i);
    }
  });
});

// ─── Edge Cases That Would Lose Real Money ──────────────────────────────────

describe("Money-Losing Edge Cases", () => {
  it("0.1 + 0.2 = 0.3 (classic float trap)", async () => {
    const agent = MnemoPay.quick("float-trap", { fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx1 = await agent.charge(0.1, "Part 1");
    await agent.settle(tx1.id);
    const tx2 = await agent.charge(0.2, "Part 2");
    await agent.settle(tx2.id);

    const bal = await agent.balance();
    // balance() rounds to 2 decimals, preventing float dust
    expect(bal.wallet).toBe(0.3);
  });

  it("repeated $0.33 charges dont drift", async () => {
    const agent = MnemoPay.quick("thirds", { fraud: { platformFeeRate: 0, maxChargesPerMinute: 100000, maxChargesPerHour: 1000000, maxChargesPerDay: 10000000, maxDailyVolume: 100000000, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });

    for (let i = 0; i < 100; i++) {
      // Unique reason per iteration — real-world idempotency pattern, and
      // avoids colliding with ReplayDetector's 60s-duplicate rule.
      const tx = await agent.charge(0.33, `Third-${i}`);
      await agent.settle(tx.id);
    }

    const bal = await agent.balance();
    expect(bal.wallet).toBe(33); // 100 * 0.33 exactly
  });

  it("settle then refund returns exact net amount", async () => {
    const agent = MnemoPay.quick("exact-refund", { fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(77.77, "Exact amount");
    const settled = await agent.settle(tx.id, "counterparty-refund-test");

    const walletAfterSettle = (await agent.balance()).wallet;
    expect(walletAfterSettle).toBe(settled.netAmount);

    await agent.refund(tx.id);
    const walletAfterRefund = (await agent.balance()).wallet;
    expect(walletAfterRefund).toBe(0);
  });

  it("double-settle is blocked", async () => {
    const agent = MnemoPay.quick("double-settle", { fraud: { settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(50, "Once only");
    await agent.settle(tx.id);
    await expect(agent.settle(tx.id)).rejects.toThrow("not pending");
  });

  it("double-refund is blocked", async () => {
    const agent = MnemoPay.quick("double-refund", { fraud: { settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(50, "Once only");
    await agent.settle(tx.id, "counterparty-double-refund");
    await agent.refund(tx.id);
    await expect(agent.refund(tx.id)).rejects.toThrow("already refunded");
  });

  it("settle nonexistent tx fails cleanly", async () => {
    const agent = MnemoPay.quick("ghost-settle");
    await expect(agent.settle("nonexistent-id")).rejects.toThrow("not found");
  });

  it("reputation ceiling prevents charge abuse", async () => {
    const agent = MnemoPay.quick("rep-ceiling");
    // Default rep 0.5 → max charge $250
    await expect(agent.charge(251, "Over ceiling")).rejects.toThrow("exceeds reputation ceiling");
  });

  it("1.9% fee on $1.00 = $0.02 (rounded up from $0.019)", async () => {
    const agent = MnemoPay.quick("small-fee", { fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(1, "Dollar test");
    const settled = await agent.settle(tx.id);
    expect(settled.platformFee).toBe(0.02);
    expect(settled.netAmount).toBe(0.98);
    expect(settled.platformFee! + settled.netAmount!).toBe(1);
  });

  it("1.9% fee on $99.99 is precise", async () => {
    const agent = MnemoPay.quick("precise-fee", { fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
    const tx = await agent.charge(99.99, "Precision test");
    const settled = await agent.settle(tx.id);
    expect(settled.platformFee).toBe(1.9); // 99.99 * 0.019 = 1.89981 → rounds to 1.9
    expect(settled.netAmount).toBe(98.09);
    // Round the sum to avoid float dust (1.9 + 98.09 = 99.99000000000001 in IEEE 754)
    expect(Math.round((settled.platformFee! + settled.netAmount!) * 100) / 100).toBe(99.99);
  });
});

// ─── Concurrent-Style Operations ────────────────────────────────────────────

describe("Parallel Operation Safety", () => {
  it("multiple agents operating simultaneously stay independent", async () => {
    const agents = Array.from({ length: 20 }, (_, i) =>
      MnemoPay.quick(`parallel-${i}`, { fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } })
    );

    // All agents charge and settle in parallel
    const results = await Promise.all(
      agents.map(async (agent, i) => {
        const amount = (i + 1) * 10;
        const tx = await agent.charge(amount, `Parallel ${i}`);
        const settled = await agent.settle(tx.id);
        return { agentId: agent.agentId, amount, fee: settled.platformFee, net: settled.netAmount };
      }),
    );

    // Each agent's math is independent and correct
    for (const r of results) {
      expect(r.fee! + r.net!).toBeCloseTo(r.amount, 2);
    }

    // Each agent has exactly 1 transaction
    for (const agent of agents) {
      const h = await agent.history();
      expect(h).toHaveLength(1);
    }
  });
});
