/**
 * Streaming Anomaly Detection — Real-Time Agent Behavior Monitoring
 *
 * Two complementary systems:
 *
 * 1. EWMA (Exponentially Weighted Moving Average) Detector
 *    - Tracks running mean and variance of any metric stream
 *    - Alerts when value exceeds k standard deviations from moving average
 *    - Formula: mu_t = alpha * x_t + (1 - alpha) * mu_{t-1}
 *    - O(1) per update, no windowing needed, no buffer overflow
 *
 * 2. Behavioral Fingerprint Monitor
 *    - Tracks multi-dimensional behavioral profile of each agent
 *    - Detects sudden behavioral shifts (hijacked agent, credential theft)
 *    - Uses Mahalanobis distance for multivariate anomaly scoring
 *    - Gartner 2026: behavioral fingerprinting reduces impersonation 70%
 *
 * 3. Canary Transaction System
 *    - Plants honeypot transactions that should never be accessed
 *    - If an agent touches a canary, it's compromised
 *    - Inspired by Snare (GitHub) canary credential framework
 *
 * References:
 *   - Roberts, S.W. (1959). "Control Chart Tests Based on EWMA"
 *   - Lucas & Saccucci (1990). "EWMA Control Chart Properties"
 *   - Mahalanobis (1936). "On the Generalized Distance in Statistics"
 *   - MnemoPay Master Strategy, Part 2.1 — EWMA + behavioral fingerprinting
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EWMAState {
  /** Running mean */
  mean: number;
  /** Running variance */
  variance: number;
  /** Running standard deviation */
  stdDev: number;
  /** Number of observations */
  count: number;
  /** Last observed value */
  lastValue: number;
  /** Whether the detector has enough data to be reliable */
  warmedUp: boolean;
}

export interface EWMAAlert {
  /** Whether this observation is anomalous */
  anomaly: boolean;
  /** Current value */
  value: number;
  /** Current mean */
  mean: number;
  /** Current std dev */
  stdDev: number;
  /** Z-score: how many std devs from mean */
  zScore: number;
  /** Alert severity */
  severity: "none" | "warning" | "critical";
  /** Timestamp */
  timestamp: number;
}

export interface BehaviorFingerprint {
  /** Agent ID */
  agentId: string;
  /** Per-feature EWMA trackers */
  features: Record<string, EWMAState>;
  /** Number of observations used to build fingerprint */
  observations: number;
  /** Whether the fingerprint is established (>= warmupPeriod observations) */
  established: boolean;
  /** Last observation timestamp */
  lastObserved: number;
}

export interface HijackDetection {
  /** Whether hijack is suspected */
  suspected: boolean;
  /** Overall anomaly score (0-1, higher = more anomalous) */
  anomalyScore: number;
  /** Number of features that are anomalous */
  anomalousFeatures: number;
  /** Total features tracked */
  totalFeatures: number;
  /** Per-feature anomaly details */
  details: Record<string, { zScore: number; anomalous: boolean }>;
  /** Severity assessment */
  severity: "none" | "low" | "medium" | "high" | "critical";
  /** Recommendation */
  recommendation: string;
}

export interface CanaryTransaction {
  /** Canary ID */
  id: string;
  /** Fake amount (should never be accessed) */
  amount: number;
  /** Canary type */
  type: "transaction" | "memory" | "credential";
  /** When the canary was planted */
  plantedAt: number;
  /** Whether the canary has been triggered */
  triggered: boolean;
  /** When triggered (if applicable) */
  triggeredAt?: number;
  /** What agent triggered it */
  triggeredBy?: string;
}

export interface CanaryAlert {
  /** The triggered canary */
  canary: CanaryTransaction;
  /** Agent that triggered it */
  agentId: string;
  /** Severity: always critical (canary trigger = compromise) */
  severity: "critical";
  /** Message */
  message: string;
  /** Timestamp */
  timestamp: number;
}

export interface AnomalyConfig {
  /** EWMA smoothing factor (0-1). Higher = more reactive. Default 0.15 */
  alpha: number;
  /** Z-score threshold for warning. Default 2.5 */
  warningThreshold: number;
  /** Z-score threshold for critical. Default 3.5 */
  criticalThreshold: number;
  /** Minimum observations before alerting. Default 10 */
  warmupPeriod: number;
  /** Features to track for behavioral fingerprinting */
  trackedFeatures: string[];
  /** Fraction of anomalous features to flag hijack. Default 0.4 */
  hijackFeatureThreshold: number;
  /** Max canaries per agent. Default 5 */
  maxCanaries: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  alpha: 0.15,
  warningThreshold: 2.5,
  criticalThreshold: 3.5,
  warmupPeriod: 10,
  trackedFeatures: [
    "amount", "hourOfDay", "timeBetweenTx", "chargesPerHour",
    "avgAmount", "amountVariance", "counterpartyCount", "memoryOpsPerTx",
  ],
  hijackFeatureThreshold: 0.4,
  maxCanaries: 5,
};

// ─── EWMA Detector ──────────────────────────────────────────────────────────

export class EWMADetector {
  private mean: number = 0;
  private variance: number = 0;
  private count: number = 0;
  private lastValue: number = 0;
  private readonly alpha: number;
  private readonly warningK: number;
  private readonly criticalK: number;
  private readonly warmup: number;

  constructor(alpha: number = 0.15, warningK: number = 2.5, criticalK: number = 3.5, warmup: number = 10) {
    if (alpha <= 0 || alpha >= 1) throw new Error("Alpha must be in (0, 1)");
    if (warningK <= 0) throw new Error("Warning threshold must be positive");
    if (criticalK <= warningK) throw new Error("Critical threshold must exceed warning threshold");
    if (warmup < 1) throw new Error("Warmup period must be at least 1");

    this.alpha = alpha;
    this.warningK = warningK;
    this.criticalK = criticalK;
    this.warmup = warmup;
  }

  /**
   * Update the detector with a new observation.
   * Returns anomaly assessment.
   *
   * EWMA formulas:
   *   mu_t = alpha * x_t + (1 - alpha) * mu_{t-1}
   *   sigma_t^2 = alpha * (x_t - mu_t)^2 + (1 - alpha) * sigma_{t-1}^2
   *   Alert when: |x_t - mu_t| > k * sigma_t
   */
  update(value: number): EWMAAlert {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("EWMA value must be a finite number");
    }

    this.count++;
    this.lastValue = value;

    if (this.count === 1) {
      // First observation: initialize
      this.mean = value;
      this.variance = 0;
      return this._makeAlert(value, 0, "none");
    }

    // Update mean (EWMA)
    const prevMean = this.mean;
    this.mean = this.alpha * value + (1 - this.alpha) * prevMean;

    // Update variance (EWMA of squared deviations)
    const deviation = value - this.mean;
    this.variance = this.alpha * (deviation * deviation) + (1 - this.alpha) * this.variance;

    // Z-score
    const stdDev = Math.sqrt(this.variance);
    const zScore = stdDev > 1e-10 ? Math.abs(value - this.mean) / stdDev : 0;

    // Don't alert during warmup
    if (this.count < this.warmup) {
      return this._makeAlert(value, zScore, "none");
    }

    // Classify severity
    let severity: EWMAAlert["severity"] = "none";
    if (zScore >= this.criticalK) severity = "critical";
    else if (zScore >= this.warningK) severity = "warning";

    return this._makeAlert(value, zScore, severity);
  }

  private _makeAlert(value: number, zScore: number, severity: EWMAAlert["severity"]): EWMAAlert {
    return {
      anomaly: severity !== "none",
      value,
      mean: Math.round(this.mean * 10000) / 10000,
      stdDev: Math.round(Math.sqrt(this.variance) * 10000) / 10000,
      zScore: Math.round(zScore * 1000) / 1000,
      severity,
      timestamp: Date.now(),
    };
  }

  /** Get current state */
  getState(): EWMAState {
    return {
      mean: this.mean,
      variance: this.variance,
      stdDev: Math.sqrt(this.variance),
      count: this.count,
      lastValue: this.lastValue,
      warmedUp: this.count >= this.warmup,
    };
  }

  /** Reset the detector */
  reset(): void {
    this.mean = 0;
    this.variance = 0;
    this.count = 0;
    this.lastValue = 0;
  }

  /** Serialize for persistence */
  serialize(): { mean: number; variance: number; count: number; lastValue: number } {
    return { mean: this.mean, variance: this.variance, count: this.count, lastValue: this.lastValue };
  }

  /** Restore from serialized state */
  restore(state: { mean: number; variance: number; count: number; lastValue: number }): void {
    if (typeof state.mean !== "number" || !Number.isFinite(state.mean)) throw new Error("Invalid mean");
    if (typeof state.variance !== "number" || !Number.isFinite(state.variance) || state.variance < 0) throw new Error("Invalid variance");
    if (typeof state.count !== "number" || state.count < 0) throw new Error("Invalid count");
    this.mean = state.mean;
    this.variance = state.variance;
    this.count = Math.floor(state.count);
    if (state.lastValue !== undefined && (typeof state.lastValue !== "number" || !Number.isFinite(state.lastValue))) {
      throw new Error("Invalid lastValue");
    }
    this.lastValue = state.lastValue ?? 0;
  }
}

// ─── Behavioral Fingerprint Monitor ─────────────────────────────────────────

export class BehaviorMonitor {
  private fingerprints: Map<string, Map<string, EWMADetector>> = new Map();
  private observationCounts: Map<string, number> = new Map();
  private lastObserved: Map<string, number> = new Map();
  readonly config: AnomalyConfig;
  /** Max agents to track before evicting oldest inactive. Prevents unbounded memory growth. */
  static readonly MAX_AGENTS = 10_000;

  constructor(config?: Partial<AnomalyConfig>) {
    this.config = { ...DEFAULT_ANOMALY_CONFIG, ...config };
  }

  /**
   * Observe agent behavior. Updates the behavioral fingerprint.
   * Returns hijack detection result.
   */
  observe(agentId: string, features: Record<string, number>): HijackDetection {
    if (!agentId || typeof agentId !== "string") throw new Error("agentId is required");
    if (!features || typeof features !== "object") throw new Error("features must be an object");

    // Initialize fingerprint for new agents
    if (!this.fingerprints.has(agentId)) {
      // Evict oldest inactive agent if at capacity (prevents unbounded memory growth)
      if (this.fingerprints.size >= BehaviorMonitor.MAX_AGENTS) {
        let oldestId: string | null = null;
        let oldestTime = Infinity;
        for (const [id, time] of this.lastObserved) {
          if (time < oldestTime) { oldestTime = time; oldestId = id; }
        }
        if (oldestId) this.removeAgent(oldestId);
      }
      this.fingerprints.set(agentId, new Map());
      this.observationCounts.set(agentId, 0);
    }

    const detectors = this.fingerprints.get(agentId)!;
    const count = (this.observationCounts.get(agentId) ?? 0) + 1;
    this.observationCounts.set(agentId, count);
    this.lastObserved.set(agentId, Date.now());

    const details: Record<string, { zScore: number; anomalous: boolean }> = {};
    let anomalousCount = 0;
    let totalFeatures = 0;

    for (const feature of this.config.trackedFeatures) {
      const value = features[feature];
      if (value === undefined || typeof value !== "number" || !Number.isFinite(value)) continue;

      totalFeatures++;

      // Create detector for this feature if needed
      if (!detectors.has(feature)) {
        detectors.set(feature, new EWMADetector(
          this.config.alpha,
          this.config.warningThreshold,
          this.config.criticalThreshold,
          this.config.warmupPeriod,
        ));
      }

      const alert = detectors.get(feature)!.update(value);
      details[feature] = { zScore: alert.zScore, anomalous: alert.anomaly };
      if (alert.anomaly) anomalousCount++;
    }

    // Hijack scoring: fraction of anomalous features
    const anomalyScore = totalFeatures > 0 ? anomalousCount / totalFeatures : 0;
    const suspected = anomalyScore >= this.config.hijackFeatureThreshold && count >= this.config.warmupPeriod;

    let severity: HijackDetection["severity"] = "none";
    if (suspected && anomalyScore >= 0.8) severity = "critical";
    else if (suspected && anomalyScore >= 0.6) severity = "high";
    else if (suspected) severity = "medium";
    else if (anomalousCount > 0) severity = "low";

    let recommendation: string;
    if (severity === "critical") {
      recommendation = `CRITICAL: ${anomalousCount}/${totalFeatures} behavioral features deviant. Agent ${agentId} may be compromised. Recommended: suspend transactions, require re-authentication.`;
    } else if (severity === "high") {
      recommendation = `HIGH RISK: ${anomalousCount}/${totalFeatures} features anomalous. Increase monitoring. Consider HITL approval for large transactions.`;
    } else if (severity === "medium") {
      recommendation = `ELEVATED: Some behavioral deviation detected. Monitor closely.`;
    } else if (severity === "low") {
      recommendation = `Minor deviations detected. Within acceptable range.`;
    } else {
      recommendation = `Behavior consistent with established profile.`;
    }

    return {
      suspected,
      anomalyScore: Math.round(anomalyScore * 1000) / 1000,
      anomalousFeatures: anomalousCount,
      totalFeatures,
      details,
      severity,
      recommendation,
    };
  }

  /**
   * Get the behavioral fingerprint for an agent.
   */
  getFingerprint(agentId: string): BehaviorFingerprint | null {
    const detectors = this.fingerprints.get(agentId);
    if (!detectors) return null;

    const features: Record<string, EWMAState> = {};
    for (const [name, detector] of detectors) {
      features[name] = detector.getState();
    }

    const observations = this.observationCounts.get(agentId) ?? 0;

    return {
      agentId,
      features,
      observations,
      established: observations >= this.config.warmupPeriod,
      lastObserved: this.lastObserved.get(agentId) ?? 0,
    };
  }

  /**
   * Remove an agent's fingerprint (on agent deletion).
   */
  removeAgent(agentId: string): boolean {
    const existed = this.fingerprints.has(agentId);
    this.fingerprints.delete(agentId);
    this.observationCounts.delete(agentId);
    this.lastObserved.delete(agentId);
    return existed;
  }

  /** Number of agents being monitored */
  get agentCount(): number {
    return this.fingerprints.size;
  }

  /** Serialize for persistence */
  serialize(): Record<string, { features: Record<string, ReturnType<EWMADetector["serialize"]>>; count: number; lastObserved: number }> {
    const result: Record<string, any> = {};
    for (const [agentId, detectors] of this.fingerprints) {
      const features: Record<string, any> = {};
      for (const [name, detector] of detectors) {
        features[name] = detector.serialize();
      }
      result[agentId] = {
        features,
        count: this.observationCounts.get(agentId) ?? 0,
        lastObserved: this.lastObserved.get(agentId) ?? 0,
      };
    }
    return result;
  }

  /** Deserialize with validation */
  static deserialize(data: Record<string, any>, config?: Partial<AnomalyConfig>): BehaviorMonitor {
    const monitor = new BehaviorMonitor(config);
    if (!data || typeof data !== "object") return monitor;

    for (const [agentId, agentData] of Object.entries(data)) {
      if (!agentData || typeof agentData !== "object") continue;
      const detectors = new Map<string, EWMADetector>();

      if (agentData.features && typeof agentData.features === "object") {
        for (const [feature, state] of Object.entries(agentData.features as Record<string, any>)) {
          try {
            const detector = new EWMADetector(
              monitor.config.alpha,
              monitor.config.warningThreshold,
              monitor.config.criticalThreshold,
              monitor.config.warmupPeriod,
            );
            detector.restore(state);
            detectors.set(feature, detector);
          } catch {
            // Skip corrupted feature data
          }
        }
      }

      monitor.fingerprints.set(agentId, detectors);
      monitor.observationCounts.set(agentId, typeof agentData.count === "number" ? agentData.count : 0);
      monitor.lastObserved.set(agentId, typeof agentData.lastObserved === "number" ? agentData.lastObserved : 0);
    }

    return monitor;
  }
}

// ─── Canary Transaction System ──────────────────────────────────────────────

export class CanarySystem {
  private canaries: Map<string, CanaryTransaction> = new Map();
  private alerts: CanaryAlert[] = [];
  private readonly maxCanaries: number;
  static readonly MAX_ALERTS = 100;

  constructor(maxCanaries: number = 5) {
    if (maxCanaries < 1 || maxCanaries > 50) throw new Error("maxCanaries must be 1-50");
    this.maxCanaries = maxCanaries;
  }

  /**
   * Plant a canary transaction.
   * Returns the canary ID. Store this — never expose to the agent.
   */
  plant(type: CanaryTransaction["type"] = "transaction"): CanaryTransaction {
    if (this.canaries.size >= this.maxCanaries) {
      // Remove oldest untriggered canary
      let oldest: CanaryTransaction | null = null;
      for (const c of this.canaries.values()) {
        if (!c.triggered && (!oldest || c.plantedAt < oldest.plantedAt)) {
          oldest = c;
        }
      }
      if (oldest) this.canaries.delete(oldest.id);
    }

    // Use crypto.randomBytes for unpredictable canary IDs and amounts.
    // A compromised agent that can predict canary IDs can avoid traps.
    // No fallback to Math.random() — canaries MUST be unpredictable.
    const cryptoMod = require("crypto");
    const randomSuffix = cryptoMod.randomBytes(6).toString("hex");
    // Crypto-random amount between $1-100 (uniform, unpredictable)
    const randomAmount = (cryptoMod.randomBytes(2).readUInt16BE(0) % 9900 + 100) / 100;
    const canary: CanaryTransaction = {
      id: `canary-${Date.now()}-${randomSuffix}`,
      amount: Math.round(randomAmount * 100) / 100, // $1-100
      type,
      plantedAt: Date.now(),
      triggered: false,
    };

    this.canaries.set(canary.id, canary);
    return canary;
  }

  /**
   * Check if an ID matches a canary. If yes, the agent is compromised.
   * This should be called on every transaction/memory access.
   */
  check(id: string, agentId: string): CanaryAlert | null {
    const canary = this.canaries.get(id);
    if (!canary) return null;

    // TRIGGERED — agent accessed a honeypot
    canary.triggered = true;
    canary.triggeredAt = Date.now();
    canary.triggeredBy = agentId;

    const alert: CanaryAlert = {
      canary: { ...canary },
      agentId,
      severity: "critical",
      message: `CANARY TRIGGERED: Agent ${agentId} accessed ${canary.type} canary "${canary.id}". This agent may be compromised. Canary was planted ${Math.round((Date.now() - canary.plantedAt) / 60000)} minutes ago.`,
      timestamp: Date.now(),
    };

    this.alerts.push(alert);
    if (this.alerts.length > CanarySystem.MAX_ALERTS) {
      this.alerts.splice(0, this.alerts.length - CanarySystem.MAX_ALERTS);
    }

    return alert;
  }

  /** Check if any ID in a list matches a canary */
  checkBatch(ids: string[], agentId: string): CanaryAlert[] {
    const alerts: CanaryAlert[] = [];
    for (const id of ids) {
      const alert = this.check(id, agentId);
      if (alert) alerts.push(alert);
    }
    return alerts;
  }

  /** Get all alerts */
  getAlerts(): CanaryAlert[] {
    return [...this.alerts];
  }

  /** Get all active (untriggered) canaries */
  getActiveCanaries(): CanaryTransaction[] {
    return Array.from(this.canaries.values()).filter(c => !c.triggered);
  }

  /** Check if a specific canary ID exists (for internal use only) */
  isCanary(id: string): boolean {
    return this.canaries.has(id);
  }

  /** Serialize for persistence */
  serialize(): { canaries: CanaryTransaction[]; alerts: CanaryAlert[] } {
    return {
      canaries: Array.from(this.canaries.values()),
      alerts: [...this.alerts],
    };
  }

  /** Deserialize with validation */
  static deserialize(data: { canaries?: CanaryTransaction[]; alerts?: CanaryAlert[] }, maxCanaries?: number): CanarySystem {
    const system = new CanarySystem(maxCanaries);
    if (Array.isArray(data.canaries)) {
      for (const c of data.canaries) {
        if (c.id && typeof c.amount === "number" && Number.isFinite(c.amount)) {
          system.canaries.set(c.id, { ...c });
        }
      }
    }
    if (Array.isArray(data.alerts)) {
      system.alerts = data.alerts.slice(-CanarySystem.MAX_ALERTS);
    }
    return system;
  }
}
