/**
 * MnemoPay SDK — 3,000,000 Transaction Stress Test
 *
 * 100 agents × 30,000 ops = 3,000,000 total transactions.
 *
 * Same harness as 1M — pure scale-up to prove invariants (ledger balance,
 * replay detection, p99 latency) at 3M ops.
 *
 * SLOs (must pass):
 *   - totalOps        >= 3,000,000
 *   - ledger balanced (imbalance === 0, every per-agent ledger balanced)
 *   - fraud detection rate >= 0.95 of the injected replay attempts
 *   - throughput      > 200 ops/sec
 *   - p99 latency     < 500 ms
 *
 * Test runtime budget: 120 minutes.
 */

import { describe, it, expect } from "vitest";
import {
  MnemoPay,
  AgentFICO,
  FraudGuard,
  type FraudConfig,
} from "../../src/index.js";

const STRESS_FRAUD: Partial<FraudConfig> = {
  maxChargesPerMinute: 10_000_000,
  maxChargesPerHour:   10_000_000,
  maxChargesPerDay:    10_000_000,
  maxDailyVolume:      1_000_000_000,
  settlementHoldMinutes: 0,
  blockThreshold: 1.0,
  flagThreshold: 0.99,
  maxPendingTransactions: 1_000_000,
  anomalyStdDevThreshold: 1000,
  minAccountAgeMinutes: 0,
  enableGeoCheck: false,
};

const AGENT_COUNT = 100;
const OPS_PER_AGENT = 30_000;
const TOTAL_OPS_TARGET = AGENT_COUNT * OPS_PER_AGENT; // 3,000,000

const W_CHARGE = 0.30;
const W_SETTLE = 0.55;
const W_VERIFY = 0.75;
const W_MEMORY = 0.90;

const ADVERSARIAL_RATE = 0.02;

interface AgentStats {
  id: string;
  charges: number;
  settles: number;
  verifies: number;
  memories: number;
  refunds: number;
  disputes: number;
  errors: number;
  adversarialAttempts: number;
  adversarialBlocked: number;
  latenciesMs: number[];
}

function quantile(sortedMs: number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length));
  return sortedMs[idx]!;
}

describe("MnemoPay SDK — 3M stress", () => {
  it(
    `processes ${TOTAL_OPS_TARGET.toLocaleString()} ops across ${AGENT_COUNT} agents`,
    async () => {
      const agents: { agent: any; stats: AgentStats }[] = [];
      for (let i = 0; i < AGENT_COUNT; i++) {
        const id = `stress3m-agent-${i}`;
        const agent = MnemoPay.quick(id, {
          debug: false,
          fraud: STRESS_FRAUD,
        });
        agents.push({
          agent,
          stats: {
            id,
            charges: 0,
            settles: 0,
            verifies: 0,
            memories: 0,
            refunds: 0,
            disputes: 0,
            errors: 0,
            adversarialAttempts: 0,
            adversarialBlocked: 0,
            latenciesMs: [],
          },
        });
      }

      const scorer = new AgentFICO();
      const startTime = Date.now();

      await Promise.all(
        agents.map(async ({ agent, stats }) => {
          const pendingTxIds: string[] = [];
          const completedTxIds: string[] = [];
          const ADV_REASON = `${stats.id}-replay-fingerprint`;
          const ADV_AMOUNT = 10;

          try {
            const primeTx = await agent.charge(ADV_AMOUNT, ADV_REASON);
            pendingTxIds.push(primeTx.id);
            stats.charges++;
          } catch {
            // non-fatal
          }

          for (let i = 0; i < OPS_PER_AGENT; i++) {
            const roll = Math.random();
            const t0 = performance.now();

            try {
              if (roll < W_CHARGE || pendingTxIds.length === 0) {
                const isAdversarial = Math.random() < ADVERSARIAL_RATE;
                const amount = Number(
                  (isAdversarial
                    ? ADV_AMOUNT
                    : 1 + Math.random() * 30
                  ).toFixed(2),
                );
                const reason = isAdversarial
                  ? ADV_REASON
                  : `${stats.id}-op-${i}`;

                if (isAdversarial) stats.adversarialAttempts++;

                try {
                  const tx = await agent.charge(amount, reason);
                  pendingTxIds.push(tx.id);
                  stats.charges++;
                } catch {
                  if (isAdversarial) stats.adversarialBlocked++;
                  else stats.errors++;
                }
              } else if (roll < W_SETTLE && pendingTxIds.length > 0) {
                const id = pendingTxIds.shift()!;
                try {
                  await agent.settle(id);
                  stats.settles++;
                  completedTxIds.push(id);
                  if (completedTxIds.length > 50) completedTxIds.shift();
                } catch {
                  stats.errors++;
                }
              } else if (roll < W_VERIFY) {
                const history = await agent.history(50);
                const ficoTxs = history.map((tx: any) => ({
                  id: tx.id,
                  amount: tx.amount,
                  status:
                    tx.status === "completed"
                      ? ("completed" as const)
                      : tx.status === "refunded"
                      ? ("refunded" as const)
                      : ("pending" as const),
                  createdAt: new Date(tx.createdAt || Date.now()),
                  completedAt:
                    tx.status === "completed" ? new Date() : undefined,
                  reason: tx.reason || "stress",
                }));
                scorer.compute({
                  transactions: ficoTxs,
                  createdAt: new Date(Date.now() - 86_400_000 * 7),
                  fraudFlags: 0,
                  disputeCount: stats.disputes,
                  disputesLost: 0,
                  warnings: 0,
                  budgetCap: 10_000,
                });
                (agent.fraud as FraudGuard).assessCharge(
                  stats.id,
                  1.0,
                  0.8,
                  new Date(Date.now() - 86_400_000),
                  pendingTxIds.length,
                );
                stats.verifies++;
              } else if (roll < W_MEMORY) {
                if (Math.random() < 0.5) {
                  await agent.remember(
                    `stress-mem-${stats.id}-${i}: amount≈${(Math.random() * 50).toFixed(2)}`,
                    { importance: 0.5, tags: ["stress"] },
                  );
                } else {
                  await agent.recall(5);
                }
                stats.memories++;
              } else {
                if (completedTxIds.length === 0) {
                  if (pendingTxIds.length > 0) {
                    const id = pendingTxIds.shift()!;
                    try {
                      await agent.settle(id);
                      stats.settles++;
                      completedTxIds.push(id);
                    } catch {
                      stats.errors++;
                    }
                  }
                } else if (Math.random() < 0.7) {
                  const id = completedTxIds.shift()!;
                  try {
                    await agent.refund(id);
                    stats.refunds++;
                  } catch {
                    stats.errors++;
                  }
                } else {
                  const id = completedTxIds[completedTxIds.length - 1]!;
                  try {
                    await agent.dispute(id, "stress-synthetic-dispute");
                    stats.disputes++;
                  } catch {
                    stats.errors++;
                  }
                }
              }
            } catch {
              stats.errors++;
            } finally {
              // Sample latencies to cap memory at 3M ops scale.
              if (i % 10 === 0) {
                stats.latenciesMs.push(performance.now() - t0);
              } else {
                // still measure but drop
                performance.now() - t0;
              }
            }
          }

          for (const id of pendingTxIds) {
            try {
              await agent.settle(id);
              stats.settles++;
            } catch {
              stats.errors++;
            }
          }
        }),
      );

      const elapsedMs = Date.now() - startTime;
      const elapsedSec = elapsedMs / 1000;

      let totalCharges = 0;
      let totalSettles = 0;
      let totalVerifies = 0;
      let totalMemories = 0;
      let totalRefunds = 0;
      let totalDisputes = 0;
      let totalErrors = 0;
      let totalAdvAttempts = 0;
      let totalAdvBlocked = 0;
      const allLatencies: number[] = [];

      for (const { stats } of agents) {
        totalCharges += stats.charges;
        totalSettles += stats.settles;
        totalVerifies += stats.verifies;
        totalMemories += stats.memories;
        totalRefunds += stats.refunds;
        totalDisputes += stats.disputes;
        totalErrors += stats.errors;
        totalAdvAttempts += stats.adversarialAttempts;
        totalAdvBlocked += stats.adversarialBlocked;
        for (let i = 0; i < stats.latenciesMs.length; i += 10_000) {
          allLatencies.push(...stats.latenciesMs.slice(i, i + 10_000));
        }
      }

      const totalOps =
        totalCharges +
        totalSettles +
        totalVerifies +
        totalMemories +
        totalRefunds +
        totalDisputes;
      const throughput = Math.round(totalOps / elapsedSec);

      allLatencies.sort((a, b) => a - b);
      const p50 = quantile(allLatencies, 0.50);
      const p95 = quantile(allLatencies, 0.95);
      const p99 = quantile(allLatencies, 0.99);

      const detectionRate =
        totalAdvAttempts === 0 ? 1 : totalAdvBlocked / totalAdvAttempts;

      let globalDebits = 0;
      let globalCredits = 0;
      let perAgentBalanced = 0;
      let perAgentUnbalanced = 0;
      for (const { agent } of agents) {
        const summary = agent.ledger.verify();
        globalDebits += summary.totalDebits;
        globalCredits += summary.totalCredits;
        if (summary.balanced) perAgentBalanced++;
        else perAgentUnbalanced++;
      }
      const imbalance =
        Math.round((globalDebits - globalCredits) * 100) / 100;

      const banner = "═".repeat(72);
      const rule   = "─".repeat(72);
      console.log("\n" + banner);
      console.log("  MNEMOPAY SDK — 3,000,000 TRANSACTION STRESS TEST");
      console.log(banner);
      console.log(`  Agents:            ${AGENT_COUNT}`);
      console.log(`  Ops per agent:     ${OPS_PER_AGENT.toLocaleString()}`);
      console.log(`  Total ops:         ${totalOps.toLocaleString()} / target ${TOTAL_OPS_TARGET.toLocaleString()}`);
      console.log(`  Wall time:         ${elapsedSec.toFixed(1)}s`);
      console.log(`  Throughput:        ${throughput.toLocaleString()} ops/sec`);
      console.log(rule);
      console.log(`  Latency p50:       ${p50.toFixed(2)} ms  (sampled 1:10)`);
      console.log(`  Latency p95:       ${p95.toFixed(2)} ms`);
      console.log(`  Latency p99:       ${p99.toFixed(2)} ms`);
      console.log(rule);
      console.log(`  Charges:           ${totalCharges.toLocaleString()}`);
      console.log(`  Settles:           ${totalSettles.toLocaleString()}`);
      console.log(`  Verifies:          ${totalVerifies.toLocaleString()}`);
      console.log(`  Memory ops:        ${totalMemories.toLocaleString()}`);
      console.log(`  Refunds:           ${totalRefunds.toLocaleString()}`);
      console.log(`  Disputes:          ${totalDisputes.toLocaleString()}`);
      console.log(`  Errors:            ${totalErrors.toLocaleString()}  (${((totalErrors / Math.max(totalOps, 1)) * 100).toFixed(2)}%)`);
      console.log(rule);
      console.log(`  Adversarial txs:   ${totalAdvAttempts.toLocaleString()} injected`);
      console.log(`  Adversarial blocked: ${totalAdvBlocked.toLocaleString()} (${(detectionRate * 100).toFixed(1)}%)`);
      console.log(rule);
      console.log(`  Ledger debits:     $${globalDebits.toFixed(2)}`);
      console.log(`  Ledger credits:    $${globalCredits.toFixed(2)}`);
      console.log(`  Imbalance:         $${imbalance.toFixed(2)} ${imbalance === 0 ? "(OK)" : "(DRIFT!)"}`);
      console.log(`  Balanced agents:   ${perAgentBalanced} / ${AGENT_COUNT}`);
      console.log(banner + "\n");

      expect(totalOps).toBeGreaterThanOrEqual(TOTAL_OPS_TARGET);
      expect(imbalance).toBe(0);
      expect(perAgentUnbalanced).toBe(0);
      expect(detectionRate).toBeGreaterThanOrEqual(0.95);
      expect(throughput).toBeGreaterThan(200);
      expect(p99).toBeLessThan(500);
    },
    120 * 60 * 1000,
  );
});
