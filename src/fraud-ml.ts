/**
 * MnemoPay Advanced Fraud Detection — ML-grade algorithms in pure TypeScript.
 *
 * Three systems that close the depth gap with Stripe/Coinbase:
 *
 * 1. IsolationForest — Adaptive anomaly detection that LEARNS each agent's
 *    normal behavior and catches deviations. Replaces static z-scores.
 *
 * 2. TransactionGraph — Directed graph of money flows between agents.
 *    Detects wash trading (A→B→A cycles), fraud rings (dense subgraphs),
 *    and sybil attacks (correlated agents from same source).
 *
 * 3. BehaviorProfile — Fingerprints each agent's behavioral signature:
 *    typical amounts, timing patterns, charge frequency, memory-to-payment
 *    ratio. Detects drift from established baseline.
 *
 * Zero external dependencies. Runs in-process alongside FraudGuard.
 */

// ─── 1. Online Isolation Forest ─────────────────────────────────────────────

/**
 * Lightweight Isolation Forest that trains incrementally.
 *
 * How it works: Anomalies are "few and different" — they get isolated
 * in fewer random splits than normal data. Short path length = anomaly.
 *
 * We build small random trees from agent transaction features. Each new
 * transaction is scored by how quickly it gets isolated across all trees.
 * Score near 1.0 = anomaly. Score near 0.5 = normal.
 */

interface IsolationNode {
  /** Split feature index */
  splitFeature: number;
  /** Split value */
  splitValue: number;
  /** Left child (less than) */
  left: IsolationNode | null;
  /** Right child (greater than or equal) */
  right: IsolationNode | null;
  /** Number of samples that reached this node during training */
  size: number;
}

export class IsolationForest {
  private trees: IsolationNode[] = [];
  private readonly numTrees: number;
  private readonly maxSamples: number;
  private readonly maxDepth: number;
  /** Training data buffer — keeps recent samples for incremental retraining */
  private buffer: number[][] = [];
  private readonly bufferSize: number;
  private readonly featureNames: string[];

  constructor(opts?: {
    numTrees?: number;
    maxSamples?: number;
    maxDepth?: number;
    bufferSize?: number;
  }) {
    this.numTrees = opts?.numTrees ?? 50;
    this.maxSamples = opts?.maxSamples ?? 256;
    this.maxDepth = Math.ceil(Math.log2(this.maxSamples));
    this.bufferSize = opts?.bufferSize ?? 1000;
    this.featureNames = [
      "amount", "hourOfDay", "minutesSinceLast", "chargesLast10Min",
      "avgAmountLast10", "stdDevLast10", "pendingCount", "reputation",
    ];
  }

  /** Number of features expected per sample */
  get numFeatures(): number { return this.featureNames.length; }

  /**
   * Add a sample and retrain if buffer is full enough.
   * Features: [amount, hourOfDay, minutesSinceLast, chargesLast10Min,
   *            avgAmountLast10, stdDevLast10, pendingCount, reputation]
   */
  addSample(features: number[]): void {
    this.buffer.push(features);
    if (this.buffer.length > this.bufferSize) {
      this.buffer = this.buffer.slice(-this.bufferSize);
    }
    // Retrain after collecting enough samples
    if (this.buffer.length >= 20 && (this.trees.length === 0 || this.buffer.length % 50 === 0)) {
      this.train();
    }
  }

  /** Train forest from buffer */
  private train(): void {
    this.trees = [];
    for (let t = 0; t < this.numTrees; t++) {
      const sample = this.subsample(this.buffer, Math.min(this.maxSamples, this.buffer.length));
      this.trees.push(this.buildTree(sample, 0));
    }
  }

  /** Build a single isolation tree */
  private buildTree(data: number[][], depth: number): IsolationNode {
    if (depth >= this.maxDepth || data.length <= 1) {
      return { splitFeature: 0, splitValue: 0, left: null, right: null, size: data.length };
    }

    const numFeatures = data[0].length;
    const feature = Math.floor(Math.random() * numFeatures);

    // Find min/max for this feature
    let min = Infinity, max = -Infinity;
    for (const row of data) {
      if (row[feature] < min) min = row[feature];
      if (row[feature] > max) max = row[feature];
    }

    if (min === max) {
      return { splitFeature: feature, splitValue: min, left: null, right: null, size: data.length };
    }

    const splitValue = min + Math.random() * (max - min);
    const left: number[][] = [];
    const right: number[][] = [];

    for (const row of data) {
      if (row[feature] < splitValue) left.push(row);
      else right.push(row);
    }

    return {
      splitFeature: feature,
      splitValue,
      left: left.length > 0 ? this.buildTree(left, depth + 1) : null,
      right: right.length > 0 ? this.buildTree(right, depth + 1) : null,
      size: data.length,
    };
  }

  /**
   * Score a sample. Returns 0-1 where higher = more anomalous.
   * Returns -1 if not enough training data yet.
   */
  score(features: number[]): number {
    if (this.trees.length === 0) return -1;

    let totalPathLength = 0;
    for (const tree of this.trees) {
      totalPathLength += this.pathLength(features, tree, 0);
    }
    const avgPath = totalPathLength / this.trees.length;
    const n = Math.min(this.buffer.length, this.maxSamples);
    const c = this.avgPathLength(n);

    // Anomaly score: s(x, n) = 2^(-avgPath / c(n))
    return Math.pow(2, -avgPath / c);
  }

  /** Traverse tree and return path length to isolation */
  private pathLength(features: number[], node: IsolationNode, depth: number): number {
    if (!node.left && !node.right) {
      return depth + this.avgPathLength(node.size);
    }

    if (features[node.splitFeature] < node.splitValue) {
      return node.left ? this.pathLength(features, node.left, depth + 1) : depth + 1;
    }
    return node.right ? this.pathLength(features, node.right, depth + 1) : depth + 1;
  }

  /** Average path length of unsuccessful search in BST (used for normalization) */
  private avgPathLength(n: number): number {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    const H = Math.log(n - 1) + 0.5772156649; // Euler-Mascheroni constant
    return 2 * H - (2 * (n - 1) / n);
  }

  /** Random subsample without replacement */
  private subsample(data: number[][], size: number): number[][] {
    const copy = [...data];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, size);
  }

  /** Has enough data to score */
  get isReady(): boolean {
    return this.trees.length > 0;
  }

  get sampleCount(): number {
    return this.buffer.length;
  }

  // ── Serialization ──────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({ trees: this.trees, buffer: this.buffer });
  }

  static deserialize(json: string, opts?: ConstructorParameters<typeof IsolationForest>[0]): IsolationForest {
    const forest = new IsolationForest(opts);
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.trees) && data.trees.length <= 500) forest.trees = data.trees;
      if (Array.isArray(data.buffer) && data.buffer.length <= 50000) {
        forest.buffer = data.buffer.filter((n: unknown) => typeof n === "number" && Number.isFinite(n));
      }
    } catch (e) {
      console.error("[IsolationForest] deserialize failed:", (e as Error).message);
    }
    return forest;
  }
}


// ─── 2. Transaction Graph — Collusion & Wash Trading Detection ──────────────

interface GraphEdge {
  from: string;
  to: string;
  amount: number;
  timestamp: number;
  txId: string;
}

export interface CollusionSignal {
  type: "wash_trading" | "fraud_ring" | "sybil_cluster" | "self_dealing";
  agents: string[];
  evidence: string;
  severity: number; // 0-1
}

export class TransactionGraph {
  /** Adjacency list: agent → list of outgoing edges */
  private edges: Map<string, GraphEdge[]> = new Map();
  /** Agent metadata: IP, creation time, etc. */
  private agentMeta: Map<string, { ips: Set<string>; createdAt: number }> = new Map();
  /** Total edge count */
  private edgeCount = 0;

  /**
   * Record a transaction between two agents.
   * fromAgent paid toAgent.
   */
  addTransaction(fromAgent: string, toAgent: string, amount: number, txId: string): void {
    const edge: GraphEdge = { from: fromAgent, to: toAgent, amount, timestamp: Date.now(), txId };
    const list = this.edges.get(fromAgent) || [];
    list.push(edge);
    this.edges.set(fromAgent, list);
    this.edgeCount++;

    // Ensure both nodes exist
    if (!this.edges.has(toAgent)) this.edges.set(toAgent, []);
  }

  /** Register agent metadata for sybil detection */
  registerAgent(agentId: string, ip?: string): void {
    const meta = this.agentMeta.get(agentId) || { ips: new Set(), createdAt: Date.now() };
    if (ip) meta.ips.add(ip);
    this.agentMeta.set(agentId, meta);
  }

  /**
   * Detect wash trading: cycles where money flows A→B→...→A.
   * Returns cycles of length 2-4 (direct and indirect wash trading).
   */
  detectWashTrading(maxCycleLength = 4): CollusionSignal[] {
    const signals: CollusionSignal[] = [];
    const recentCutoff = Date.now() - 24 * 3_600_000; // Last 24h

    for (const [startAgent] of this.edges) {
      this.findCycles(startAgent, [startAgent], maxCycleLength, recentCutoff, signals);
    }

    // Deduplicate by sorting agent sets
    const seen = new Set<string>();
    return signals.filter((s) => {
      const key = [...s.agents].sort().join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private findCycles(
    current: string,
    path: string[],
    maxLen: number,
    cutoff: number,
    signals: CollusionSignal[],
  ): void {
    if (path.length > maxLen) return;

    const edges = this.edges.get(current) || [];
    for (const edge of edges) {
      if (edge.timestamp < cutoff) continue;

      if (edge.to === path[0] && path.length >= 2) {
        // Found a cycle
        const totalFlow = this.getCycleFlow(path, cutoff);
        signals.push({
          type: "wash_trading",
          agents: [...path],
          evidence: `Cycle detected: ${path.join(" → ")} → ${path[0]}. Flow: $${totalFlow.toFixed(2)} in last 24h`,
          severity: Math.min(0.3 + path.length * 0.15 + totalFlow * 0.002, 1.0),
        });
        return;
      }

      if (!path.includes(edge.to)) {
        this.findCycles(edge.to, [...path, edge.to], maxLen, cutoff, signals);
      }
    }
  }

  private getCycleFlow(path: string[], cutoff: number): number {
    let total = 0;
    for (let i = 0; i < path.length; i++) {
      const from = path[i];
      const to = path[(i + 1) % path.length];
      const edges = this.edges.get(from) || [];
      for (const e of edges) {
        if (e.to === to && e.timestamp >= cutoff) total += e.amount;
      }
    }
    return total;
  }

  /**
   * Detect sybil clusters: multiple agents sharing the same IP(s)
   * that also transact with each other.
   */
  detectSybilClusters(): CollusionSignal[] {
    const signals: CollusionSignal[] = [];

    // Group agents by shared IPs
    const ipToAgents: Map<string, string[]> = new Map();
    for (const [agentId, meta] of this.agentMeta) {
      for (const ip of meta.ips) {
        const agents = ipToAgents.get(ip) || [];
        agents.push(agentId);
        ipToAgents.set(ip, agents);
      }
    }

    // Find IPs with multiple agents that transact with each other
    for (const [ip, agents] of ipToAgents) {
      if (agents.length < 2) continue;

      // Check if these agents transact with each other
      let internalTxCount = 0;
      for (const a of agents) {
        const edges = this.edges.get(a) || [];
        for (const e of edges) {
          if (agents.includes(e.to)) internalTxCount++;
        }
      }

      if (internalTxCount > 0) {
        signals.push({
          type: "sybil_cluster",
          agents,
          evidence: `${agents.length} agents sharing IP ${ip.slice(0, 8)}... with ${internalTxCount} internal transactions`,
          severity: Math.min(0.4 + agents.length * 0.1 + internalTxCount * 0.05, 1.0),
        });
      }
    }

    return signals;
  }

  /**
   * Detect self-dealing: agent transacting with itself via intermediaries.
   * A→X→A pattern where X is a thin shell.
   */
  detectSelfDealing(): CollusionSignal[] {
    const signals: CollusionSignal[] = [];
    const recentCutoff = Date.now() - 24 * 3_600_000;

    for (const [agent, outEdges] of this.edges) {
      // Find all agents this one has paid recently
      const paidTo = new Set<string>();
      for (const e of outEdges) {
        if (e.timestamp >= recentCutoff) paidTo.add(e.to);
      }

      // Check if any of those agents paid back
      for (const target of paidTo) {
        if (target === agent) continue;
        const targetEdges = this.edges.get(target) || [];
        const paybacks = targetEdges.filter((e) => e.to === agent && e.timestamp >= recentCutoff);
        if (paybacks.length > 0) {
          const outFlow = outEdges.filter((e) => e.to === target && e.timestamp >= recentCutoff)
            .reduce((s, e) => s + e.amount, 0);
          const backFlow = paybacks.reduce((s, e) => s + e.amount, 0);
          // If back-flow is >50% of out-flow, likely self-dealing
          if (backFlow > outFlow * 0.5) {
            signals.push({
              type: "self_dealing",
              agents: [agent, target],
              evidence: `${agent} sent $${outFlow.toFixed(2)} to ${target}, got $${backFlow.toFixed(2)} back (${Math.round(backFlow / outFlow * 100)}% return)`,
              severity: Math.min(0.5 + (backFlow / outFlow) * 0.3, 1.0),
            });
          }
        }
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    return signals.filter((s) => {
      const key = [...s.agents].sort().join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Run all collusion detectors and return combined signals.
   */
  detectAll(): CollusionSignal[] {
    return [
      ...this.detectWashTrading(),
      ...this.detectSybilClusters(),
      ...this.detectSelfDealing(),
    ];
  }

  /** Get graph stats */
  stats(): { agents: number; edges: number; avgDegree: number } {
    const agents = this.edges.size;
    const avgDegree = agents > 0 ? this.edgeCount / agents : 0;
    return { agents, edges: this.edgeCount, avgDegree: Math.round(avgDegree * 100) / 100 };
  }

  // ── Serialization ──────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      edges: Array.from(this.edges.entries()),
      agentMeta: Array.from(this.agentMeta.entries()).map(([k, v]) => [k, { ips: Array.from(v.ips), createdAt: v.createdAt }]),
      edgeCount: this.edgeCount,
    });
  }

  static deserialize(json: string): TransactionGraph {
    const graph = new TransactionGraph();
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.edges) && data.edges.length <= 100000) {
        const validated = data.edges.filter(([k, v]: [unknown, unknown]) =>
          typeof k === "string" && Array.isArray(v) &&
          (v as unknown[]).every((e: any) => typeof e.from === "string" && typeof e.to === "string" && typeof e.amount === "number")
        );
        graph.edges = new Map(validated);
      }
      if (Array.isArray(data.agentMeta) && data.agentMeta.length <= 50000) {
        graph.agentMeta = new Map(
          data.agentMeta.map(([k, v]: [string, any]) => [k, { ips: new Set(Array.isArray(v.ips) ? v.ips.slice(0, 1000) : []), createdAt: v.createdAt }]),
        );
      }
      if (typeof data.edgeCount === "number" && Number.isFinite(data.edgeCount)) graph.edgeCount = data.edgeCount;
    } catch (e) {
      console.error("[TransactionGraph] deserialize failed:", (e as Error).message);
    }
    return graph;
  }
}


// ─── 3. Behavioral Fingerprinting (KYA-lite) ───────────────────────────────

export interface BehaviorSnapshot {
  /** Average charge amount */
  avgAmount: number;
  /** Standard deviation of charge amounts */
  stdAmount: number;
  /** Typical hour of day for activity (0-23) */
  peakHour: number;
  /** Average minutes between charges */
  avgInterval: number;
  /** Ratio of memory ops to payment ops */
  memoryToPaymentRatio: number;
  /** Average charges per active day */
  chargesPerDay: number;
  /** Number of samples used to build this profile */
  sampleCount: number;
  /** When this profile was last updated */
  updatedAt: number;
}

export interface DriftSignal {
  type: "amount_drift" | "timing_drift" | "frequency_drift" | "behavior_shift";
  description: string;
  /** How far from baseline (standard deviations) */
  deviation: number;
  /** Severity 0-1 */
  severity: number;
}

interface BehaviorEvent {
  type: "charge" | "settle" | "refund" | "remember" | "recall";
  amount?: number;
  timestamp: number;
}

export class BehaviorProfile {
  /** Per-agent behavior history */
  private agentEvents: Map<string, BehaviorEvent[]> = new Map();
  /** Per-agent baseline snapshots */
  private baselines: Map<string, BehaviorSnapshot> = new Map();
  /** Minimum events before baseline is established */
  private readonly minEvents: number;
  /** Max events to retain per agent */
  private readonly maxEvents: number;

  constructor(opts?: { minEvents?: number; maxEvents?: number }) {
    this.minEvents = opts?.minEvents ?? 15;
    this.maxEvents = opts?.maxEvents ?? 2000;
  }

  /** Record an event for an agent */
  recordEvent(agentId: string, type: BehaviorEvent["type"], amount?: number): void {
    const events = this.agentEvents.get(agentId) || [];
    events.push({ type, amount, timestamp: Date.now() });
    if (events.length > this.maxEvents) {
      events.splice(0, events.length - this.maxEvents);
    }
    this.agentEvents.set(agentId, events);

    // Rebuild baseline periodically
    if (events.length >= this.minEvents && events.length % 10 === 0) {
      this.buildBaseline(agentId);
    }
  }

  /** Build/update baseline from historical events */
  private buildBaseline(agentId: string): void {
    const events = this.agentEvents.get(agentId);
    if (!events || events.length < this.minEvents) return;

    const charges = events.filter((e) => e.type === "charge" && e.amount !== undefined);
    const memoryOps = events.filter((e) => e.type === "remember" || e.type === "recall");
    const paymentOps = events.filter((e) => e.type === "charge" || e.type === "settle" || e.type === "refund");

    if (charges.length < 5) return;

    const amounts = charges.map((e) => e.amount!);
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const stdAmount = Math.sqrt(
      amounts.reduce((s, a) => s + (a - avgAmount) ** 2, 0) / amounts.length,
    );

    // Peak hour
    const hourCounts = new Array(24).fill(0);
    for (const e of events) {
      hourCounts[new Date(e.timestamp).getHours()]++;
    }
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

    // Average interval between charges
    const chargeTimes = charges.map((e) => e.timestamp).sort();
    let intervalSum = 0;
    for (let i = 1; i < chargeTimes.length; i++) {
      intervalSum += chargeTimes[i] - chargeTimes[i - 1];
    }
    const avgInterval = chargeTimes.length > 1 ? intervalSum / (chargeTimes.length - 1) / 60_000 : 0;

    // Memory to payment ratio
    const memoryToPaymentRatio = paymentOps.length > 0 ? memoryOps.length / paymentOps.length : 0;

    // Charges per day
    const firstEvent = events[0].timestamp;
    const daySpan = Math.max((Date.now() - firstEvent) / 86_400_000, 1);
    const chargesPerDay = charges.length / daySpan;

    this.baselines.set(agentId, {
      avgAmount,
      stdAmount,
      peakHour,
      avgInterval,
      memoryToPaymentRatio,
      chargesPerDay,
      sampleCount: events.length,
      updatedAt: Date.now(),
    });
  }

  /**
   * Check if current behavior drifts from baseline.
   * Pass recent charge amount and context.
   */
  detectDrift(agentId: string, currentAmount?: number): DriftSignal[] {
    const baseline = this.baselines.get(agentId);
    if (!baseline) return []; // No baseline yet

    const signals: DriftSignal[] = [];
    const events = this.agentEvents.get(agentId) || [];
    const recentEvents = events.filter((e) => Date.now() - e.timestamp < 3_600_000); // Last hour

    // 1. Amount drift
    if (currentAmount !== undefined && baseline.stdAmount > 0) {
      const zScore = Math.abs(currentAmount - baseline.avgAmount) / baseline.stdAmount;
      if (zScore > 2.5) {
        signals.push({
          type: "amount_drift",
          description: `Charge $${currentAmount.toFixed(2)} is ${zScore.toFixed(1)}σ from baseline avg $${baseline.avgAmount.toFixed(2)}`,
          deviation: zScore,
          severity: Math.min(0.2 + zScore * 0.15, 0.9),
        });
      }
    }

    // 2. Timing drift — activity outside normal hours
    const currentHour = new Date().getHours();
    const hourDiff = Math.min(
      Math.abs(currentHour - baseline.peakHour),
      24 - Math.abs(currentHour - baseline.peakHour),
    );
    if (hourDiff >= 8 && events.length > 30) {
      signals.push({
        type: "timing_drift",
        description: `Activity at ${currentHour}:00, usual peak is ${baseline.peakHour}:00 (${hourDiff}h off)`,
        deviation: hourDiff / 12,
        severity: Math.min(0.1 + hourDiff * 0.05, 0.5),
      });
    }

    // 3. Frequency drift — sudden burst vs normal pace
    const recentCharges = recentEvents.filter((e) => e.type === "charge");
    if (baseline.chargesPerDay > 0 && recentCharges.length > 0) {
      const expectedPerHour = baseline.chargesPerDay / 24;
      const actualPerHour = recentCharges.length;
      if (expectedPerHour > 0 && actualPerHour > expectedPerHour * 5) {
        signals.push({
          type: "frequency_drift",
          description: `${actualPerHour} charges/hour vs baseline ${expectedPerHour.toFixed(1)}/hour (${(actualPerHour / expectedPerHour).toFixed(0)}x normal)`,
          deviation: actualPerHour / expectedPerHour,
          severity: Math.min(0.3 + (actualPerHour / expectedPerHour) * 0.05, 0.8),
        });
      }
    }

    // 4. Behavioral shift — memory/payment ratio changed
    const recentMemory = recentEvents.filter((e) => e.type === "remember" || e.type === "recall").length;
    const recentPayment = recentEvents.filter((e) => e.type === "charge" || e.type === "settle" || e.type === "refund").length;
    if (baseline.memoryToPaymentRatio > 0 && recentPayment > 3) {
      const currentRatio = recentMemory / recentPayment;
      const ratioDiff = Math.abs(currentRatio - baseline.memoryToPaymentRatio) / Math.max(baseline.memoryToPaymentRatio, 0.1);
      if (ratioDiff > 3) {
        signals.push({
          type: "behavior_shift",
          description: `Memory/payment ratio shifted: ${currentRatio.toFixed(1)} vs baseline ${baseline.memoryToPaymentRatio.toFixed(1)}`,
          deviation: ratioDiff,
          severity: Math.min(0.2 + ratioDiff * 0.1, 0.6),
        });
      }
    }

    return signals;
  }

  /** Get an agent's current baseline (if established) */
  getBaseline(agentId: string): BehaviorSnapshot | undefined {
    return this.baselines.get(agentId);
  }

  /** Check if agent has established baseline */
  hasBaseline(agentId: string): boolean {
    return this.baselines.has(agentId);
  }

  // ── Serialization ──────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      agentEvents: Array.from(this.agentEvents.entries()),
      baselines: Array.from(this.baselines.entries()),
    });
  }

  static deserialize(json: string, opts?: ConstructorParameters<typeof BehaviorProfile>[0]): BehaviorProfile {
    const profile = new BehaviorProfile(opts);
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.agentEvents) && data.agentEvents.length <= 10000) {
        const validated = data.agentEvents.filter(([k, v]: [unknown, unknown]) => typeof k === "string" && Array.isArray(v));
        profile.agentEvents = new Map(validated.map(([k, v]: [string, any[]]) => [k, v.slice(0, 5000)]));
      }
      if (Array.isArray(data.baselines) && data.baselines.length <= 10000) {
        profile.baselines = new Map(data.baselines.filter(([k]: [unknown]) => typeof k === "string"));
      }
    } catch (e) {
      console.error("[BehaviorProfile] deserialize failed:", (e as Error).message);
    }
    return profile;
  }
}
