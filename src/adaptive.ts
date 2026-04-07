/**
 * MnemoPay Adaptive Engine
 *
 * Business philosophy encoded in code: a system that doesn't learn from its
 * own operations is dead. MnemoPay adapts to what moves the business forward
 * — securely, with guardrails, with a full audit trail.
 *
 * The engine observes:
 *   - Agent behavior patterns (settlement rates, dispute frequency, charge velocity)
 *   - Revenue signals (which fee tiers produce the most volume, where agents churn)
 *   - Risk trends (emerging fraud patterns, anomaly drift, geographic shifts)
 *   - Memory health (recall quality, consolidation rates, storage efficiency)
 *
 * It adapts:
 *   - Fee tiers (within secure bounds) to maximize retention + revenue
 *   - Risk thresholds (tighten on emerging threats, loosen on proven agents)
 *   - Rate limits (reward trusted agents with higher throughput)
 *   - Memory decay (faster for low-value agents, slower for high-value)
 *
 * It NEVER:
 *   - Adapts below minimum security thresholds (floor on risk, max on limits)
 *   - Changes without an audit record
 *   - Overrides manual admin settings
 *   - Makes jumps > 20% in any single adaptation cycle
 *
 * This is the Agent FICO thesis: the longer an agent operates, the smarter
 * the system becomes about that agent. Trust is earned, never assumed.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AdaptiveConfig {
  /** Enable adaptive optimization (default: true) */
  enabled: boolean;
  /** Minimum observations before adapting (default: 10) */
  minObservations: number;
  /** Maximum parameter change per cycle (0.2 = 20%) */
  maxDeltaPercent: number;
  /** Minimum cycle interval in minutes (default: 60) */
  cycleIntervalMinutes: number;
  /** Lock specific parameters from adaptation */
  lockedParams: string[];
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  enabled: true,
  minObservations: 10,
  maxDeltaPercent: 0.2,
  cycleIntervalMinutes: 60,
  lockedParams: [],
};

export interface AgentInsight {
  agentId: string;
  /** Settlement success rate (0-1) */
  settlementRate: number;
  /** Average charge amount */
  avgChargeAmount: number;
  /** Disputes filed against this agent */
  disputeCount: number;
  /** Total revenue generated */
  totalRevenue: number;
  /** Memory utilization efficiency (active memories / total) */
  memoryEfficiency: number;
  /** Recommended risk tier: trusted | standard | elevated | restricted */
  riskTier: "trusted" | "standard" | "elevated" | "restricted";
  /** Recommended fee tier override (null = use default) */
  recommendedFeeRate: number | null;
  /** Recommended rate limit multiplier (1.0 = default, 2.0 = double) */
  rateLimitMultiplier: number;
  /** Agent health score (0-100) */
  healthScore: number;
  /** Observations count */
  observations: number;
  /** Last analyzed */
  analyzedAt: Date;
}

export interface AdaptationRecord {
  id: string;
  /** What was adapted */
  parameter: string;
  /** Previous value */
  previousValue: number;
  /** New value */
  newValue: number;
  /** Why it was adapted */
  reason: string;
  /** Evidence that triggered the adaptation */
  evidence: Record<string, number>;
  /** When the adaptation was applied */
  appliedAt: Date;
  /** Whether it was actually applied (false if locked or vetoed) */
  applied: boolean;
  /** Veto reason if not applied */
  vetoReason?: string;
}

export interface BusinessMetrics {
  /** Total platform revenue (from fees) */
  totalRevenue: number;
  /** Revenue this cycle */
  cycleRevenue: number;
  /** Total agents observed */
  totalAgents: number;
  /** Agents with settlement rate > 80% */
  trustedAgents: number;
  /** Agents with disputes */
  disputedAgents: number;
  /** Platform-wide settlement rate */
  platformSettlementRate: number;
  /** Average memory utilization across agents */
  avgMemoryUtilization: number;
  /** Fraud detection rate (blocked/total) */
  fraudDetectionRate: number;
  /** System health (0-100) */
  systemHealth: number;
  /** Computed at */
  computedAt: Date;
}

export type AdaptiveEventType =
  | "charge"
  | "settle"
  | "refund"
  | "dispute"
  | "memory_store"
  | "memory_recall"
  | "fraud_block"
  | "fraud_flag";

export interface AdaptiveEvent {
  type: AdaptiveEventType;
  agentId: string;
  amount?: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ─── Secure Bounds ──────────────────────────────────────────────────────────
// These are HARD floors and ceilings. The adaptive engine cannot breach them.
// This is the "never adapt yourself into an insecure state" principle.

const SECURE_BOUNDS = {
  // Fee rates: never go below 0.5% (business viability) or above 5% (market competitiveness)
  feeRate: { min: 0.005, max: 0.05 },
  // Risk block threshold: never go above 0.95 (must always be able to block)
  blockThreshold: { min: 0.3, max: 0.95 },
  // Flag threshold: never go above block threshold
  flagThreshold: { min: 0.1, max: 0.7 },
  // Rate limit multiplier: trusted agents get up to 3x, never below 0.5x
  rateLimitMultiplier: { min: 0.5, max: 3.0 },
  // Memory decay: never so fast memories die in < 1hr, never so slow they never decay
  decayRate: { min: 0.001, max: 0.5 },
  // Settlement hold: never below 5 minutes (gives rail time to capture)
  settlementHoldMinutes: { min: 5, max: 1440 },
} as const;

// ─── Adaptive Engine ────────────────────────────────────────────────────────

export class AdaptiveEngine {
  private config: AdaptiveConfig;
  private events: AdaptiveEvent[] = [];
  private insights: Map<string, AgentInsight> = new Map();
  private adaptations: AdaptationRecord[] = [];
  private lastCycleAt: number = 0;
  /** Manual overrides set by admin — these are never auto-changed */
  private adminOverrides: Map<string, number> = new Map();
  private eventCounter = 0;

  constructor(config?: Partial<AdaptiveConfig>) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
  }

  // ── Event Ingestion ────────────────────────────────────────────────────

  /**
   * Record an operational event. The engine learns from every operation.
   */
  observe(event: AdaptiveEvent): void {
    this.events.push(event);
    this.eventCounter++;
    // Rolling window: keep last 50K events to bound memory usage
    if (this.events.length > 50_000) {
      this.events = this.events.slice(-25_000);
    }
  }

  // ── Agent Analysis ─────────────────────────────────────────────────────

  /**
   * Analyze an agent's behavioral pattern and produce an insight profile.
   * This is the "Agent FICO score" — built from real operational data.
   */
  analyzeAgent(agentId: string): AgentInsight {
    const agentEvents = this.events.filter(e => e.agentId === agentId);

    const charges = agentEvents.filter(e => e.type === "charge");
    const settles = agentEvents.filter(e => e.type === "settle");
    const refunds = agentEvents.filter(e => e.type === "refund");
    const disputes = agentEvents.filter(e => e.type === "dispute");
    const memStores = agentEvents.filter(e => e.type === "memory_store");
    const memRecalls = agentEvents.filter(e => e.type === "memory_recall");
    const fraudBlocks = agentEvents.filter(e => e.type === "fraud_block");

    const totalCompleted = settles.length + refunds.length;
    const settlementRate = totalCompleted > 0 ? settles.length / totalCompleted : 0;
    const avgCharge = charges.length > 0
      ? charges.reduce((sum, e) => sum + (e.amount ?? 0), 0) / charges.length
      : 0;
    const totalRevenue = settles.reduce((sum, e) => sum + (e.amount ?? 0) * 0.019, 0);

    // Memory efficiency: recalls / stores (how often are stored memories actually used?)
    const memoryEfficiency = memStores.length > 0
      ? Math.min(memRecalls.length / memStores.length, 1.0)
      : 0;

    // Risk tier determination
    let riskTier: AgentInsight["riskTier"] = "standard";
    if (disputes.length > 0 || fraudBlocks.length > 2) {
      riskTier = disputes.length >= 3 ? "restricted" : "elevated";
    } else if (settlementRate > 0.9 && settles.length >= 10) {
      riskTier = "trusted";
    }

    // Recommended fee rate: reward high-volume, high-settlement agents
    let recommendedFeeRate: number | null = null;
    const totalVolume = settles.reduce((sum, e) => sum + (e.amount ?? 0), 0);
    if (totalVolume >= 100_000) recommendedFeeRate = 0.010;
    else if (totalVolume >= 10_000) recommendedFeeRate = 0.015;

    // Rate limit multiplier: trusted agents earn higher throughput
    let rateLimitMultiplier = 1.0;
    if (riskTier === "trusted") rateLimitMultiplier = 2.0;
    else if (riskTier === "elevated") rateLimitMultiplier = 0.7;
    else if (riskTier === "restricted") rateLimitMultiplier = 0.5;

    // Health score (0-100)
    let healthScore = 50;
    healthScore += settlementRate * 20; // Up to +20 for settlements
    healthScore += Math.min(settles.length, 50) * 0.2; // Up to +10 for volume
    healthScore += memoryEfficiency * 10; // Up to +10 for memory usage
    healthScore -= disputes.length * 5; // -5 per dispute
    healthScore -= fraudBlocks.length * 10; // -10 per fraud block
    healthScore = Math.max(0, Math.min(100, healthScore));

    const insight: AgentInsight = {
      agentId,
      settlementRate,
      avgChargeAmount: Math.round(avgCharge * 100) / 100,
      disputeCount: disputes.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      memoryEfficiency: Math.round(memoryEfficiency * 100) / 100,
      riskTier,
      recommendedFeeRate,
      rateLimitMultiplier,
      healthScore: Math.round(healthScore),
      observations: agentEvents.length,
      analyzedAt: new Date(),
    };

    this.insights.set(agentId, insight);
    return insight;
  }

  // ── Business Metrics ───────────────────────────────────────────────────

  /**
   * Compute platform-wide business intelligence.
   */
  computeMetrics(): BusinessMetrics {
    const agentIds = new Set(this.events.map(e => e.agentId));
    const settles = this.events.filter(e => e.type === "settle");
    const refunds = this.events.filter(e => e.type === "refund");
    const charges = this.events.filter(e => e.type === "charge");
    const disputes = this.events.filter(e => e.type === "dispute");
    const fraudBlocks = this.events.filter(e => e.type === "fraud_block");
    const memStores = this.events.filter(e => e.type === "memory_store");
    const memRecalls = this.events.filter(e => e.type === "memory_recall");

    const totalRevenue = settles.reduce((sum, e) => sum + (e.amount ?? 0) * 0.019, 0);
    const totalCompleted = settles.length + refunds.length;
    const platformSettlementRate = totalCompleted > 0 ? settles.length / totalCompleted : 0;

    // Cycle revenue (last cycle interval)
    const cycleStart = Date.now() - this.config.cycleIntervalMinutes * 60_000;
    const cycleSettles = settles.filter(e => e.timestamp > cycleStart);
    const cycleRevenue = cycleSettles.reduce((sum, e) => sum + (e.amount ?? 0) * 0.019, 0);

    // Analyze all agents for tier counts
    let trustedCount = 0;
    let disputedAgentIds = new Set<string>();
    for (const agentId of agentIds) {
      const insight = this.analyzeAgent(agentId);
      if (insight.riskTier === "trusted") trustedCount++;
      if (insight.disputeCount > 0) disputedAgentIds.add(agentId);
    }

    const avgMemUtil = memStores.length > 0
      ? Math.min(memRecalls.length / memStores.length, 1.0)
      : 0;

    const fraudDetectionRate = charges.length > 0
      ? fraudBlocks.length / charges.length
      : 0;

    // System health: composite score
    let systemHealth = 70; // baseline
    systemHealth += platformSettlementRate * 15;
    systemHealth -= (disputes.length / Math.max(settles.length, 1)) * 20;
    systemHealth += avgMemUtil * 5;
    systemHealth = Math.max(0, Math.min(100, Math.round(systemHealth)));

    return {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      cycleRevenue: Math.round(cycleRevenue * 100) / 100,
      totalAgents: agentIds.size,
      trustedAgents: trustedCount,
      disputedAgents: disputedAgentIds.size,
      platformSettlementRate: Math.round(platformSettlementRate * 100) / 100,
      avgMemoryUtilization: Math.round(avgMemUtil * 100) / 100,
      fraudDetectionRate: Math.round(fraudDetectionRate * 1000) / 1000,
      systemHealth,
      computedAt: new Date(),
    };
  }

  // ── Adaptive Optimization ──────────────────────────────────────────────

  /**
   * Run an adaptation cycle. Analyzes all data, proposes parameter changes,
   * validates against secure bounds, and returns what was (or would be) changed.
   *
   * Returns proposed adaptations. Call applyAdaptations() to commit them.
   */
  runCycle(): AdaptationRecord[] {
    if (!this.config.enabled) return [];

    // Enforce minimum cycle interval
    const now = Date.now();
    if (now - this.lastCycleAt < this.config.cycleIntervalMinutes * 60_000) {
      return [];
    }
    this.lastCycleAt = now;

    if (this.events.length < this.config.minObservations) {
      return [];
    }

    const metrics = this.computeMetrics();
    const proposals: AdaptationRecord[] = [];

    // ── Adapt fee rate based on platform settlement rate ──────────────
    if (!this.isLocked("feeRate")) {
      const currentRate = 0.019; // default
      let targetRate = currentRate;

      // If settlement rate is high (> 90%), reward with lower fees
      if (metrics.platformSettlementRate > 0.9 && metrics.totalAgents >= 5) {
        targetRate = currentRate * 0.95; // 5% reduction
      }
      // If dispute rate is high, increase fees to cover risk
      if (metrics.disputedAgents / Math.max(metrics.totalAgents, 1) > 0.1) {
        targetRate = currentRate * 1.05; // 5% increase
      }

      targetRate = this.clamp(targetRate, SECURE_BOUNDS.feeRate.min, SECURE_BOUNDS.feeRate.max);
      targetRate = this.limitDelta(currentRate, targetRate);

      if (Math.abs(targetRate - currentRate) > 0.0001) {
        proposals.push(this.createRecord("feeRate", currentRate, targetRate,
          metrics.platformSettlementRate > 0.9
            ? "High platform settlement rate — rewarding ecosystem"
            : "Elevated dispute rate — increasing to cover risk",
          { settlementRate: metrics.platformSettlementRate, disputeRatio: metrics.disputedAgents / Math.max(metrics.totalAgents, 1) }
        ));
      }
    }

    // ── Adapt risk thresholds based on fraud patterns ─────────────────
    if (!this.isLocked("blockThreshold")) {
      const currentBlock = 0.75;
      let targetBlock = currentBlock;

      // If fraud detection is catching too many (> 10% of charges), system may be too aggressive
      if (metrics.fraudDetectionRate > 0.10) {
        targetBlock = currentBlock * 1.03; // loosen slightly
      }
      // If zero fraud but many agents, may be too loose
      if (metrics.fraudDetectionRate < 0.001 && metrics.totalAgents > 20) {
        targetBlock = currentBlock * 0.98; // tighten slightly
      }

      targetBlock = this.clamp(targetBlock, SECURE_BOUNDS.blockThreshold.min, SECURE_BOUNDS.blockThreshold.max);
      targetBlock = this.limitDelta(currentBlock, targetBlock);

      if (Math.abs(targetBlock - currentBlock) > 0.001) {
        proposals.push(this.createRecord("blockThreshold", currentBlock, targetBlock,
          metrics.fraudDetectionRate > 0.10
            ? "Fraud detection too aggressive — loosening to reduce false positives"
            : "Low fraud detection with many agents — tightening for safety",
          { fraudRate: metrics.fraudDetectionRate, totalAgents: metrics.totalAgents }
        ));
      }
    }

    this.adaptations.push(...proposals);
    // Cap adaptation history at 1000 records
    if (this.adaptations.length > 1000) {
      this.adaptations = this.adaptations.slice(-500);
    }

    return proposals;
  }

  // ── Admin Controls ─────────────────────────────────────────────────────

  /**
   * Lock a parameter from adaptive changes. Admin decisions override AI.
   */
  lockParam(param: string): void {
    if (!this.config.lockedParams.includes(param)) {
      this.config.lockedParams.push(param);
    }
  }

  /**
   * Unlock a parameter for adaptive changes.
   */
  unlockParam(param: string): void {
    this.config.lockedParams = this.config.lockedParams.filter(p => p !== param);
  }

  /**
   * Set an admin override. This value will be used instead of adaptive suggestions.
   */
  setOverride(param: string, value: number): void {
    this.adminOverrides.set(param, value);
  }

  /**
   * Remove an admin override, allowing adaptive control.
   */
  removeOverride(param: string): void {
    this.adminOverrides.delete(param);
  }

  /**
   * Get the effective value for a parameter (admin override > adaptation > default).
   */
  getEffectiveValue(param: string, defaultValue: number): number {
    if (this.adminOverrides.has(param)) return this.adminOverrides.get(param)!;
    // Check last applied adaptation
    const lastAdaptation = [...this.adaptations]
      .reverse()
      .find(a => a.parameter === param && a.applied);
    return lastAdaptation ? lastAdaptation.newValue : defaultValue;
  }

  // ── Getters ────────────────────────────────────────────────────────────

  getInsight(agentId: string): AgentInsight | undefined {
    return this.insights.get(agentId);
  }

  getAdaptations(limit = 50): AdaptationRecord[] {
    return this.adaptations.slice(-limit);
  }

  get totalEvents(): number {
    return this.eventCounter;
  }

  get secureBounds(): typeof SECURE_BOUNDS {
    return SECURE_BOUNDS;
  }

  // ── Serialization ──────────────────────────────────────────────────────

  serialize(): {
    config: AdaptiveConfig;
    insights: [string, AgentInsight][];
    adaptations: AdaptationRecord[];
    overrides: [string, number][];
    eventCount: number;
  } {
    return {
      config: this.config,
      insights: Array.from(this.insights.entries()),
      adaptations: this.adaptations.slice(-200), // Keep recent history
      overrides: Array.from(this.adminOverrides.entries()),
      eventCount: this.eventCounter,
    };
  }

  static deserialize(data: ReturnType<AdaptiveEngine["serialize"]>): AdaptiveEngine {
    const engine = new AdaptiveEngine(data.config);
    for (const [id, insight] of data.insights) {
      insight.analyzedAt = new Date(insight.analyzedAt);
      engine.insights.set(id, insight);
    }
    engine.adaptations = data.adaptations.map(a => ({
      ...a,
      appliedAt: new Date(a.appliedAt),
    }));
    for (const [key, val] of data.overrides) {
      engine.adminOverrides.set(key, val);
    }
    engine.eventCounter = data.eventCount ?? 0;
    return engine;
  }

  // ── Internal Utilities ─────────────────────────────────────────────────

  private isLocked(param: string): boolean {
    return this.config.lockedParams.includes(param) || this.adminOverrides.has(param);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Limit how much a parameter can change in one cycle.
   * Prevents wild swings — stability is a security property.
   */
  private limitDelta(current: number, target: number): number {
    const maxDelta = current * this.config.maxDeltaPercent;
    const delta = target - current;
    if (Math.abs(delta) > maxDelta) {
      return current + Math.sign(delta) * maxDelta;
    }
    return target;
  }

  private createRecord(
    parameter: string,
    previousValue: number,
    newValue: number,
    reason: string,
    evidence: Record<string, number>,
  ): AdaptationRecord {
    const isLocked = this.isLocked(parameter);
    return {
      id: `adapt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      parameter,
      previousValue: Math.round(previousValue * 10000) / 10000,
      newValue: Math.round(newValue * 10000) / 10000,
      reason,
      evidence,
      appliedAt: new Date(),
      applied: !isLocked,
      vetoReason: isLocked ? `Parameter '${parameter}' is locked or has admin override` : undefined,
    };
  }
}
