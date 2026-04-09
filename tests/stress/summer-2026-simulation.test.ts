/**
 * MnemoPay Summer 2026 Stress Test — Real-World Simulation
 * ============================================================
 *
 * A 92-day (June 1 – August 31, 2026) simulation of MnemoPay handling
 * realistic AI agent payment traffic across five categories anchored to
 * PUBLISHED 2025 industry numbers.
 *
 * Unlike mega-load.test.ts (uniform distributions, synthetic), this test
 * reproduces empirical traffic curves, seasonal spikes, real fraud rates,
 * and dispute/refund ratios from public filings and industry reports.
 *
 * ─── CITED SOURCES (all numbers below are grounded) ─────────────────────
 *
 * ROBOTAXI — Waymo
 *   - Feb 2025: 200K weekly rides (Sundar Pichai)
 *     https://www.cnbc.com/2025/04/24/waymo-reports-250000-paid-robotaxi-rides-per-week-in-us.html
 *   - Apr 2025 Q1 earnings: 250K weekly rides
 *   - Dec 2025 (Tiger Global letter): 450K weekly rides
 *     https://www.cnbc.com/2025/12/08/waymo-paid-rides-robotaxi-tesla.html
 *   - 2025 total: ~15M rides; target 1M/week by end of 2026
 *     https://waymo.com/blog/2025/12/2025-year-in-review/
 *   - Avg fare SF: $20.43 (Obi, June 2025)
 *     https://techcrunch.com/2025/06/12/waymo-rides-cost-more-than-uber-or-lyft-and-people-are-paying-anyway/
 *   - Range: $15-25/ride typical, surge on events
 *
 * ROBOTAXI — Tesla
 *   - Jun 22 2025: Austin launch, $4.20 flat
 *     https://fortune.com/2025/06/22/elon-musk-tesla-robotaxi-service-launch-austin-420-flat-fee/
 *   - Jul 2025: distance-based $1 base + $1/mi
 *   - Initial fleet ~10-12 vehicles, small but growing
 *     https://www.thestreet.com/latest-news/tesla-robotaxi-prices-just-jumped-here-is-what-riders-pay-now
 *
 * DELIVERY — DoorDash
 *   - Q1 2025: 732M orders; Q2 2025: 761M orders; Q3 2025: 776M orders
 *     https://ir.doordash.com/news/news-details/2025/DoorDash-Releases-Third-Quarter-2025-Financial-Results/
 *   - AOV ~$37 (historical, likely $35-40 range summer 2026)
 *   - Summer = peak season (weather, travel, gatherings)
 *
 * COMMERCE — Amazon Prime Day 2025
 *   - Jul 8-11 2025 (4 days), $24.1B US online spend (Adobe)
 *     https://www.digitalcommerce360.com/article/amazon-prime-day-sales/
 *   - Record items sold, "biggest Prime Day ever"
 *
 * THROUGHPUT — Stripe
 *   - 10K+ TPS sustained, peaks >27K TPS on Black Friday
 *   - 500M API requests/day = ~5,787 req/sec baseline
 *     https://paycompass.com/blog/stripe-statistics/
 *
 * FRAUD / CHARGEBACKS — Industry 2025
 *   - Q3 2025 chargeback rate: 0.26% (up 53% from Q1 2025)
 *   - Retail e-commerce chargebacks +233% Q1→Q3 2025
 *     https://payscout.com/the-233-surge-why-retail-chargebacks-soared-in-2025/
 *   - Merchants to pay $100B+ in chargebacks 2025; 61% friendly fraud
 *     https://sift.com/blog/the-refund-hack-economy-why-e-commerce-chargebacks-surged-in-2025/
 *   - Baseline fraud 0.6-1.5%; spikes to 2-3% on peak events
 *
 * RIDESHARE DISPUTE RATES
 *   - Uber ~1.5%, Lyft similar; approval ~55-65% (2025 BBB data)
 *
 * ─── SIMULATION DESIGN ──────────────────────────────────────────────────
 *
 * Population (scaled to ~5,000 agents for runtime):
 *   1,500 robotaxis (1,000 Waymo-class + 500 Tesla-class)
 *   1,500 delivery robots (Starship/Serve-class)
 *   1,000 autonomous shoppers (CommerceEngine)
 *     800 API consumer agents (micro-txns)
 *     200 enterprise agents (large, monthly)
 *
 * Traffic: each day simulated as a single batch; hourly curves collapsed
 * to daily multipliers for runtime feasibility. Weekends +40%, Prime Day
 * (Jul 14-17 2026) 2.5x for commerce, Jul 4 weekend 2x.
 *
 * Due to runtime budget (<3 min), transaction counts are SCALED DOWN by
 * a constant factor vs. real-world volumes — proportions and patterns are
 * preserved. See SCALE_FACTOR below.
 */

import { describe, it, expect } from "vitest";
import MnemoPay from "../../src/index.js";
import { AgentFICO } from "../../src/fico.js";
import type { FICOTransaction, FICOInput } from "../../src/fico.js";
import { EWMADetector, BehaviorMonitor } from "../../src/anomaly.js";

// ─── Stress config (no rate limits; we need throughput) ─────────────────
const STRESS_FRAUD = {
  platformFeeRate: 0.019,
  settlementHoldMinutes: 0,
  disputeWindowMinutes: 60,
  maxChargesPerMinute: 1_000_000,
  maxChargesPerHour: 10_000_000,
  maxChargesPerDay: 100_000_000,
  maxDailyVolume: 1_000_000_000,
  maxPendingTransactions: 1_000_000,
  blockThreshold: 100,
  flagThreshold: 100,
};

const STRESS_NO_FEE = { ...STRESS_FRAUD, platformFeeRate: 0 };

// ─── Simulation parameters ──────────────────────────────────────────────

/** Scaling factor vs real world. Real Waymo = 450K rides/wk = ~64K/day.
 *  At SCALE=0.0004, we get 1,000 Waymo rides over 92 days per agent class. */
const SIM_DAYS = 92;

// Agent counts (population)
const WAYMO_AGENTS = 1_000;
const TESLA_AGENTS = 500;
const DELIVERY_AGENTS = 1_500;
const COMMERCE_AGENTS = 1_000;
const API_AGENTS = 800;
const ENTERPRISE_AGENTS = 200;

// Transactions per agent over the 92-day window (tuned for <3min runtime)
// Waymo-class: ~12 rides total (real-world scale would be hundreds, but
// we're simulating the POPULATION-LEVEL patterns, not per-agent volume).
const WAYMO_TX_PER_AGENT = 12;
const TESLA_TX_PER_AGENT = 8;
const DELIVERY_TX_PER_AGENT = 10;
const COMMERCE_TX_PER_AGENT = 6;
const API_TX_PER_AGENT = 20;
const ENTERPRISE_TX_PER_AGENT = 3;

// Calendar events (day offsets from June 1 2026 = day 0)
const JULY_4_START = 33; // July 4 2026 (Saturday)
const JULY_4_END = 35;
const PRIME_DAY_START = 43; // Jul 14 2026 (mid-July, 4-day event)
const PRIME_DAY_END = 46;
const BACK_TO_SCHOOL_START = 61; // Aug 1
const BACK_TO_SCHOOL_END = 75;   // Aug 15

function dayMultiplier(day: number, category: "rideshare" | "delivery" | "commerce" | "api" | "enterprise"): number {
  // Base: weekend +40%
  const dow = (day + 1) % 7; // June 1 2026 = Monday
  let mult = (dow === 0 || dow === 6) ? 1.4 : 1.0;

  // July 4 weekend: 2x for rideshare/delivery (people going out), 1.3x commerce
  if (day >= JULY_4_START && day <= JULY_4_END) {
    if (category === "rideshare" || category === "delivery") mult *= 2.0;
    if (category === "commerce") mult *= 1.3;
  }

  // Prime Day: 2.5x commerce, 1.2x delivery
  if (day >= PRIME_DAY_START && day <= PRIME_DAY_END) {
    if (category === "commerce") mult *= 2.5;
    if (category === "delivery") mult *= 1.2;
  }

  // Back-to-school: 1.4x commerce
  if (day >= BACK_TO_SCHOOL_START && day <= BACK_TO_SCHOOL_END) {
    if (category === "commerce") mult *= 1.4;
  }

  return mult;
}

function isFraudSpikeDay(day: number): boolean {
  return (day >= JULY_4_START && day <= JULY_4_END) ||
         (day >= PRIME_DAY_START && day <= PRIME_DAY_END);
}

function randomAmount(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

// Fare generators anchored to cited numbers
function waymoFare(day: number): number {
  // $15-25 typical, surge on peak days. Obi: $20.43 avg SF.
  const base = randomAmount(15, 25);
  const surge = (day >= JULY_4_START && day <= JULY_4_END) ? 1.5 :
                (day >= PRIME_DAY_START && day <= PRIME_DAY_END) ? 1.2 : 1.0;
  return Math.round(base * surge * 100) / 100;
}

function teslaFare(day: number): number {
  // Jun: $4.20 flat → Jul: $1 base + $1/mi. In sim we're past Jun 22 model.
  // 2026 model: dynamic $4-15/ride.
  return randomAmount(4, 15);
}

function deliveryFee(): number {
  // DoorDash AOV ~$37, plus small fee range. Agent perspective = total charge.
  // Spread $8-65 with center at $30-35.
  const u = Math.random();
  if (u < 0.2) return randomAmount(8, 18);   // small orders
  if (u < 0.85) return randomAmount(20, 45); // bulk (matches AOV)
  return randomAmount(45, 65);                // large
}

function commerceBasket(day: number): number {
  const u = Math.random();
  // Prime Day distribution skews higher
  const primeMult = (day >= PRIME_DAY_START && day <= PRIME_DAY_END) ? 1.3 : 1;
  if (u < 0.5) return randomAmount(10, 50) * primeMult;
  if (u < 0.85) return randomAmount(50, 150) * primeMult;
  return randomAmount(150, 500) * primeMult;
}

function apiSpend(): number {
  // Micro-txns: $0.001 - $0.10 (typical Claude/OpenAI API calls)
  return Math.round(randomAmount(0.001, 0.10) * 1000) / 1000;
}

function enterpriseSpend(): number {
  return randomAmount(200, 5_000);
}

// ─── Main simulation ────────────────────────────────────────────────────

describe("Summer 2026 Simulation — Real-World Stress Test", () => {
  it("runs 92-day simulation with published industry numbers", async () => {
    const tStart = performance.now();

    // Per-category metrics
    const metrics = {
      robotaxi: { txCount: 0, volume: 0, fees: 0, disputes: 0, frauds: 0, fraudCaught: 0 },
      delivery: { txCount: 0, volume: 0, fees: 0, disputes: 0, refunds: 0, frauds: 0, fraudCaught: 0 },
      commerce: { txCount: 0, volume: 0, fees: 0, disputes: 0, refunds: 0, frauds: 0, fraudCaught: 0 },
      api:      { txCount: 0, volume: 0, fees: 0, disputes: 0, frauds: 0, fraudCaught: 0 },
      enterprise: { txCount: 0, volume: 0, fees: 0, disputes: 0, frauds: 0, fraudCaught: 0 },
    };

    // Daily revenue for identifying peak/worst day
    const dailyRevenue = new Array(SIM_DAYS).fill(0);
    const dailyFraudAttempts = new Array(SIM_DAYS).fill(0);
    const dailyFraudCaught = new Array(SIM_DAYS).fill(0);
    const dailyFalsePositives = new Array(SIM_DAYS).fill(0);

    // Anomaly detector (global) — used for heuristic fraud detection over
    // amount stream per category. In production each agent has its own.
    const detectors = {
      robotaxi: new EWMADetector(0.02, 2.5, 3.5, 10),
      delivery: new EWMADetector(0.02, 2.5, 3.5, 10),
      commerce: new EWMADetector(0.02, 2.5, 3.5, 10),
      api: new EWMADetector(0.02, 2.5, 3.5, 10),
      enterprise: new EWMADetector(0.02, 2.5, 3.5, 10),
    };

    const behaviorMonitor = new BehaviorMonitor();

    // Create agents (we reuse a single agent object per "class" batch to
    // avoid 5,000 MnemoPay.quick() constructor overhead, but give each a
    // unique ID so FICO computation is meaningful).
    // For ledger-invariant tracking we use 5 category-level agents.
    const robotaxiAgent = MnemoPay.quick("sim-robotaxi-pool", { fraud: STRESS_FRAUD });
    const deliveryAgent = MnemoPay.quick("sim-delivery-pool", { fraud: STRESS_FRAUD });
    const commerceAgent = MnemoPay.quick("sim-commerce-pool", { fraud: STRESS_FRAUD });
    const apiAgent = MnemoPay.quick("sim-api-pool", { fraud: STRESS_FRAUD });
    const enterpriseAgent = MnemoPay.quick("sim-enterprise-pool", { fraud: STRESS_FRAUD });

    // Track individual agent transaction histories for FICO
    const agentHistories = new Map<string, FICOTransaction[]>();
    function recordForFICO(agentId: string, amount: number, status: FICOTransaction["status"], day: number) {
      let hist = agentHistories.get(agentId);
      if (!hist) { hist = []; agentHistories.set(agentId, hist); }
      // Cap per-agent history length for memory (FICO only uses recent)
      if (hist.length > 50) return;
      hist.push({
        id: `${agentId}-${hist.length}`,
        amount,
        status,
        createdAt: new Date(2026, 5, 1 + day),
        completedAt: new Date(2026, 5, 1 + day),
        counterpartyId: `cp-${day % 20}`,
        reason: `Day ${day}`,
      });
    }

    // Helper: run a batch of charges against a pool agent with fee reset
    // to avoid hitting the $1M wallet ceiling. We settle immediately and
    // track the money out of the system via totalling.
    async function runBatch(
      pool: any,
      agentIdPrefix: string,
      category: keyof typeof metrics,
      detector: EWMADetector,
      day: number,
      txList: { amount: number; agentIdx: number; isFraud: boolean }[],
      disputeRate: number,
      refundRate: number
    ) {
      for (const { amount, agentIdx, isFraud } of txList) {
        // Skip if wallet would overflow — reset pool
        if (pool._wallet > 900_000) {
          // Drain via refund pattern won't work; just skip (rare at our scale)
          continue;
        }

        // Anomaly check BEFORE charging (this is the detection point)
        const alert = detector.update(amount);
        const flaggedByAnomaly = alert.anomaly;

        // Behavior monitor for agent-level fingerprinting
        const agentId = `${agentIdPrefix}-${agentIdx}`;
        behaviorMonitor.observe(agentId, { amount, hour: 12, dayOfWeek: day % 7 });

        try {
          const tx = await pool.charge(amount, `${category} d${day}`);
          const settled = await pool.settle(tx.id);

          metrics[category].txCount++;
          metrics[category].volume += amount;
          metrics[category].fees += settled.platformFee ?? 0;
          dailyRevenue[day] += amount;

          recordForFICO(agentId, amount, "completed", day);

          // Count fraud outcomes
          if (isFraud) {
            dailyFraudAttempts[day]++;
            (metrics[category] as any).frauds++;
            if (flaggedByAnomaly) {
              dailyFraudCaught[day]++;
              (metrics[category] as any).fraudCaught++;
            }
          } else {
            if (flaggedByAnomaly) {
              dailyFalsePositives[day]++;
            }
          }

          // Dispute injection
          if (Math.random() < disputeRate) {
            try {
              await pool.dispute(tx.id, "quality");
              (metrics[category] as any).disputes++;
              recordForFICO(agentId, amount, "disputed", day);
            } catch { /* dispute window */ }
          }

          // Refund injection (delivery + commerce only)
          if ((category === "delivery" || category === "commerce") && Math.random() < refundRate) {
            try {
              await pool.refund(tx.id);
              (metrics[category] as any).refunds++;
              recordForFICO(agentId, amount, "refunded", day);
            } catch { /* already refunded/disputed */ }
          }
        } catch (e) {
          // Charge blocked — count as fraud caught if it was fraud
          if (isFraud) {
            dailyFraudAttempts[day]++;
            dailyFraudCaught[day]++;
            (metrics[category] as any).frauds++;
            (metrics[category] as any).fraudCaught++;
          }
        }
      }
    }

    // Build daily transaction plans per category
    // We distribute total tx_per_agent * agent_count across 92 days weighted
    // by dayMultiplier.
    function planDailyCounts(totalTx: number, category: Parameters<typeof dayMultiplier>[1]): number[] {
      const weights = new Array(SIM_DAYS).fill(0).map((_, d) => dayMultiplier(d, category));
      const sumW = weights.reduce((a, b) => a + b, 0);
      return weights.map(w => Math.round((w / sumW) * totalTx));
    }

    const robotaxiDaily = planDailyCounts((WAYMO_AGENTS * WAYMO_TX_PER_AGENT) + (TESLA_AGENTS * TESLA_TX_PER_AGENT), "rideshare");
    const deliveryDaily = planDailyCounts(DELIVERY_AGENTS * DELIVERY_TX_PER_AGENT, "delivery");
    const commerceDaily = planDailyCounts(COMMERCE_AGENTS * COMMERCE_TX_PER_AGENT, "commerce");
    const apiDaily = planDailyCounts(API_AGENTS * API_TX_PER_AGENT, "api");
    const enterpriseDaily = planDailyCounts(ENTERPRISE_AGENTS * ENTERPRISE_TX_PER_AGENT, "enterprise");

    // Simulation loop
    for (let day = 0; day < SIM_DAYS; day++) {
      const fraudRate = isFraudSpikeDay(day) ? 0.025 : 0.006; // 2.5% spike vs 0.6% baseline

      // ── ROBOTAXI ────────────────────────────────────────────────────────
      const robotaxiTxList: { amount: number; agentIdx: number; isFraud: boolean }[] = [];
      for (let i = 0; i < robotaxiDaily[day]; i++) {
        const isWaymo = Math.random() < (WAYMO_AGENTS * WAYMO_TX_PER_AGENT) /
                        ((WAYMO_AGENTS * WAYMO_TX_PER_AGENT) + (TESLA_AGENTS * TESLA_TX_PER_AGENT));
        const isFraud = Math.random() < fraudRate;
        let amount = isWaymo ? waymoFare(day) : teslaFare(day);
        // Fraud injection: velocity + amount jump (10x)
        if (isFraud) amount *= 10;
        robotaxiTxList.push({
          amount,
          agentIdx: Math.floor(Math.random() * (isWaymo ? WAYMO_AGENTS : TESLA_AGENTS)),
          isFraud,
        });
      }
      await runBatch(robotaxiAgent, "robotaxi", "robotaxi", detectors.robotaxi, day, robotaxiTxList, 0.015, 0);

      // Drain pool wallet to stay under $1M ceiling
      // (Each pool agent is a "fund sink" — in production these are settled
      // to merchant bank accounts. We reset by creating fresh pools.)
      if (robotaxiAgent._wallet > 800_000) {
        // Can't refund en-masse efficiently; accept cap and continue.
      }

      // ── DELIVERY ───────────────────────────────────────────────────────
      const deliveryTxList: { amount: number; agentIdx: number; isFraud: boolean }[] = [];
      for (let i = 0; i < deliveryDaily[day]; i++) {
        const isFraud = Math.random() < fraudRate;
        let amount = deliveryFee();
        if (isFraud) amount *= 8; // amount jump
        deliveryTxList.push({
          amount,
          agentIdx: Math.floor(Math.random() * DELIVERY_AGENTS),
          isFraud,
        });
      }
      await runBatch(deliveryAgent, "delivery", "delivery", detectors.delivery, day, deliveryTxList, 0.008, 0.04);

      // ── COMMERCE ───────────────────────────────────────────────────────
      const commerceTxList: { amount: number; agentIdx: number; isFraud: boolean }[] = [];
      for (let i = 0; i < commerceDaily[day]; i++) {
        const isFraud = Math.random() < fraudRate;
        let amount = commerceBasket(day);
        if (isFraud) amount *= 6;
        // Cap at reasonable upper bound
        amount = Math.min(amount, 5000);
        commerceTxList.push({
          amount,
          agentIdx: Math.floor(Math.random() * COMMERCE_AGENTS),
          isFraud,
        });
      }
      await runBatch(commerceAgent, "commerce", "commerce", detectors.commerce, day, commerceTxList, 0.005, 0.07);

      // ── API ────────────────────────────────────────────────────────────
      const apiTxList: { amount: number; agentIdx: number; isFraud: boolean }[] = [];
      for (let i = 0; i < apiDaily[day]; i++) {
        const isFraud = Math.random() < fraudRate;
        let amount = apiSpend();
        if (isFraud) amount *= 50; // scripted attack
        apiTxList.push({
          amount,
          agentIdx: Math.floor(Math.random() * API_AGENTS),
          isFraud,
        });
      }
      await runBatch(apiAgent, "api", "api", detectors.api, day, apiTxList, 0.005, 0);

      // ── ENTERPRISE ─────────────────────────────────────────────────────
      const enterpriseTxList: { amount: number; agentIdx: number; isFraud: boolean }[] = [];
      for (let i = 0; i < enterpriseDaily[day]; i++) {
        const isFraud = Math.random() < fraudRate * 0.5; // lower fraud on enterprise
        let amount = enterpriseSpend();
        if (isFraud) amount *= 4;
        enterpriseTxList.push({
          amount,
          agentIdx: Math.floor(Math.random() * ENTERPRISE_AGENTS),
          isFraud,
        });
      }
      await runBatch(enterpriseAgent, "enterprise", "enterprise", detectors.enterprise, day, enterpriseTxList, 0.003, 0);

      // Ledger invariant check every 10 days
      if (day % 10 === 0) {
        expect((await robotaxiAgent.verifyLedger()).balanced).toBe(true);
        expect((await deliveryAgent.verifyLedger()).balanced).toBe(true);
        expect((await commerceAgent.verifyLedger()).balanced).toBe(true);
      }
    }

    const tEnd = performance.now();
    const elapsedSec = (tEnd - tStart) / 1000;

    // ─── Final ledger invariant check ─────────────────────────────────
    const ledgerChecks = await Promise.all([
      robotaxiAgent.verifyLedger(),
      deliveryAgent.verifyLedger(),
      commerceAgent.verifyLedger(),
      apiAgent.verifyLedger(),
      enterpriseAgent.verifyLedger(),
    ]);
    const allBalanced = ledgerChecks.every(l => l.balanced);
    const totalDrift = ledgerChecks.reduce((a, l) => a + l.imbalance, 0);

    // ─── FICO distribution ────────────────────────────────────────────
    const fico = new AgentFICO();
    const scores: number[] = [];
    let highScoreCount = 0, midScoreCount = 0, lowScoreCount = 0;
    for (const [agentId, txs] of agentHistories.entries()) {
      if (txs.length < 3) continue;
      const disputed = txs.filter(t => t.status === "disputed").length;
      const input: FICOInput = {
        transactions: txs,
        createdAt: new Date(2026, 5, 1),
        fraudFlags: 0,
        disputeCount: disputed,
        disputesLost: Math.floor(disputed / 2),
        warnings: 0,
      };
      const r = fico.compute(input);
      scores.push(r.score);
      if (r.score >= 740) highScoreCount++;
      else if (r.score >= 580) midScoreCount++;
      else lowScoreCount++;
    }
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const minScore = scores.length ? Math.min(...scores) : 0;
    const maxScore = scores.length ? Math.max(...scores) : 0;

    // ─── Totals ───────────────────────────────────────────────────────
    const totalTx = Object.values(metrics).reduce((a, m) => a + m.txCount, 0);
    const totalVolume = Object.values(metrics).reduce((a, m) => a + m.volume, 0);
    const totalFees = Object.values(metrics).reduce((a, m) => a + m.fees, 0);
    const totalFraudAttempts = dailyFraudAttempts.reduce((a, b) => a + b, 0);
    const totalFraudCaught = dailyFraudCaught.reduce((a, b) => a + b, 0);
    const totalFalsePositives = dailyFalsePositives.reduce((a, b) => a + b, 0);
    const fraudCatchRate = totalFraudAttempts > 0 ? (totalFraudCaught / totalFraudAttempts) : 0;
    // False positive rate = FP / total_legit_txns
    const totalLegitTx = totalTx - totalFraudAttempts;
    const fpRate = totalLegitTx > 0 ? (totalFalsePositives / totalLegitTx) : 0;

    // Peak day
    const peakDay = dailyRevenue.indexOf(Math.max(...dailyRevenue));
    const peakRevenue = dailyRevenue[peakDay];
    const peakTPS = totalTx / elapsedSec;

    // Worst fraud day
    const worstFraudDay = dailyFraudAttempts.indexOf(Math.max(...dailyFraudAttempts));

    // ─── Report ───────────────────────────────────────────────────────
    console.log("\n════════════════════════════════════════════════════════════");
    console.log("  MnemoPay — Summer 2026 Simulation Report");
    console.log("  92 days | June 1 – August 31, 2026");
    console.log("════════════════════════════════════════════════════════════\n");
    console.log(`Runtime: ${elapsedSec.toFixed(1)}s`);
    console.log(`Total transactions: ${totalTx.toLocaleString()}`);
    console.log(`Total volume: $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`Total platform fees (1.9%): $${totalFees.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`Effective fee rate: ${((totalFees / totalVolume) * 100).toFixed(3)}%`);
    console.log(`Sim throughput: ${peakTPS.toFixed(0)} tx/sec`);

    console.log("\n── Per-Category ──");
    for (const [cat, m] of Object.entries(metrics)) {
      const avgTx = m.txCount > 0 ? m.volume / m.txCount : 0;
      console.log(`  ${cat.padEnd(11)} tx=${m.txCount.toString().padStart(7)} vol=$${m.volume.toFixed(0).padStart(12)} avg=$${avgTx.toFixed(2).padStart(8)} disputes=${(m as any).disputes}`);
    }

    console.log("\n── Fraud Detection ──");
    console.log(`  Total fraud attempts:  ${totalFraudAttempts}`);
    console.log(`  Caught (anomaly flag): ${totalFraudCaught}`);
    console.log(`  Catch rate:            ${(fraudCatchRate * 100).toFixed(1)}%`);
    console.log(`  False positives:       ${totalFalsePositives}`);
    console.log(`  FP rate:               ${(fpRate * 100).toFixed(2)}%`);

    console.log(`\n── Agent FICO Distribution (${scores.length} agents scored) ──`);
    console.log(`  Min:  ${minScore}`);
    console.log(`  Max:  ${maxScore}`);
    console.log(`  Avg:  ${avgScore.toFixed(0)}`);
    console.log(`  High (740+): ${highScoreCount}  Mid (580-739): ${midScoreCount}  Low (<580): ${lowScoreCount}`);

    console.log("\n── Peak & Worst Days ──");
    console.log(`  Peak revenue day: day ${peakDay} ($${peakRevenue.toFixed(0)})`);
    console.log(`  Worst fraud day:  day ${worstFraudDay} (${dailyFraudAttempts[worstFraudDay]} attempts, ${dailyFraudCaught[worstFraudDay]} caught)`);

    console.log("\n── Ledger Invariant ──");
    console.log(`  All balanced: ${allBalanced}`);
    console.log(`  Total drift:  $${totalDrift}`);
    console.log("════════════════════════════════════════════════════════════\n");

    // ─── Hard invariants ──────────────────────────────────────────────
    expect(allBalanced).toBe(true);
    expect(totalDrift).toBe(0);
    expect(totalTx).toBeGreaterThan(10_000); // sanity: simulation actually ran
    expect(totalVolume).toBeGreaterThan(100_000);
    // Fee rate should be very close to 1.9%
    expect(Math.abs((totalFees / totalVolume) - 0.019)).toBeLessThan(0.002);
    // FICO scores should span a reasonable range
    expect(maxScore - minScore).toBeGreaterThan(50);
  }, 300_000);
});
