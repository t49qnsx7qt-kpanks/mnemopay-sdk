/**
 * MnemoPay Fraud Guard — velocity checks, anomaly detection, risk scoring,
 * dispute resolution, and platform fee collection.
 *
 * Plugs into MnemoPayLite.charge/settle/refund to enforce security rules
 * before any money moves.
 */

import { IsolationForest, TransactionGraph, BehaviorProfile } from "./fraud-ml.js";
import type { CollusionSignal, DriftSignal, BehaviorSnapshot } from "./fraud-ml.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FraudConfig {
  /** Platform fee rate on settle (0.03 = 3%). Default 0.03 */
  platformFeeRate: number;
  /** Max charges per minute per agent. Default 5 */
  maxChargesPerMinute: number;
  /** Max charges per hour per agent. Default 30 */
  maxChargesPerHour: number;
  /** Max charges per day per agent. Default 100 */
  maxChargesPerDay: number;
  /** Max daily charge volume in USD. Default 5000 */
  maxDailyVolume: number;
  /** Standard deviations for amount anomaly detection. Default 2.5 */
  anomalyStdDevThreshold: number;
  /** Minutes before settled funds can be withdrawn (hold period). Default 30 */
  settlementHoldMinutes: number;
  /** Minutes after settlement during which dispute can be filed. Default 1440 (24h) */
  disputeWindowMinutes: number;
  /** Risk score 0-1 above which transaction is blocked. Default 0.75 */
  blockThreshold: number;
  /** Risk score 0-1 above which transaction is flagged. Default 0.45 */
  flagThreshold: number;
  /** Minimum account age in minutes before charges are allowed. Default 0 */
  minAccountAgeMinutes: number;
  /** Max pending (unsettled) transactions at once. Default 10 */
  maxPendingTransactions: number;
  /** Enable IP/geo tracking (MCP server only). Default true */
  enableGeoCheck: boolean;
  /** Blocked country ISO codes. Default empty */
  blockedCountries: string[];
  /** Enable ML fraud detection (Isolation Forest, graph analysis, behavioral fingerprinting). Default false */
  ml: boolean;
}

export const DEFAULT_FRAUD_CONFIG: FraudConfig = {
  platformFeeRate: 0.03,
  maxChargesPerMinute: 5,
  maxChargesPerHour: 30,
  maxChargesPerDay: 100,
  maxDailyVolume: 5000,
  anomalyStdDevThreshold: 2.5,
  settlementHoldMinutes: 30,
  disputeWindowMinutes: 1440,
  blockThreshold: 0.75,
  flagThreshold: 0.45,
  minAccountAgeMinutes: 0,
  maxPendingTransactions: 10,
  enableGeoCheck: true,
  blockedCountries: [],
  ml: false,
};

export interface FraudSignal {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  /** Risk weight 0-1 */
  weight: number;
}

export interface RiskAssessment {
  /** Composite risk score 0-1 */
  score: number;
  /** Risk level derived from score */
  level: "safe" | "low" | "medium" | "high" | "blocked";
  /** Detected fraud signals */
  signals: FraudSignal[];
  /** Whether the action should proceed */
  allowed: boolean;
  /** Human-readable reason if blocked */
  reason?: string;
  /** Whether flagged for review (allowed but suspicious) */
  flagged: boolean;
}

export interface Dispute {
  id: string;
  txId: string;
  agentId: string;
  reason: string;
  status: "open" | "resolved_refunded" | "resolved_upheld" | "expired";
  createdAt: Date;
  resolvedAt?: Date;
  evidence: string[];
}

export interface PlatformFeeRecord {
  txId: string;
  agentId: string;
  grossAmount: number;
  feeRate: number;
  feeAmount: number;
  netAmount: number;
  createdAt: Date;
}

/** Internal record of a charge event for velocity tracking */
interface ChargeEvent {
  timestamp: number;
  amount: number;
  agentId: string;
}

/** IP/geo context passed from MCP server */
export interface RequestContext {
  ip?: string;
  country?: string;
  userAgent?: string;
  sessionId?: string;
}

// ─── Fraud Guard ────────────────────────────────────────────────────────────

export class FraudGuard {
  readonly config: FraudConfig;

  /** Sliding window of recent charges per agent */
  private chargeHistory: Map<string, ChargeEvent[]> = new Map();
  /** Running stats per agent: sum, sumSq, count for online std-dev */
  private agentStats: Map<string, { sum: number; sumSq: number; count: number }> = new Map();
  /** Active disputes */
  private disputes: Map<string, Dispute> = new Map();
  /** Platform fee ledger */
  private feeLedger: PlatformFeeRecord[] = [];
  /** Total platform fees collected */
  private _platformFeesCollected: number = 0;
  /** Known IPs per agent for consistency checks */
  private agentIps: Map<string, Set<string>> = new Map();
  /** Flagged agents (soft block — allowed but monitored) */
  private flaggedAgents: Set<string> = new Set();
  /** Hard-blocked agents */
  private blockedAgents: Set<string> = new Set();
  /** ML anomaly detection — only loaded when ml: true */
  readonly isolationForest: IsolationForest | null;
  /** Transaction graph — only loaded when ml: true */
  readonly transactionGraph: TransactionGraph | null;
  /** Behavioral fingerprinting — only loaded when ml: true */
  readonly behaviorProfile: BehaviorProfile | null;

  constructor(config?: Partial<FraudConfig>) {
    this.config = { ...DEFAULT_FRAUD_CONFIG, ...config };
    if (this.config.ml) {
      this.isolationForest = new IsolationForest();
      this.transactionGraph = new TransactionGraph();
      this.behaviorProfile = new BehaviorProfile();
    } else {
      this.isolationForest = null;
      this.transactionGraph = null;
      this.behaviorProfile = null;
    }
  }

  // ── Risk Assessment ────────────────────────────────────────────────────

  /**
   * Assess risk for a charge attempt. Returns a RiskAssessment
   * that includes whether the charge should proceed.
   */
  assessCharge(
    agentId: string,
    amount: number,
    reputation: number,
    accountCreatedAt: Date,
    pendingCount: number,
    ctx?: RequestContext,
  ): RiskAssessment {
    const signals: FraudSignal[] = [];

    // 0. Hard block check
    if (this.blockedAgents.has(agentId)) {
      return {
        score: 1.0,
        level: "blocked",
        signals: [{ type: "agent_blocked", severity: "critical", description: "Agent is blocked", weight: 1.0 }],
        allowed: false,
        reason: "Agent has been blocked due to fraud violations",
        flagged: false,
      };
    }

    // 1. Velocity checks
    const now = Date.now();
    const history = this.chargeHistory.get(agentId) || [];

    const chargesLastMinute = history.filter((e) => now - e.timestamp < 60_000).length;
    if (chargesLastMinute >= this.config.maxChargesPerMinute) {
      signals.push({
        type: "velocity_burst",
        severity: "high",
        description: `${chargesLastMinute} charges in last minute (limit: ${this.config.maxChargesPerMinute})`,
        weight: 0.8,
      });
    }

    const chargesLastHour = history.filter((e) => now - e.timestamp < 3_600_000).length;
    if (chargesLastHour >= this.config.maxChargesPerHour) {
      signals.push({
        type: "velocity_hourly",
        severity: "high",
        description: `${chargesLastHour} charges in last hour (limit: ${this.config.maxChargesPerHour})`,
        weight: 0.7,
      });
    }

    const chargesLastDay = history.filter((e) => now - e.timestamp < 86_400_000).length;
    if (chargesLastDay >= this.config.maxChargesPerDay) {
      signals.push({
        type: "velocity_daily",
        severity: "medium",
        description: `${chargesLastDay} charges in last 24h (limit: ${this.config.maxChargesPerDay})`,
        weight: 0.6,
      });
    }

    // 2. Daily volume check
    const dayVolume = history
      .filter((e) => now - e.timestamp < 86_400_000)
      .reduce((sum, e) => sum + e.amount, 0);
    if (dayVolume + amount > this.config.maxDailyVolume) {
      signals.push({
        type: "volume_limit",
        severity: "high",
        description: `Daily volume $${(dayVolume + amount).toFixed(2)} exceeds limit $${this.config.maxDailyVolume}`,
        weight: 0.7,
      });
    }

    // 3. Amount anomaly detection
    const stats = this.agentStats.get(agentId);

    // ML Isolation Forest (only when ml: true)
    if (this.isolationForest) {
      const iforestScore = this.isolationForest.score([
        amount, new Date().getHours(), 0, history.filter((e) => now - e.timestamp < 600_000).length,
        stats ? stats.sum / Math.max(stats.count, 1) : 0, 0, pendingCount, reputation,
      ]);
      if (iforestScore >= 0 && iforestScore > 0.65) {
        signals.push({
          type: "ml_anomaly",
          severity: iforestScore > 0.8 ? "high" : "medium",
          description: `ML anomaly score ${iforestScore.toFixed(2)} (Isolation Forest)`,
          weight: Math.min(iforestScore * 0.9, 0.85),
        });
      }
    }

    // z-score (always runs — lightweight, no ML dependency)
    if (stats && stats.count >= 5) {
      const mean = stats.sum / stats.count;
      const variance = stats.sumSq / stats.count - mean * mean;
      const stdDev = Math.sqrt(Math.max(variance, 0));
      if (stdDev > 0) {
        const zScore = (amount - mean) / stdDev;
        if (zScore > this.config.anomalyStdDevThreshold) {
          signals.push({
            type: "amount_anomaly",
            severity: "medium",
            description: `Amount $${amount.toFixed(2)} is ${zScore.toFixed(1)} std devs above mean $${mean.toFixed(2)}`,
            weight: Math.min(0.3 + zScore * 0.1, 0.8),
          });
        }
      }
    }

    // 3b. Behavioral drift detection (only when ml: true)
    if (this.behaviorProfile) {
      const driftSignals = this.behaviorProfile.detectDrift(agentId, amount);
      for (const ds of driftSignals) {
        signals.push({
          type: `drift:${ds.type}`,
          severity: ds.severity > 0.6 ? "high" : ds.severity > 0.3 ? "medium" : "low",
          description: ds.description,
          weight: ds.severity,
        });
      }
    }

    // 4. New agent high charge
    const accountAgeMinutes = (now - accountCreatedAt.getTime()) / 60_000;
    if (accountAgeMinutes < 60 && amount > 50) {
      signals.push({
        type: "new_agent_high_charge",
        severity: "medium",
        description: `Agent is ${Math.round(accountAgeMinutes)}min old, charging $${amount.toFixed(2)}`,
        weight: 0.4,
      });
    }

    // 5. Minimum account age
    if (accountAgeMinutes < this.config.minAccountAgeMinutes) {
      signals.push({
        type: "account_too_new",
        severity: "high",
        description: `Account age ${Math.round(accountAgeMinutes)}min < required ${this.config.minAccountAgeMinutes}min`,
        weight: 0.9,
      });
    }

    // 6. Too many pending transactions
    if (pendingCount >= this.config.maxPendingTransactions) {
      signals.push({
        type: "pending_overflow",
        severity: "medium",
        description: `${pendingCount} pending transactions (limit: ${this.config.maxPendingTransactions})`,
        weight: 0.5,
      });
    }

    // 7. Low reputation + high amount
    if (reputation < 0.3 && amount > 100) {
      signals.push({
        type: "low_rep_high_charge",
        severity: "high",
        description: `Low reputation (${reputation.toFixed(2)}) attempting $${amount.toFixed(2)} charge`,
        weight: 0.6,
      });
    }

    // 8. Escalation pattern — progressively increasing amounts
    const recentAmounts = history
      .filter((e) => now - e.timestamp < 3_600_000)
      .map((e) => e.amount);
    if (recentAmounts.length >= 3) {
      let escalating = true;
      for (let i = 1; i < recentAmounts.length; i++) {
        if (recentAmounts[i] <= recentAmounts[i - 1]) {
          escalating = false;
          break;
        }
      }
      if (escalating && amount > recentAmounts[recentAmounts.length - 1]) {
        signals.push({
          type: "escalation_pattern",
          severity: "medium",
          description: `Escalating charge pattern detected: ${recentAmounts.map((a) => `$${a.toFixed(0)}`).join(" → ")} → $${amount.toFixed(0)}`,
          weight: 0.4,
        });
      }
    }

    // 9. IP/geo checks
    if (ctx?.country && this.config.blockedCountries.includes(ctx.country)) {
      signals.push({
        type: "blocked_country",
        severity: "critical",
        description: `Request from blocked country: ${ctx.country}`,
        weight: 0.9,
      });
    }

    if (ctx?.ip) {
      const knownIps = this.agentIps.get(agentId);
      if (knownIps && knownIps.size > 0 && !knownIps.has(ctx.ip)) {
        // New IP for this agent
        if (knownIps.size >= 5) {
          signals.push({
            type: "ip_hopping",
            severity: "medium",
            description: `Agent using ${knownIps.size + 1}th unique IP`,
            weight: 0.3,
          });
        }
      }
    }

    // 10. Rapid charge-settle cycle detection
    // (checked from history: if last N transactions were all settled within seconds)
    const recentCompleted = history
      .filter((e) => now - e.timestamp < 600_000) // last 10 min
      .length;
    if (recentCompleted >= 5 && chargesLastMinute >= 3) {
      signals.push({
        type: "rapid_cycle",
        severity: "high",
        description: "Rapid charge-settle cycling detected",
        weight: 0.6,
      });
    }

    // ── Compute composite score ─────────────────────────────────────────
    const score = signals.length === 0
      ? 0
      : Math.min(
          signals.reduce((sum, s) => sum + s.weight, 0) /
            Math.max(signals.length, 1),
          // Also take the max single signal weight — one critical signal can block
          Math.max(...signals.map((s) => s.weight)),
          1.0,
        );

    // Use maximum of weighted average and max single signal
    const compositeScore = Math.min(
      Math.max(
        signals.reduce((sum, s) => sum + s.weight, 0) / Math.max(signals.length * 0.7, 1),
        signals.length > 0 ? Math.max(...signals.map((s) => s.weight)) * 0.85 : 0,
      ),
      1.0,
    );

    const level = compositeScore >= this.config.blockThreshold
      ? "blocked"
      : compositeScore >= this.config.flagThreshold
        ? "high"
        : compositeScore >= 0.25
          ? "medium"
          : compositeScore > 0.1
            ? "low"
            : "safe";

    const allowed = compositeScore < this.config.blockThreshold;
    const flagged = compositeScore >= this.config.flagThreshold && allowed;

    if (flagged) this.flaggedAgents.add(agentId);

    return {
      score: Math.round(compositeScore * 100) / 100,
      level,
      signals,
      allowed,
      reason: allowed ? undefined : `Blocked: risk score ${compositeScore.toFixed(2)} exceeds threshold ${this.config.blockThreshold}`,
      flagged,
    };
  }

  /**
   * Record a successful charge for velocity tracking and stats.
   * Call AFTER charge is approved.
   */
  recordCharge(agentId: string, amount: number, ctx?: RequestContext): void {
    const now = Date.now();

    // Update charge history
    const history = this.chargeHistory.get(agentId) || [];
    history.push({ timestamp: now, amount, agentId });
    // Keep only last 48 hours
    const cutoff = now - 48 * 3_600_000;
    const filtered = history.filter((e) => e.timestamp > cutoff);
    this.chargeHistory.set(agentId, filtered);

    // Update running statistics (Welford's online algorithm)
    const stats = this.agentStats.get(agentId) || { sum: 0, sumSq: 0, count: 0 };
    stats.sum += amount;
    stats.sumSq += amount * amount;
    stats.count++;
    this.agentStats.set(agentId, stats);

    // Track IP
    if (ctx?.ip) {
      const ips = this.agentIps.get(agentId) || new Set();
      ips.add(ctx.ip);
      this.agentIps.set(agentId, ips);
    }

    // Feed ML systems (only when ml: true)
    if (this.isolationForest) {
      const recent10 = filtered.filter((e) => now - e.timestamp < 600_000);
      const avgRecent = recent10.length > 0 ? recent10.reduce((s, e) => s + e.amount, 0) / recent10.length : 0;
      const stdRecent = recent10.length > 1
        ? Math.sqrt(recent10.reduce((s, e) => s + (e.amount - avgRecent) ** 2, 0) / recent10.length)
        : 0;
      this.isolationForest.addSample([
        amount, new Date().getHours(), 0, recent10.length,
        avgRecent, stdRecent, 0, 0.5,
      ]);
    }
    if (this.behaviorProfile) this.behaviorProfile.recordEvent(agentId, "charge", amount);
    if (this.transactionGraph && ctx?.ip) this.transactionGraph.registerAgent(agentId, ctx.ip);
  }

  /** Record a non-payment event (memory ops) for behavioral profiling */
  recordEvent(agentId: string, type: "remember" | "recall" | "settle" | "refund"): void {
    if (this.behaviorProfile) this.behaviorProfile.recordEvent(agentId, type);
  }

  /** Record a transaction between agents for graph analysis */
  recordTransfer(fromAgent: string, toAgent: string, amount: number, txId: string): void {
    if (this.transactionGraph) this.transactionGraph.addTransaction(fromAgent, toAgent, amount, txId);
  }

  /** Run collusion detection across the transaction graph (requires ml: true) */
  detectCollusion(): CollusionSignal[] {
    if (!this.transactionGraph) return [];
    return this.transactionGraph.detectAll();
  }

  /** Get an agent's behavioral baseline (requires ml: true) */
  getAgentBaseline(agentId: string): BehaviorSnapshot | undefined {
    if (!this.behaviorProfile) return undefined;
    return this.behaviorProfile.getBaseline(agentId);
  }

  // ── Platform Fee ──────────────────────────────────────────────────────

  /**
   * Calculate and record platform fee for a settlement.
   * Returns { grossAmount, feeAmount, netAmount }.
   */
  applyPlatformFee(txId: string, agentId: string, grossAmount: number): PlatformFeeRecord {
    const feeAmount = Math.round(grossAmount * this.config.platformFeeRate * 100) / 100;
    const netAmount = Math.round((grossAmount - feeAmount) * 100) / 100;

    const record: PlatformFeeRecord = {
      txId,
      agentId,
      grossAmount,
      feeRate: this.config.platformFeeRate,
      feeAmount,
      netAmount,
      createdAt: new Date(),
    };

    this.feeLedger.push(record);
    this._platformFeesCollected += feeAmount;

    return record;
  }

  /** Total platform fees collected */
  get platformFeesCollected(): number {
    return Math.round(this._platformFeesCollected * 100) / 100;
  }

  /** Get platform fee ledger */
  getFeeLedger(limit = 50): PlatformFeeRecord[] {
    return this.feeLedger.slice(-limit);
  }

  // ── Dispute Resolution ────────────────────────────────────────────────

  /**
   * File a dispute against a settled transaction.
   * Returns the dispute if within the dispute window.
   */
  fileDispute(
    txId: string,
    agentId: string,
    reason: string,
    txCompletedAt: Date,
    evidence?: string[],
  ): Dispute {
    // Check dispute window
    const minutesSinceSettlement = (Date.now() - txCompletedAt.getTime()) / 60_000;
    if (minutesSinceSettlement > this.config.disputeWindowMinutes) {
      throw new Error(
        `Dispute window expired. Transaction settled ${Math.round(minutesSinceSettlement)}min ago ` +
        `(window: ${this.config.disputeWindowMinutes}min)`,
      );
    }

    // Check for duplicate dispute
    for (const d of this.disputes.values()) {
      if (d.txId === txId && d.status === "open") {
        throw new Error(`Active dispute already exists for transaction ${txId}`);
      }
    }

    const dispute: Dispute = {
      id: crypto.randomUUID(),
      txId,
      agentId,
      reason,
      status: "open",
      createdAt: new Date(),
      evidence: evidence || [],
    };

    this.disputes.set(dispute.id, dispute);
    return dispute;
  }

  /**
   * Resolve a dispute. Either refund the transaction or uphold it.
   */
  resolveDispute(disputeId: string, outcome: "refund" | "uphold"): Dispute {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) throw new Error(`Dispute ${disputeId} not found`);
    if (dispute.status !== "open") throw new Error(`Dispute ${disputeId} is already ${dispute.status}`);

    dispute.status = outcome === "refund" ? "resolved_refunded" : "resolved_upheld";
    dispute.resolvedAt = new Date();

    // If refund outcome, flag agent for review
    if (outcome === "refund") {
      this.flaggedAgents.add(dispute.agentId);
    }

    return dispute;
  }

  /** Get all disputes for an agent */
  getDisputes(agentId?: string): Dispute[] {
    const all = Array.from(this.disputes.values());
    if (agentId) return all.filter((d) => d.agentId === agentId);
    return all;
  }

  /** Get a specific dispute */
  getDispute(disputeId: string): Dispute | undefined {
    return this.disputes.get(disputeId);
  }

  /**
   * Check if a transaction is within the settlement hold period.
   * Returns true if the transaction is still held and cannot be withdrawn.
   */
  isWithinHoldPeriod(settledAt: Date): boolean {
    const minutesSince = (Date.now() - settledAt.getTime()) / 60_000;
    return minutesSince < this.config.settlementHoldMinutes;
  }

  /** Check if a transaction is still within the dispute window */
  isWithinDisputeWindow(settledAt: Date): boolean {
    const minutesSince = (Date.now() - settledAt.getTime()) / 60_000;
    return minutesSince < this.config.disputeWindowMinutes;
  }

  // ── Agent Management ──────────────────────────────────────────────────

  /** Block an agent from making any charges */
  blockAgent(agentId: string): void {
    this.blockedAgents.add(agentId);
  }

  /** Unblock a previously blocked agent */
  unblockAgent(agentId: string): void {
    this.blockedAgents.delete(agentId);
  }

  /** Check if an agent is blocked */
  isBlocked(agentId: string): boolean {
    return this.blockedAgents.has(agentId);
  }

  /** Check if an agent is flagged */
  isFlagged(agentId: string): boolean {
    return this.flaggedAgents.has(agentId);
  }

  /** Get fraud stats summary */
  stats(): {
    totalChargesTracked: number;
    agentsTracked: number;
    agentsFlagged: number;
    agentsBlocked: number;
    openDisputes: number;
    platformFeesCollected: number;
  } {
    return {
      totalChargesTracked: Array.from(this.chargeHistory.values()).reduce((sum, h) => sum + h.length, 0),
      agentsTracked: this.chargeHistory.size,
      agentsFlagged: this.flaggedAgents.size,
      agentsBlocked: this.blockedAgents.size,
      openDisputes: Array.from(this.disputes.values()).filter((d) => d.status === "open").length,
      platformFeesCollected: this.platformFeesCollected,
    };
  }

  // ── Serialization (for persistence) ───────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      chargeHistory: Array.from(this.chargeHistory.entries()),
      agentStats: Array.from(this.agentStats.entries()),
      disputes: Array.from(this.disputes.entries()).map(([k, v]) => [k, { ...v, createdAt: v.createdAt.toISOString(), resolvedAt: v.resolvedAt?.toISOString() }]),
      feeLedger: this.feeLedger.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
      platformFeesCollected: this._platformFeesCollected,
      agentIps: Array.from(this.agentIps.entries()).map(([k, v]) => [k, Array.from(v)]),
      flaggedAgents: Array.from(this.flaggedAgents),
      blockedAgents: Array.from(this.blockedAgents),
      isolationForest: this.isolationForest?.serialize() ?? null,
      transactionGraph: this.transactionGraph?.serialize() ?? null,
      behaviorProfile: this.behaviorProfile?.serialize() ?? null,
    });
  }

  static deserialize(json: string, config?: Partial<FraudConfig>): FraudGuard {
    const guard = new FraudGuard(config);
    try {
      const data = JSON.parse(json);
      if (data.chargeHistory) {
        guard.chargeHistory = new Map(data.chargeHistory);
      }
      if (data.agentStats) {
        guard.agentStats = new Map(data.agentStats);
      }
      if (data.disputes) {
        guard.disputes = new Map(
          data.disputes.map(([k, v]: [string, any]) => [
            k,
            { ...v, createdAt: new Date(v.createdAt), resolvedAt: v.resolvedAt ? new Date(v.resolvedAt) : undefined },
          ]),
        );
      }
      if (data.feeLedger) {
        guard.feeLedger = data.feeLedger.map((f: any) => ({ ...f, createdAt: new Date(f.createdAt) }));
      }
      if (data.platformFeesCollected !== undefined) {
        guard._platformFeesCollected = data.platformFeesCollected;
      }
      if (data.agentIps) {
        guard.agentIps = new Map(data.agentIps.map(([k, v]: [string, string[]]) => [k, new Set(v)]));
      }
      if (data.flaggedAgents) {
        guard.flaggedAgents = new Set(data.flaggedAgents);
      }
      if (data.blockedAgents) {
        guard.blockedAgents = new Set(data.blockedAgents);
      }
      if (guard.config.ml && data.isolationForest) {
        (guard as any).isolationForest = IsolationForest.deserialize(data.isolationForest);
      }
      if (guard.config.ml && data.transactionGraph) {
        (guard as any).transactionGraph = TransactionGraph.deserialize(data.transactionGraph);
      }
      if (guard.config.ml && data.behaviorProfile) {
        (guard as any).behaviorProfile = BehaviorProfile.deserialize(data.behaviorProfile);
      }
    } catch {
      // Return fresh guard if deserialization fails
    }
    return guard;
  }
}

// ─── Rate Limiter (for MCP server) ────────────────────────────────────────

export interface RateLimitConfig {
  /** Max requests per window. Default 60 */
  maxRequests: number;
  /** Window size in milliseconds. Default 60000 (1 minute) */
  windowMs: number;
  /** Max requests for payment operations (charge/settle/refund). Default 10 */
  maxPaymentRequests: number;
  /** Payment operations window in ms. Default 60000 */
  paymentWindowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60_000,
  maxPaymentRequests: 10,
  paymentWindowMs: 60_000,
};

export class RateLimiter {
  private config: RateLimitConfig;
  /** IP → timestamps of recent requests */
  private requests: Map<string, number[]> = new Map();
  /** IP → timestamps of recent payment operations */
  private paymentRequests: Map<string, number[]> = new Map();

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };
  }

  /**
   * Check if a request should be allowed.
   * Returns { allowed, remaining, retryAfterMs? }
   */
  check(key: string, isPayment = false): { allowed: boolean; remaining: number; retryAfterMs?: number } {
    const now = Date.now();

    // General rate limit
    const reqs = this.requests.get(key) || [];
    const windowStart = now - this.config.windowMs;
    const recentReqs = reqs.filter((t) => t > windowStart);
    this.requests.set(key, recentReqs);

    if (recentReqs.length >= this.config.maxRequests) {
      const oldestInWindow = recentReqs[0];
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: oldestInWindow + this.config.windowMs - now,
      };
    }

    // Payment-specific rate limit
    if (isPayment) {
      const payReqs = this.paymentRequests.get(key) || [];
      const payWindowStart = now - this.config.paymentWindowMs;
      const recentPayReqs = payReqs.filter((t) => t > payWindowStart);
      this.paymentRequests.set(key, recentPayReqs);

      if (recentPayReqs.length >= this.config.maxPaymentRequests) {
        const oldestPay = recentPayReqs[0];
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: oldestPay + this.config.paymentWindowMs - now,
        };
      }

      recentPayReqs.push(now);
      this.paymentRequests.set(key, recentPayReqs);
    }

    recentReqs.push(now);
    this.requests.set(key, recentReqs);

    const remaining = isPayment
      ? Math.min(
          this.config.maxRequests - recentReqs.length,
          this.config.maxPaymentRequests - (this.paymentRequests.get(key)?.length || 0),
        )
      : this.config.maxRequests - recentReqs.length;

    return { allowed: true, remaining };
  }

  /** Clean up old entries (call periodically) */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - Math.max(this.config.windowMs, this.config.paymentWindowMs) * 2;
    for (const [key, reqs] of this.requests) {
      const filtered = reqs.filter((t) => t > cutoff);
      if (filtered.length === 0) this.requests.delete(key);
      else this.requests.set(key, filtered);
    }
    for (const [key, reqs] of this.paymentRequests) {
      const filtered = reqs.filter((t) => t > cutoff);
      if (filtered.length === 0) this.paymentRequests.delete(key);
      else this.paymentRequests.set(key, filtered);
    }
  }
}
