/**
 * Agent Credit Score — creditworthiness scoring for AI agents
 *
 * 300-850 range, deterministic given inputs. No randomness, no hidden state.
 * Five components with conventional consumer-credit-scoring weights:
 *
 *   1. Payment History    (35%) — on-time settlements, disputes, late payments
 *   2. Credit Utilization (20%) — spend vs budget cap, sweet spot 10-30%
 *   3. History Length      (15%) — account age weighted by activity density
 *   4. Behavior Diversity  (15%) — counterparties, categories, amount range
 *   5. Fraud Record        (15%) — fraud flags, disputes lost, warnings
 *
 * This is an agent-specific scoring system. It is not a consumer credit
 * report and does not produce FCRA-regulated data. It is not affiliated
 * with, endorsed by, or derived from Fair Isaac Corporation or the FICO mark.
 *
 * The class is exported as `AgentCreditScore`. The legacy name `AgentFICO`
 * is kept as a deprecated alias for backward compatibility and will be
 * removed in a future major version.
 *
 * References:
 *   - General consumer credit-scoring methodology (public domain).
 *   - MnemoPay Master Strategy, Part 3.3 (April 2026).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentCreditTransaction {
  id: string;
  amount: number;
  status: "pending" | "completed" | "refunded" | "disputed" | "expired";
  createdAt: Date;
  completedAt?: Date;
  counterpartyId?: string;
  reason: string;
  riskScore?: number;
}

export interface AgentCreditInput {
  /** All transactions for this agent */
  transactions: AgentCreditTransaction[];
  /** Account creation timestamp */
  createdAt: Date;
  /** Total confirmed fraud flags */
  fraudFlags: number;
  /** Total dispute count (regardless of outcome) */
  disputeCount: number;
  /** Disputes resolved against this agent */
  disputesLost: number;
  /** Warnings issued by fraud system */
  warnings: number;
  /** Budget cap per period (for utilization). Default $5000 */
  budgetCap?: number;
  /** Budget period in days. Default 30 */
  budgetPeriodDays?: number;
  /** Memory count (used for diversity scoring) */
  memoriesCount?: number;
}

export interface AgentCreditComponent {
  /** Raw component score 0-100 */
  score: number;
  /** Weight applied to this component */
  weight: number;
  /** Weighted contribution to final score */
  weighted: number;
  /** Factors that contributed to this score */
  factors: string[];
}

export interface AgentCreditResult {
  /** Final FICO score 300-850 */
  score: number;
  /** Rating: exceptional | very_good | good | fair | poor */
  rating: "exceptional" | "very_good" | "good" | "fair" | "poor";
  /** Trust level for platform decisions */
  trustLevel: "full" | "high" | "standard" | "reduced" | "minimal";
  /** Recommended fee rate based on score */
  feeRate: number;
  /** Whether HITL (human-in-the-loop) approval is recommended */
  requiresHITL: boolean;
  /** Breakdown of all five components */
  components: {
    paymentHistory: AgentCreditComponent;
    creditUtilization: AgentCreditComponent;
    historyLength: AgentCreditComponent;
    behaviorDiversity: AgentCreditComponent;
    fraudRecord: AgentCreditComponent;
  };
  /** Number of transactions used for scoring */
  transactionCount: number;
  /** Whether this score is considered stable (50+ transactions) */
  stable: boolean;
  /** Score confidence 0-1 (increases with more data) */
  confidence: number;
  /** ISO timestamp */
  generatedAt: string;
}

export interface AgentCreditConfig {
  /** Weight for payment history. Default 0.35 */
  w1: number;
  /** Weight for credit utilization. Default 0.20 */
  w2: number;
  /** Weight for history length. Default 0.15 */
  w3: number;
  /** Weight for behavior diversity. Default 0.15 */
  w4: number;
  /** Weight for fraud record. Default 0.15 */
  w5: number;
  /** Minimum transactions for stable score. Default 50 */
  minStableTransactions: number;
  /** Days for full history length score. Default 365 */
  fullHistoryDays: number;
  /** Recency half-life in days for payment history. Default 90 */
  recencyHalfLifeDays: number;
  /** Max expected unique counterparties for diversity. Default 20 */
  maxExpectedCounterparties: number;
  /** Max expected unique categories for diversity. Default 10 */
  maxExpectedCategories: number;
}

export const DEFAULT_AGENT_CREDIT_CONFIG: AgentCreditConfig = {
  w1: 0.35,
  w2: 0.20,
  w3: 0.15,
  w4: 0.15,
  w5: 0.15,
  minStableTransactions: 50,
  fullHistoryDays: 365,
  recencyHalfLifeDays: 90,
  maxExpectedCounterparties: 20,
  maxExpectedCategories: 10,
};

// ─── Score Interpretation ───────────────────────────────────────────────────

const SCORE_TIERS: Array<{
  min: number;
  rating: AgentCreditResult["rating"];
  trustLevel: AgentCreditResult["trustLevel"];
  feeRate: number;
  hitl: boolean;
}> = [
  { min: 800, rating: "exceptional", trustLevel: "full",     feeRate: 0.010, hitl: false },
  { min: 740, rating: "very_good",   trustLevel: "high",     feeRate: 0.013, hitl: false },
  { min: 670, rating: "good",        trustLevel: "standard", feeRate: 0.015, hitl: false },
  { min: 580, rating: "fair",        trustLevel: "reduced",  feeRate: 0.019, hitl: false },
  { min: 300, rating: "poor",        trustLevel: "minimal",  feeRate: 0.025, hitl: true },
];

function interpretScore(score: number): {
  rating: AgentCreditResult["rating"];
  trustLevel: AgentCreditResult["trustLevel"];
  feeRate: number;
  requiresHITL: boolean;
} {
  const clamped = Math.max(300, Math.min(850, score));
  for (const tier of SCORE_TIERS) {
    if (clamped >= tier.min) {
      return { rating: tier.rating, trustLevel: tier.trustLevel, feeRate: tier.feeRate, requiresHITL: tier.hitl };
    }
  }
  // Fallback (should never reach)
  return { rating: "poor", trustLevel: "minimal", feeRate: 0.025, requiresHITL: true };
}

// ─── Agent Credit Score Engine ──────────────────────────────────────────────

export class AgentCreditScore {
  readonly config: AgentCreditConfig;

  constructor(config?: Partial<AgentCreditConfig>) {
    this.config = { ...DEFAULT_AGENT_CREDIT_CONFIG, ...config };

    // Validate weights sum to 1.0 (within floating point tolerance)
    const weightSum = this.config.w1 + this.config.w2 + this.config.w3 + this.config.w4 + this.config.w5;
    if (Math.abs(weightSum - 1.0) > 0.001) {
      throw new Error(`FICO weights must sum to 1.0, got ${weightSum.toFixed(4)}`);
    }

    // Validate all weights are positive
    if (this.config.w1 <= 0 || this.config.w2 <= 0 || this.config.w3 <= 0 || this.config.w4 <= 0 || this.config.w5 <= 0) {
      throw new Error("All FICO weights must be positive");
    }
  }

  /**
   * Compute Agent FICO score from transaction history and agent metadata.
   * Deterministic: same inputs always produce the same score.
   */
  compute(input: AgentCreditInput): AgentCreditResult {
    // Input validation — reject garbage, clamp edge cases
    this._validateInput(input);

    const now = Date.now();
    const txs = input.transactions;

    // 1. Payment History (35%)
    const paymentHistory = this._computePaymentHistory(txs, now);

    // 2. Credit Utilization (20%)
    const creditUtilization = this._computeCreditUtilization(txs, input.budgetCap ?? 5000, input.budgetPeriodDays ?? 30, now);

    // 3. History Length (15%)
    const historyLength = this._computeHistoryLength(input.createdAt, txs, now);

    // 4. Behavior Diversity (15%)
    const behaviorDiversity = this._computeBehaviorDiversity(txs, input.memoriesCount ?? 0);

    // 5. Fraud Record (15%)
    const fraudRecord = this._computeFraudRecord(input.fraudFlags, input.disputeCount, input.disputesLost, input.warnings);

    // Weighted composite: 0-100 scale
    const composite =
      paymentHistory.score * this.config.w1 +
      creditUtilization.score * this.config.w2 +
      historyLength.score * this.config.w3 +
      behaviorDiversity.score * this.config.w4 +
      fraudRecord.score * this.config.w5;

    // Map 0-100 to 300-850 range
    // 0 → 300, 100 → 850
    const rawScore = 300 + (composite / 100) * 550;
    const score = Math.round(Math.max(300, Math.min(850, rawScore)));

    const interpretation = interpretScore(score);
    const totalTx = txs.length;
    const stable = totalTx >= this.config.minStableTransactions;

    // Confidence: logarithmic growth, reaches 0.9 at minStableTransactions
    const confidence = totalTx === 0 ? 0 : Math.min(1, Math.log(1 + totalTx) / Math.log(1 + this.config.minStableTransactions * 2));

    return {
      score,
      ...interpretation,
      components: {
        paymentHistory: { ...paymentHistory, weight: this.config.w1, weighted: Math.round(paymentHistory.score * this.config.w1 * 100) / 100 },
        creditUtilization: { ...creditUtilization, weight: this.config.w2, weighted: Math.round(creditUtilization.score * this.config.w2 * 100) / 100 },
        historyLength: { ...historyLength, weight: this.config.w3, weighted: Math.round(historyLength.score * this.config.w3 * 100) / 100 },
        behaviorDiversity: { ...behaviorDiversity, weight: this.config.w4, weighted: Math.round(behaviorDiversity.score * this.config.w4 * 100) / 100 },
        fraudRecord: { ...fraudRecord, weight: this.config.w5, weighted: Math.round(fraudRecord.score * this.config.w5 * 100) / 100 },
      },
      transactionCount: totalTx,
      stable,
      confidence: Math.round(confidence * 1000) / 1000,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Component 1: Payment History (35%) ──────────────────────────────────

  private _computePaymentHistory(txs: AgentCreditTransaction[], now: number): Omit<AgentCreditComponent, "weight" | "weighted"> {
    const factors: string[] = [];

    if (txs.length === 0) {
      factors.push("No transaction history");
      return { score: 50, factors }; // Neutral starting point
    }

    const completed = txs.filter(t => t.status === "completed");
    const refunded = txs.filter(t => t.status === "refunded");
    const disputed = txs.filter(t => t.status === "disputed");
    const expired = txs.filter(t => t.status === "expired");

    // Base: success rate (completed / total non-pending)
    const nonPending = txs.filter(t => t.status !== "pending");
    const successRate = nonPending.length > 0 ? completed.length / nonPending.length : 0;
    let score = successRate * 100;

    // Recency weighting: recent transactions matter 2x
    // Exponential decay: weight = 2^(-days / halfLife)
    const halfLife = this.config.recencyHalfLifeDays;
    let recentSuccessWeighted = 0;
    let recentTotalWeighted = 0;

    for (const tx of nonPending) {
      const daysAgo = (now - tx.createdAt.getTime()) / 86_400_000;
      const weight = Math.pow(2, -daysAgo / halfLife);
      recentTotalWeighted += weight;
      if (tx.status === "completed") recentSuccessWeighted += weight;
    }

    if (recentTotalWeighted > 0) {
      const recentRate = recentSuccessWeighted / recentTotalWeighted;
      // Blend: 60% recency-weighted, 40% lifetime
      score = (recentRate * 60 + successRate * 40);
    }

    // Penalties
    if (disputed.length > 0) {
      const penalty = Math.min(30, disputed.length * 10);
      score -= penalty;
      factors.push(`${disputed.length} disputed transaction(s) (-${penalty})`);
    }

    if (refunded.length > 0 && nonPending.length > 0) {
      const refundRate = refunded.length / nonPending.length;
      if (refundRate > 0.1) {
        const penalty = Math.min(20, Math.round(refundRate * 40));
        score -= penalty;
        factors.push(`High refund rate ${(refundRate * 100).toFixed(0)}% (-${penalty})`);
      }
    }

    if (expired.length > 0) {
      const penalty = Math.min(15, expired.length * 5);
      score -= penalty;
      factors.push(`${expired.length} expired transaction(s) (-${penalty})`);
    }

    // Bonus for consistent long-term success
    if (completed.length >= 100 && successRate >= 0.95) {
      score = Math.min(100, score + 5);
      factors.push("Excellent long-term track record (+5)");
    }

    if (factors.length === 0) {
      factors.push(`${completed.length}/${nonPending.length} successful (${(successRate * 100).toFixed(0)}%)`);
    }

    return { score: clamp(score), factors };
  }

  // ── Component 2: Credit Utilization (20%) ───────────────────────────────

  private _computeCreditUtilization(txs: AgentCreditTransaction[], budgetCap: number, periodDays: number, now: number): Omit<AgentCreditComponent, "weight" | "weighted"> {
    const factors: string[] = [];

    if (txs.length === 0) {
      factors.push("No spending history");
      return { score: 100, factors }; // No spending = perfect utilization
    }

    // Calculate spend in current period
    const periodStart = now - periodDays * 86_400_000;
    const recentTxs = txs.filter(t => t.createdAt.getTime() >= periodStart && (t.status === "completed" || t.status === "pending"));
    const totalSpend = recentTxs.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const utilization = budgetCap > 0 ? totalSpend / budgetCap : 0;

    // FICO-like utilization curve:
    // 0-10%: 100 (excellent)
    // 10-30%: 90-100 (sweet spot)
    // 30-50%: 70-90 (okay)
    // 50-75%: 40-70 (concerning)
    // 75-100%: 10-40 (bad)
    // >100%: 0-10 (over limit)
    let score: number;
    if (utilization <= 0.10) {
      score = 100;
      factors.push(`Very low utilization (${(utilization * 100).toFixed(0)}%)`);
    } else if (utilization <= 0.30) {
      score = 90 + (0.30 - utilization) / 0.20 * 10;
      factors.push(`Healthy utilization (${(utilization * 100).toFixed(0)}%)`);
    } else if (utilization <= 0.50) {
      score = 70 + (0.50 - utilization) / 0.20 * 20;
      factors.push(`Moderate utilization (${(utilization * 100).toFixed(0)}%)`);
    } else if (utilization <= 0.75) {
      score = 40 + (0.75 - utilization) / 0.25 * 30;
      factors.push(`High utilization (${(utilization * 100).toFixed(0)}%)`);
    } else if (utilization <= 1.0) {
      score = 10 + (1.0 - utilization) / 0.25 * 30;
      factors.push(`Near-limit utilization (${(utilization * 100).toFixed(0)}%)`);
    } else {
      score = Math.max(0, 10 - (utilization - 1.0) * 20);
      factors.push(`Over budget (${(utilization * 100).toFixed(0)}%)`);
    }

    return { score: clamp(score), factors };
  }

  // ── Component 3: History Length (15%) ────────────────────────────────────

  private _computeHistoryLength(createdAt: Date, txs: AgentCreditTransaction[], now: number): Omit<AgentCreditComponent, "weight" | "weighted"> {
    const factors: string[] = [];

    const ageDays = (now - createdAt.getTime()) / 86_400_000;
    if (ageDays <= 0) {
      factors.push("Brand new account");
      return { score: 0, factors };
    }

    // Base: linear to fullHistoryDays, then full marks
    const ageScore = Math.min(100, (ageDays / this.config.fullHistoryDays) * 100);

    // Activity density: active days / total days
    // An account that exists for 365 days but only transacted on 10 days
    // is less trustworthy than one active 200 out of 365 days
    const activeDays = new Set<string>();
    for (const tx of txs) {
      const day = new Date(tx.createdAt).toISOString().slice(0, 10);
      activeDays.add(day);
    }
    const density = Math.min(1, activeDays.size / Math.max(1, ageDays));

    // Blend: 70% age + 30% density
    const score = ageScore * 0.7 + (density * 100) * 0.3;

    if (ageDays < 7) factors.push(`Account is ${Math.floor(ageDays)} day(s) old`);
    else if (ageDays < 30) factors.push(`Account is ${Math.floor(ageDays / 7)} week(s) old`);
    else factors.push(`Account is ${Math.floor(ageDays / 30)} month(s) old`);

    factors.push(`Activity density: ${(density * 100).toFixed(0)}% (${activeDays.size} active days)`);

    return { score: clamp(score), factors };
  }

  // ── Component 4: Behavior Diversity (15%) ───────────────────────────────

  private _computeBehaviorDiversity(txs: AgentCreditTransaction[], memoriesCount: number): Omit<AgentCreditComponent, "weight" | "weighted"> {
    const factors: string[] = [];

    if (txs.length === 0) {
      factors.push("No transaction data");
      return { score: 0, factors };
    }

    // A: Unique counterparties
    const counterparties = new Set<string>();
    for (const tx of txs) {
      if (tx.counterpartyId) counterparties.add(tx.counterpartyId);
    }
    const cpScore = Math.min(1, counterparties.size / this.config.maxExpectedCounterparties);

    // B: Unique categories (extracted from reason field)
    const categories = new Set<string>();
    for (const tx of txs) {
      // Extract category from reason: first word or key phrase
      const cat = extractCategory(tx.reason);
      if (cat) categories.add(cat);
    }
    const catScore = Math.min(1, categories.size / this.config.maxExpectedCategories);

    // C: Amount range diversity (coefficient of variation)
    const amounts = txs.filter(t => t.amount > 0).map(t => t.amount);
    let amountDiversity = 0;
    if (amounts.length >= 2) {
      const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      if (mean > 0) {
        const variance = amounts.reduce((sum, a) => sum + (a - mean) ** 2, 0) / amounts.length;
        const cv = Math.sqrt(variance) / mean;
        // CV of 0.5-1.5 is healthy diversity. Below = too uniform. Above = erratic.
        amountDiversity = cv <= 1.5 ? Math.min(1, cv / 0.8) : Math.max(0, 1 - (cv - 1.5) / 2);
      }
    }

    // D: Memory richness (agents with more memories are more established)
    const memScore = Math.min(1, memoriesCount / 100);

    // Weighted blend of all diversity factors
    const score = (cpScore * 30 + catScore * 25 + amountDiversity * 25 + memScore * 20);

    factors.push(`${counterparties.size} unique counterparties`);
    factors.push(`${categories.size} transaction categories`);
    if (amounts.length >= 2) factors.push(`Amount range: $${Math.min(...amounts).toFixed(2)}-$${Math.max(...amounts).toFixed(2)}`);
    factors.push(`${memoriesCount} memories stored`);

    return { score: clamp(score), factors };
  }

  // ── Component 5: Fraud Record (15%) ─────────────────────────────────────

  private _computeFraudRecord(fraudFlags: number, disputeCount: number, disputesLost: number, warnings: number): Omit<AgentCreditComponent, "weight" | "weighted"> {
    const factors: string[] = [];

    // Start at 100, deduct for each negative event
    // Confirmed fraud = heavy permanent penalty
    // Lost disputes = moderate penalty
    // All disputes (even won) = small penalty (frequent disputes are a signal)
    // Warnings = minor penalty
    let score = 100;

    if (fraudFlags > 0) {
      const penalty = Math.min(80, fraudFlags * 25);
      score -= penalty;
      factors.push(`${fraudFlags} confirmed fraud flag(s) (-${penalty})`);
    }

    if (disputesLost > 0) {
      const penalty = Math.min(40, disputesLost * 15);
      score -= penalty;
      factors.push(`${disputesLost} dispute(s) lost (-${penalty})`);
    }

    if (disputeCount > disputesLost) {
      const wonOrPending = disputeCount - disputesLost;
      const penalty = Math.min(10, wonOrPending * 3);
      score -= penalty;
      factors.push(`${wonOrPending} other dispute(s) (-${penalty})`);
    }

    if (warnings > 0) {
      const penalty = Math.min(15, warnings * 5);
      score -= penalty;
      factors.push(`${warnings} warning(s) (-${penalty})`);
    }

    if (factors.length === 0) {
      factors.push("Clean record");
    }

    return { score: clamp(score), factors };
  }

  // ── Input Validation ────────────────────────────────────────────────────

  private _validateInput(input: AgentCreditInput): void {
    if (!input || typeof input !== "object") {
      throw new Error("AgentCreditInput is required");
    }
    if (!Array.isArray(input.transactions)) {
      throw new Error("AgentCreditInput.transactions must be an array");
    }
    if (!(input.createdAt instanceof Date) || isNaN(input.createdAt.getTime())) {
      throw new Error("AgentCreditInput.createdAt must be a valid Date");
    }
    if (typeof input.fraudFlags !== "number" || !Number.isFinite(input.fraudFlags) || input.fraudFlags < 0) {
      throw new Error("AgentCreditInput.fraudFlags must be a non-negative number");
    }
    if (typeof input.disputeCount !== "number" || !Number.isFinite(input.disputeCount) || input.disputeCount < 0) {
      throw new Error("AgentCreditInput.disputeCount must be a non-negative number");
    }
    if (typeof input.disputesLost !== "number" || !Number.isFinite(input.disputesLost) || input.disputesLost < 0) {
      throw new Error("AgentCreditInput.disputesLost must be a non-negative number");
    }
    if (input.disputesLost > input.disputeCount) {
      throw new Error("AgentCreditInput.disputesLost cannot exceed disputeCount");
    }
    if (typeof input.warnings !== "number" || !Number.isFinite(input.warnings) || input.warnings < 0) {
      throw new Error("AgentCreditInput.warnings must be a non-negative number");
    }
    if (input.budgetCap !== undefined && (typeof input.budgetCap !== "number" || !Number.isFinite(input.budgetCap) || input.budgetCap <= 0)) {
      throw new Error("AgentCreditInput.budgetCap must be a positive number");
    }
    if (input.budgetPeriodDays !== undefined && (typeof input.budgetPeriodDays !== "number" || !Number.isFinite(input.budgetPeriodDays) || input.budgetPeriodDays <= 0)) {
      throw new Error("AgentCreditInput.budgetPeriodDays must be a positive number");
    }
    // Validate individual transactions
    for (const tx of input.transactions) {
      if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount)) {
        throw new Error(`Transaction ${tx.id}: amount must be a finite number`);
      }
      if (!(tx.createdAt instanceof Date) || isNaN(tx.createdAt.getTime())) {
        throw new Error(`Transaction ${tx.id}: createdAt must be a valid Date`);
      }
    }
  }

  /**
   * Serialize FICO result for storage/transmission.
   * Strips non-essential data to reduce payload.
   */
  static serialize(result: AgentCreditResult): string {
    return JSON.stringify(result);
  }

  /**
   * Deserialize with validation — never trust stored scores.
   */
  static deserialize(json: string): AgentCreditResult {
    const data = JSON.parse(json);
    if (typeof data.score !== "number" || data.score < 300 || data.score > 850) {
      throw new Error("Invalid FICO score: must be 300-850");
    }
    // Re-clamp all component scores on load (defense in depth)
    if (data.components && typeof data.components === "object") {
      for (const key of ["paymentHistory", "creditUtilization", "historyLength", "behaviorDiversity", "fraudRecord"] as const) {
        if (data.components[key] && typeof data.components[key].score === "number") {
          data.components[key].score = clamp(data.components[key].score);
        }
      }
    }
    return data;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

function extractCategory(reason: string): string {
  if (!reason || typeof reason !== "string") return "unknown";
  // Normalize and extract first meaningful word
  const lower = reason.toLowerCase().trim();
  // Common transaction categories
  const CATEGORIES = [
    "purchase", "subscription", "service", "api", "compute", "storage",
    "transfer", "fee", "refund", "payment", "invoice", "tip", "donation",
    "license", "hosting", "data", "analysis", "research", "test",
  ];
  for (const cat of CATEGORIES) {
    if (lower.includes(cat)) return cat;
  }
  // Fallback: first word
  const firstWord = lower.split(/\s+/)[0]?.replace(/[^a-z]/g, "");
  return firstWord || "unknown";
}

// ─── Backward-compatibility aliases ─────────────────────────────────────────
// These legacy names are kept for existing users. They will be removed in
// a future major version. New code should use the `AgentCredit*` names.

/** @deprecated Use `AgentCreditScore` instead. */
export const AgentFICO = AgentCreditScore;
/** @deprecated Use `AgentCreditTransaction` instead. */
export type FICOTransaction = AgentCreditTransaction;
/** @deprecated Use `AgentCreditInput` instead. */
export type FICOInput = AgentCreditInput;
/** @deprecated Use `AgentCreditComponent` instead. */
export type FICOComponent = AgentCreditComponent;
/** @deprecated Use `AgentCreditResult` instead. */
export type FICOResult = AgentCreditResult;
/** @deprecated Use `AgentCreditConfig` instead. */
export type FICOConfig = AgentCreditConfig;
/** @deprecated Use `DEFAULT_AGENT_CREDIT_CONFIG` instead. */
export const DEFAULT_FICO_CONFIG = DEFAULT_AGENT_CREDIT_CONFIG;
