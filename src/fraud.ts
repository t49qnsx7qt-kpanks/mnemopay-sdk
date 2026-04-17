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

export interface FeeTier {
  /** Minimum cumulative settled volume (USD) to qualify */
  minVolume: number;
  /** Fee rate for this tier */
  rate: number;
}

export interface FraudConfig {
  /** Platform fee rate on settle (0.019 = 1.9%). Default 0.019. Used when no tiers match. */
  platformFeeRate: number;
  /** Volume-based fee tiers (sorted by minVolume ascending). Overrides platformFeeRate when agent qualifies. */
  feeTiers: FeeTier[];
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
  /** Geo-enhanced fraud detection config */
  geo: GeoFraudConfig;
}

export const DEFAULT_FRAUD_CONFIG: FraudConfig = {
  platformFeeRate: 0.019,
  feeTiers: [
    { minVolume: 0,       rate: 0.019 },  // Standard: 1.9% (< $10K/month)
    { minVolume: 10_000,  rate: 0.015 },  // Growth:   1.5% ($10K - $100K)
    { minVolume: 100_000, rate: 0.010 },  // Scale:    1.0% ($100K+)
  ],
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
  geo: {
    enabled: true,
    homeCountryThreshold: 5,
    rapidHopThreshold: 3,
    highRiskCorridors: [],
    sanctionedCountries: [
      // OFAC comprehensively sanctioned countries
      "KP", "IR", "SY", "CU", "RU",
    ],
    currencyRegions: {
      NGN: ["NG"],
      GHS: ["GH"],
      ZAR: ["ZA"],
      KES: ["KE"],
      USD: ["US", "EC", "SV", "PA", "PR"],
      EUR: ["DE", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "FI", "GR"],
      GBP: ["GB"],
    },
  },
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

/**
 * Compact ring buffer for velocity tracking.
 * Stores interleaved [timestamp, amount, timestamp, amount, …] in a Float64Array
 * so the data lives in V8's "external" memory (not counted in heapUsed).
 * capacity = max entries; head = next write index (mod capacity).
 */
interface ChargeRing {
  buf: Float64Array; // capacity * 2 elements
  head: number;      // next write position (0-based)
  count: number;     // entries stored (≤ capacity)
  capacity: number;
}

/** IP/geo context passed from MCP server */
export interface RequestContext {
  ip?: string;
  country?: string;
  userAgent?: string;
  sessionId?: string;
  /** UTC offset in hours (e.g., +1 for WAT, -5 for CDT) */
  utcOffset?: number;
  /** Currency code associated with this request's region */
  currency?: string;
}

/** Per-agent geographic behavior profile */
export interface GeoProfile {
  /** First country seen — established as "home" after 5+ transactions */
  homeCountry?: string;
  /** All countries seen, with transaction counts */
  countryCounts: Record<string, number>;
  /** Country of last transaction */
  lastCountry?: string;
  /** Timestamps of country changes (for rapid-hop detection) */
  countryChanges: number[];
  /** Total transactions tracked for this profile */
  totalTxCount: number;
  /** Geo trust score 0-1 (higher = more consistent location = less suspicious) */
  trustScore: number;
}

/** Geo-specific fraud config. All thresholds designed to FLAG, not BLOCK. */
export interface GeoFraudConfig {
  /** Enable geo-enhanced fraud signals. Default: true */
  enabled: boolean;
  /** Min transactions before establishing home country. Default: 5 */
  homeCountryThreshold: number;
  /** Country changes in 24h to trigger rapid-hop signal. Default: 3 */
  rapidHopThreshold: number;
  /** High-risk country corridors (pairs). Default: common AML corridors */
  highRiskCorridors: [string, string][];
  /** OFAC/sanctions blocked countries. These BLOCK, not just flag. */
  sanctionedCountries: string[];
  /** Currency-to-country region map for mismatch detection */
  currencyRegions: Record<string, string[]>;
}

// ─── Replay Detection ──────────────────────────────────────────────────────

/**
 * Detects duplicate (replayed) transactions by fingerprinting
 * agentId + amount + reason + counterpartyId. Ported from GridStamp's
 * anti-spoofing layer.
 */
class ReplayDetector {
  private fingerprints: Map<string, number[]> = new Map();

  check(agentId: string, amount: number, reason: string, counterpartyId?: string): FraudSignal | null {
    const raw = `${agentId}|${amount}|${reason}|${counterpartyId ?? ""}`;
    const fp = require("crypto").createHash("sha256").update(raw).digest("hex") as string;
    const now = Date.now();

    // Prune entries older than 5 minutes
    const existing = this.fingerprints.get(fp);
    if (existing) {
      const pruned = existing.filter(t => now - t < 300_000);
      if (pruned.length === 0) {
        this.fingerprints.delete(fp);
      } else {
        this.fingerprints.set(fp, pruned);
      }
    }

    const timestamps = this.fingerprints.get(fp) || [];
    let signal: FraudSignal | null = null;

    // 3+ occurrences in 5 minutes → critical
    if (timestamps.length >= 3) {
      signal = {
        type: "replay_detected",
        severity: "critical",
        description: `Transaction replayed ${timestamps.length} times in 5 minutes (agent=${agentId}, amount=${amount})`,
        weight: 0.9,
      };
    // Same fingerprint within 60 seconds → high
    } else if (timestamps.length > 0 && now - timestamps[timestamps.length - 1] < 60_000) {
      signal = {
        type: "replay_detected",
        severity: "high",
        description: `Duplicate transaction detected within 60s (agent=${agentId}, amount=${amount})`,
        weight: 0.6,
      };
    }

    // Push current timestamp
    timestamps.push(now);
    this.fingerprints.set(fp, timestamps);

    // Cap map at 10,000 entries to prevent unbounded growth
    if (this.fingerprints.size > 10_000) {
      const firstKey = this.fingerprints.keys().next().value;
      if (firstKey !== undefined) this.fingerprints.delete(firstKey);
    }

    return signal;
  }
}

// ─── Fraud Guard ────────────────────────────────────────────────────────────

export class FraudGuard {
  readonly config: FraudConfig;

  /** Sliding window of recent charges per agent — stored as Float64Array ring buffers */
  private chargeRings: Map<string, ChargeRing> = new Map();
  /** Running stats per agent: sum, sumSq, count for online std-dev */
  private agentStats: Map<string, { sum: number; sumSq: number; count: number }> = new Map();
  /** Active disputes */
  private disputes: Map<string, Dispute> = new Map();
  /** Platform fee ledger */
  private feeLedger: PlatformFeeRecord[] = [];
  /** Total platform fees collected */
  private _platformFeesCollected: number = 0;
  /** Cumulative settled volume per agent (for tiered pricing) */
  private agentSettledVolume: Map<string, number> = new Map();
  /** Known IPs per agent for consistency checks */
  private agentIps: Map<string, Set<string>> = new Map();
  /** Flagged agents (soft block — allowed but monitored) */
  private flaggedAgents: Set<string> = new Set();
  /** Hard-blocked agents */
  private blockedAgents: Set<string> = new Set();
  /** Per-agent geo behavior profiles */
  private geoProfiles: Map<string, GeoProfile> = new Map();
  /** ML anomaly detection — only loaded when ml: true */
  readonly isolationForest: IsolationForest | null;
  /** Transaction graph — only loaded when ml: true */
  readonly transactionGraph: TransactionGraph | null;
  /** Behavioral fingerprinting — only loaded when ml: true */
  readonly behaviorProfile: BehaviorProfile | null;
  /** Transaction replay detection (ported from GridStamp anti-spoofing) */
  private replayDetector: ReplayDetector;

  constructor(config?: Partial<FraudConfig>) {
    // Typo guard — warn if caller passed keys that don't exist on FraudConfig.
    // This catches latent bugs like `riskScoreThreshold: 1.0` (should be
    // `blockThreshold`) where the override is silently dropped and the
    // fraud engine falls back to defaults. Runtime warning only — never
    // throws, so existing callers keep working.
    if (config && typeof config === "object") {
      const validKeys = new Set(Object.keys(DEFAULT_FRAUD_CONFIG));
      const unknown = Object.keys(config).filter(k => !validKeys.has(k));
      if (unknown.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mnemopay] FraudGuard: ignoring unknown config keys: ${unknown.join(", ")}. ` +
          `Valid keys: ${Array.from(validKeys).join(", ")}`,
        );
      }
    }
    this.config = { ...DEFAULT_FRAUD_CONFIG, ...config };
    // Deep merge geo config
    this.config.geo = { ...DEFAULT_FRAUD_CONFIG.geo, ...config?.geo };
    // Merge blockedCountries into sanctioned list (backwards compat)
    if (this.config.blockedCountries.length > 0) {
      const merged = new Set([...this.config.geo.sanctionedCountries, ...this.config.blockedCountries]);
      this.config.geo.sanctionedCountries = Array.from(merged);
    }
    // If platformFeeRate was explicitly set but feeTiers was NOT, derive tiers from the flat rate
    if (config?.platformFeeRate !== undefined && !config?.feeTiers) {
      this.config.feeTiers = [{ minVolume: 0, rate: config.platformFeeRate }];
    }
    if (this.config.ml) {
      this.isolationForest = new IsolationForest();
      this.transactionGraph = new TransactionGraph();
      this.behaviorProfile = new BehaviorProfile();
    } else {
      this.isolationForest = null;
      this.transactionGraph = null;
      this.behaviorProfile = null;
    }
    this.replayDetector = new ReplayDetector();
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
    reason?: string,
    counterpartyId?: string,
  ): RiskAssessment {
    const signals: FraudSignal[] = [];

    // 0a. Replay detection (ported from GridStamp anti-spoofing)
    if (reason !== undefined) {
      const replaySignal = this.replayDetector.check(agentId, amount, reason, counterpartyId);
      if (replaySignal) signals.push(replaySignal);
    }

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

    // 1. Velocity checks — single O(n) pass across all time windows
    const now = Date.now();
    const ring = this.chargeRings.get(agentId);

    // Single pass over ring buffer newest-to-oldest: compute all velocity/volume metrics
    let chargesLastMinute = 0, chargesLastHour = 0, chargesLastDay = 0, chargesLast10Min = 0;
    let dayVolume = 0;
    if (ring) {
      const cap = ring.capacity;
      for (let i = 0; i < ring.count; i++) {
        const pos = ((ring.head - 1 - i) % cap + cap) % cap;
        const ts = ring.buf[pos * 2]!;
        const age = now - ts;
        if (age >= 86_400_000) break; // ring is append-ordered newest-at-head; older won't match
        chargesLastDay++;
        dayVolume += ring.buf[pos * 2 + 1]!;
        if (age < 3_600_000) chargesLastHour++;
        if (age < 600_000) chargesLast10Min++;
        if (age < 60_000) chargesLastMinute++;
      }
    }

    if (chargesLastMinute >= this.config.maxChargesPerMinute) {
      signals.push({
        type: "velocity_burst",
        severity: "high",
        description: `${chargesLastMinute} charges in last minute (limit: ${this.config.maxChargesPerMinute})`,
        weight: 0.8,
      });
    }

    if (chargesLastHour >= this.config.maxChargesPerHour) {
      signals.push({
        type: "velocity_hourly",
        severity: "high",
        description: `${chargesLastHour} charges in last hour (limit: ${this.config.maxChargesPerHour})`,
        weight: 0.7,
      });
    }

    if (chargesLastDay >= this.config.maxChargesPerDay) {
      signals.push({
        type: "velocity_daily",
        severity: "medium",
        description: `${chargesLastDay} charges in last 24h (limit: ${this.config.maxChargesPerDay})`,
        weight: 0.6,
      });
    }

    // 2. Daily volume check
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
        amount, new Date().getHours(), 0, chargesLast10Min,
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

    // 8. Escalation pattern — progressively increasing amounts (last hour, capped at 20)
    // Only need the most recent entries in chronological order for escalation detection
    const recentAmounts: number[] = [];
    if (ring) {
      const cap = ring.capacity;
      for (let i = 0; i < ring.count && recentAmounts.length < 20; i++) {
        const pos = ((ring.head - 1 - i) % cap + cap) % cap;
        if (now - ring.buf[pos * 2]! >= 3_600_000) break;
        recentAmounts.unshift(ring.buf[pos * 2 + 1]!);
      }
    }
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

    // 9. Geo-enhanced fraud detection
    const geoSignals = this.assessGeo(agentId, ctx);
    signals.push(...geoSignals);

    // 10. Rapid charge-settle cycle detection — use chargesLast10Min already computed
    const recentCompleted = chargesLast10Min;
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

    // Update charge ring buffer — Float64Array keeps data in external memory (off heapUsed)
    let ring = this.chargeRings.get(agentId);
    if (!ring) {
      const cap = 5_000;
      ring = { buf: new Float64Array(cap * 2), head: 0, count: 0, capacity: cap };
      this.chargeRings.set(agentId, ring);
    }
    const wpos = ring.head;
    ring.buf[wpos * 2] = now;
    ring.buf[wpos * 2 + 1] = amount;
    ring.head = (ring.head + 1) % ring.capacity;
    if (ring.count < ring.capacity) ring.count++;

    // Update running statistics (Welford's online algorithm)
    const stats = this.agentStats.get(agentId) || { sum: 0, sumSq: 0, count: 0 };
    stats.sum += amount;
    stats.sumSq += amount * amount;
    stats.count++;
    this.agentStats.set(agentId, stats);

    // Track IP (capped at 500 unique IPs per agent)
    if (ctx?.ip) {
      const ips = this.agentIps.get(agentId) || new Set();
      if (ips.size < 500) {
        ips.add(ctx.ip);
      }
      this.agentIps.set(agentId, ips);
    }

    // Update geo profile (builds trust over time)
    this.updateGeoProfile(agentId, ctx);

    // Feed ML systems (only when ml: true) — iterate ring buffer newest-to-oldest
    if (this.isolationForest) {
      let recent10Count = 0, recent10Sum = 0;
      const recent10Amounts: number[] = [];
      if (ring) {
        const cap = ring.capacity;
        for (let i = 0; i < ring.count; i++) {
          const pos = ((ring.head - 1 - i) % cap + cap) % cap;
          if (now - ring.buf[pos * 2]! >= 600_000) break;
          recent10Count++;
          const a = ring.buf[pos * 2 + 1]!;
          recent10Sum += a;
          recent10Amounts.push(a);
        }
      }
      const avgRecent = recent10Count > 0 ? recent10Sum / recent10Count : 0;
      const stdRecent = recent10Count > 1
        ? Math.sqrt(recent10Amounts.reduce((s, a) => s + (a - avgRecent) ** 2, 0) / recent10Count)
        : 0;
      this.isolationForest.addSample([
        amount, new Date().getHours(), 0, recent10Count,
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
   * Get the effective fee rate for an agent based on cumulative settled volume.
   * Higher volume = lower fees (loyalty reward for active agents).
   */
  getEffectiveFeeRate(agentId: string): number {
    const volume = this.agentSettledVolume.get(agentId) ?? 0;
    const tiers = this.config.feeTiers;

    // Find the highest qualifying tier
    let rate = this.config.platformFeeRate;
    for (const tier of tiers) {
      if (volume >= tier.minVolume) {
        rate = tier.rate;
      }
    }
    return rate;
  }

  /**
   * Get an agent's cumulative settled volume.
   */
  getAgentVolume(agentId: string): number {
    return this.agentSettledVolume.get(agentId) ?? 0;
  }

  /**
   * Calculate and record platform fee for a settlement.
   * Uses volume-based tiered pricing when configured.
   * Returns { grossAmount, feeAmount, netAmount }.
   */
  applyPlatformFee(txId: string, agentId: string, grossAmount: number): PlatformFeeRecord {
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) throw new Error("Gross amount must be a positive finite number");
    const feeRate = this.getEffectiveFeeRate(agentId);
    const feeAmount = Math.min(Math.round(grossAmount * feeRate * 100) / 100, grossAmount);
    const netAmount = Math.round((grossAmount - feeAmount) * 100) / 100;

    const record: PlatformFeeRecord = {
      txId,
      agentId,
      grossAmount,
      feeRate,
      feeAmount,
      netAmount,
      createdAt: new Date(),
    };

    this.feeLedger.push(record);
    // Cap at 200 — getFeeLedger(limit) only ever reads the last 50-200 entries
    if (this.feeLedger.length > 200) this.feeLedger.splice(0, this.feeLedger.length - 200);
    this._platformFeesCollected += feeAmount;

    // Track cumulative volume for tier progression
    this.agentSettledVolume.set(agentId, (this.agentSettledVolume.get(agentId) ?? 0) + grossAmount);

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
      totalChargesTracked: Array.from(this.chargeRings.values()).reduce((sum, r) => sum + r.count, 0),
      agentsTracked: this.chargeRings.size,
      agentsFlagged: this.flaggedAgents.size,
      agentsBlocked: this.blockedAgents.size,
      openDisputes: Array.from(this.disputes.values()).filter((d) => d.status === "open").length,
      platformFeesCollected: this.platformFeesCollected,
    };
  }

  // ── Geo-Enhanced Fraud Detection ───────────────────────────────────────

  /**
   * Assess geo-related risk signals for a transaction.
   * Design: all signals are LOW weight (0.1-0.35) so they NEVER block alone.
   * Only sanctioned countries use critical weight (0.9).
   * Agents build geo trust over time, dampening signals further.
   */
  private assessGeo(agentId: string, ctx?: RequestContext): FraudSignal[] {
    const signals: FraudSignal[] = [];
    const geo = this.config.geo;

    if (!geo.enabled) return signals;

    // Legacy: IP hopping detection (always runs if IP provided)
    if (ctx?.ip) {
      const knownIps = this.agentIps.get(agentId);
      if (knownIps && knownIps.size > 0 && !knownIps.has(ctx.ip)) {
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

    if (!ctx?.country) return signals;

    const profile = this.getOrCreateGeoProfile(agentId);
    const trust = profile.trustScore;
    // Trust dampening: high trust agents get reduced signal weights
    // At trust=1.0, weights are halved. At trust=0, full weight.
    const dampen = (w: number) => Math.round(w * (1 - trust * 0.5) * 100) / 100;

    // 9a. Sanctioned / blocked countries — CRITICAL, always blocks
    if (geo.sanctionedCountries.includes(ctx.country) ||
        this.config.blockedCountries.includes(ctx.country)) {
      signals.push({
        type: "sanctioned_country",
        severity: "critical",
        description: `Transaction from sanctioned/blocked country: ${ctx.country}`,
        weight: 0.9, // NOT dampened — sanctions always apply
      });
      return signals; // No point checking further
    }

    // 9b. Country switch since last transaction
    if (profile.lastCountry && profile.lastCountry !== ctx.country) {
      signals.push({
        type: "geo_country_switch",
        severity: "low",
        description: `Country changed: ${profile.lastCountry} → ${ctx.country}`,
        weight: dampen(0.15),
      });
    }

    // 9c. Rapid country hopping — 3+ country changes in 24h
    const now = Date.now();
    const recentChanges = profile.countryChanges.filter(t => now - t < 86_400_000);
    if (recentChanges.length >= geo.rapidHopThreshold) {
      signals.push({
        type: "geo_rapid_hop",
        severity: "medium",
        description: `${recentChanges.length} country changes in 24h (threshold: ${geo.rapidHopThreshold})`,
        weight: dampen(0.35),
      });
    }

    // 9d. High-risk corridor — transaction between known risky pairs
    if (profile.lastCountry) {
      const pair = [profile.lastCountry, ctx.country].sort();
      const isRisky = geo.highRiskCorridors.some(c => {
        const sorted = [c[0], c[1]].sort();
        return sorted[0] === pair[0] && sorted[1] === pair[1];
      });
      if (isRisky) {
        signals.push({
          type: "geo_high_risk_corridor",
          severity: "medium",
          description: `Transaction on high-risk corridor: ${profile.lastCountry} ↔ ${ctx.country}`,
          weight: dampen(0.25),
        });
      }
    }

    // 9e. Currency-region mismatch
    if (ctx.currency) {
      const expectedCountries = geo.currencyRegions[ctx.currency];
      if (expectedCountries && !expectedCountries.includes(ctx.country)) {
        signals.push({
          type: "geo_currency_mismatch",
          severity: "low",
          description: `Currency ${ctx.currency} unusual from ${ctx.country} (expected: ${expectedCountries.join(", ")})`,
          weight: dampen(0.1),
        });
      }
    }

    // 9f. Timezone anomaly — transaction at unusual local hour
    if (ctx.utcOffset !== undefined) {
      const localHour = (new Date().getUTCHours() + ctx.utcOffset + 24) % 24;
      if (localHour >= 1 && localHour <= 4) {
        signals.push({
          type: "geo_timezone_anomaly",
          severity: "low",
          description: `Transaction at ${localHour}:00 local time (1-4am unusual activity window)`,
          weight: dampen(0.1),
        });
      }
    }

    return signals;
  }

  /**
   * Update geo profile after a successful charge.
   * Builds geo trust over time — consistent location = higher trust.
   */
  updateGeoProfile(agentId: string, ctx?: RequestContext): void {
    if (!ctx?.country || !this.config.geo.enabled) return;

    const profile = this.getOrCreateGeoProfile(agentId);
    const now = Date.now();

    // Track country change
    if (profile.lastCountry && profile.lastCountry !== ctx.country) {
      profile.countryChanges.push(now);
      // Keep only last 7 days of change history
      profile.countryChanges = profile.countryChanges.filter(t => now - t < 7 * 86_400_000);
    }

    // Update country counts
    profile.countryCounts[ctx.country] = (profile.countryCounts[ctx.country] ?? 0) + 1;
    profile.lastCountry = ctx.country;
    profile.totalTxCount++;

    // Establish home country after threshold
    if (!profile.homeCountry && profile.totalTxCount >= this.config.geo.homeCountryThreshold) {
      // Home = most frequent country
      let maxCount = 0;
      for (const [country, count] of Object.entries(profile.countryCounts)) {
        if (count > maxCount) {
          maxCount = count;
          profile.homeCountry = country;
        }
      }
    }

    // Calculate geo trust score
    // Trust = consistency ratio (how many tx from most common country / total tx)
    // Capped at 1.0, starts building after 3 transactions
    if (profile.totalTxCount >= 3) {
      const maxCountryCount = Math.max(...Object.values(profile.countryCounts));
      const consistency = maxCountryCount / profile.totalTxCount;
      // Smooth ramp: need 10+ tx from same country for full trust
      const maturity = Math.min(profile.totalTxCount / 10, 1.0);
      const rawTrust = consistency * maturity;
      profile.trustScore = Number.isFinite(rawTrust) ? Math.round(rawTrust * 100) / 100 : 0;
    }

    this.geoProfiles.set(agentId, profile);
  }

  /** Get or create a geo profile for an agent */
  private getOrCreateGeoProfile(agentId: string): GeoProfile {
    if (!this.geoProfiles.has(agentId)) {
      this.geoProfiles.set(agentId, {
        countryCounts: {},
        countryChanges: [],
        totalTxCount: 0,
        trustScore: 0,
      });
    }
    return this.geoProfiles.get(agentId)!;
  }

  /** Get an agent's geo profile (for diagnostics/display) */
  getGeoProfile(agentId: string): GeoProfile | undefined {
    return this.geoProfiles.get(agentId);
  }

  // ── Serialization (for persistence) ───────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      chargeHistory: Array.from(this.chargeRings.entries()).map(([id, r]) => {
        const entries: { timestamp: number; amount: number }[] = [];
        for (let i = 0; i < r.count; i++) {
          const pos = ((r.head - 1 - i) % r.capacity + r.capacity) % r.capacity;
          entries.push({ timestamp: r.buf[pos * 2]!, amount: r.buf[pos * 2 + 1]! });
        }
        return [id, entries.reverse()]; // oldest-first for compat
      }),
      agentStats: Array.from(this.agentStats.entries()),
      disputes: Array.from(this.disputes.entries()).map(([k, v]) => [k, { ...v, createdAt: v.createdAt.toISOString(), resolvedAt: v.resolvedAt?.toISOString() }]),
      feeLedger: this.feeLedger.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
      platformFeesCollected: this._platformFeesCollected,
      agentSettledVolume: Array.from(this.agentSettledVolume.entries()),
      agentIps: Array.from(this.agentIps.entries()).map(([k, v]) => [k, Array.from(v)]),
      flaggedAgents: Array.from(this.flaggedAgents),
      blockedAgents: Array.from(this.blockedAgents),
      geoProfiles: Array.from(this.geoProfiles.entries()),
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
        for (const [agentId, entries] of data.chargeHistory as [string, { timestamp: number; amount: number }[]][]) {
          const cap = 5_000;
          const ring: ChargeRing = { buf: new Float64Array(cap * 2), head: 0, count: 0, capacity: cap };
          for (const e of entries) {
            ring.buf[ring.head * 2] = e.timestamp;
            ring.buf[ring.head * 2 + 1] = e.amount;
            ring.head = (ring.head + 1) % cap;
            if (ring.count < cap) ring.count++;
          }
          guard.chargeRings.set(agentId, ring);
        }
      }
      if (Array.isArray(data.agentStats) && data.agentStats.length <= 50000) {
        guard.agentStats = new Map(data.agentStats);
      }
      if (Array.isArray(data.disputes) && data.disputes.length <= 50000) {
        guard.disputes = new Map(
          data.disputes.map(([k, v]: [string, any]) => [
            k,
            { ...v, createdAt: new Date(v.createdAt), resolvedAt: v.resolvedAt ? new Date(v.resolvedAt) : undefined },
          ]),
        );
      }
      if (Array.isArray(data.feeLedger) && data.feeLedger.length <= 100000) {
        guard.feeLedger = data.feeLedger.map((f: any) => ({ ...f, createdAt: new Date(f.createdAt) }));
      }
      if (data.platformFeesCollected !== undefined) {
        guard._platformFeesCollected = data.platformFeesCollected;
      }
      if (data.agentSettledVolume) {
        guard.agentSettledVolume = new Map(data.agentSettledVolume);
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
      if (data.geoProfiles) {
        guard.geoProfiles = new Map(
          (data.geoProfiles as [string, GeoProfile][]).map(([k, v]) => [
            k,
            {
              ...v,
              trustScore: Math.max(0, Math.min(1, Number(v.trustScore) || 0)),
              totalTxCount: Math.max(0, Math.floor(Number(v.totalTxCount) || 0)),
              countryChanges: Array.isArray(v.countryChanges)
                ? v.countryChanges.filter((t: unknown) => typeof t === "number" && Number.isFinite(t))
                : [],
              countryCounts: v.countryCounts && typeof v.countryCounts === "object"
                ? Object.fromEntries(
                    Object.entries(v.countryCounts).filter(
                      ([, c]) => typeof c === "number" && Number.isFinite(c as number) && (c as number) >= 0,
                    ),
                  )
                : {},
            },
          ]),
        );
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
    } catch (e) {
      console.error("[FraudGuard] deserialize failed:", (e as Error).message);
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
