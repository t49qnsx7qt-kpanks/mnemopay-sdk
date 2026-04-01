/**
 * @mnemopay/sdk — Give any AI agent memory and a wallet in 5 lines.
 *
 * MnemoPay unifies Mnemosyne (cognitive memory) and AgentPay (escrow economics)
 * into a single SDK. The core innovation: payment outcomes reinforce the memories
 * that led to successful decisions.
 *
 * Two modes, identical API:
 *   MnemoPay.quick("id")     → zero infra, in-memory (dev/testing)
 *   MnemoPay.create({...})   → Postgres + Redis (production)
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { RecallEngine, type RecallStrategy, type EmbeddingProvider, type RecallEngineConfig } from "./recall/engine.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MnemoPayConfig {
  agentId: string;
  /** Recall strategy: "score" (default), "vector", or "hybrid" */
  recall?: RecallStrategy;
  /** Embedding provider for vector/hybrid: "openai" or "local" (default) */
  embeddings?: EmbeddingProvider;
  /** OpenAI API key for embeddings (or set OPENAI_API_KEY env var) */
  openaiApiKey?: string;
  /** Weight for score component in hybrid mode (0-1, default: 0.4) */
  scoreWeight?: number;
  /** Weight for vector component in hybrid mode (0-1, default: 0.6) */
  vectorWeight?: number;
  /** Mnemosyne API base URL */
  mnemoUrl?: string;
  /** AgentPay API base URL */
  agentpayUrl?: string;
  /** Redis connection URL (for event bus) */
  redis?: string;
  /** Postgres connection URL (for durable storage) */
  db?: string;
  /** Memory decay rate λ (default 0.05, half-life ~14h) */
  decay?: number;
  /** Log internal operations */
  debug?: boolean;
  /** API key for Mnemosyne */
  mnemoApiKey?: string;
  /** API key for AgentPay */
  agentpayApiKey?: string;
}

export interface Memory {
  id: string;
  agentId: string;
  content: string;
  importance: number;
  score: number;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
}

export interface RememberOptions {
  importance?: number;
  tags?: string[];
}

export interface Transaction {
  id: string;
  agentId: string;
  amount: number;
  reason: string;
  status: "pending" | "completed" | "refunded";
  createdAt: Date;
  completedAt?: Date;
}

export interface AgentProfile {
  id: string;
  reputation: number;
  wallet: number;
  memoriesCount: number;
  transactionsCount: number;
}

export interface BalanceInfo {
  wallet: number;
  reputation: number;
}

export interface AuditEntry {
  id: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

// ─── Auto-scoring keywords ─────────────────────────────────────────────────

const IMPORTANCE_PATTERNS: Array<{ pattern: RegExp; boost: number }> = [
  { pattern: /\b(error|fail|crash|critical|broken|bug)\b/i, boost: 0.20 },
  { pattern: /\b(success|complete|paid|delivered|resolved)\b/i, boost: 0.15 },
  { pattern: /\b(prefer|always|never|important|must|require)\b/i, boost: 0.15 },
];

const LONG_CONTENT_THRESHOLD = 200;
const LONG_CONTENT_BOOST = 0.10;
const BASE_IMPORTANCE = 0.50;

function autoScore(content: string): number {
  let score = BASE_IMPORTANCE;
  if (content.length > LONG_CONTENT_THRESHOLD) score += LONG_CONTENT_BOOST;
  for (const { pattern, boost } of IMPORTANCE_PATTERNS) {
    if (pattern.test(content)) score += boost;
  }
  return Math.min(score, 1.0);
}

// ─── Memory scoring ────────────────────────────────────────────────────────

function computeScore(
  importance: number,
  lastAccessed: Date,
  accessCount: number,
  decay: number
): number {
  const hoursSince = (Date.now() - lastAccessed.getTime()) / 3_600_000;
  const recency = Math.exp(-decay * hoursSince);
  const frequency = 1 + Math.log(1 + accessCount);
  return importance * recency * frequency;
}

// ─── MnemoPayLite (in-memory, zero dependencies) ───────────────────────────

export class MnemoPayLite extends EventEmitter {
  readonly agentId: string;
  private decay: number;
  private debugMode: boolean;
  private memories: Map<string, Memory> = new Map();
  private transactions: Map<string, Transaction> = new Map();
  private auditLog: AuditEntry[] = [];
  private _wallet: number = 0;
  private _reputation: number = 0.5;
  private recallEngine: RecallEngine;

  constructor(agentId: string, decay = 0.05, debug = false, recallConfig?: Partial<RecallEngineConfig>) {
    super();
    this.agentId = agentId;
    this.decay = decay;
    this.debugMode = debug;
    this.recallEngine = new RecallEngine(recallConfig);
    this.log(`MnemoPayLite initialized (in-memory mode, recall: ${this.recallEngine.strategy})`);
    setTimeout(() => this.emit("ready"), 0);
  }

  private log(msg: string): void {
    if (this.debugMode) console.log(`[mnemopay:${this.agentId}] ${msg}`);
  }

  private audit(action: string, details: Record<string, unknown>): void {
    const entry: AuditEntry = {
      id: randomUUID(),
      agentId: this.agentId,
      action,
      details,
      createdAt: new Date(),
    };
    this.auditLog.push(entry);
  }

  // ── Memory Methods ──────────────────────────────────────────────────────

  async remember(content: string, opts?: RememberOptions): Promise<string> {
    const importance = opts?.importance ?? autoScore(content);
    const now = new Date();
    const mem: Memory = {
      id: randomUUID(),
      agentId: this.agentId,
      content,
      importance: Math.min(Math.max(importance, 0), 1),
      score: importance,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      tags: opts?.tags ?? [],
    };
    this.memories.set(mem.id, mem);

    // Generate embedding if using vector/hybrid recall
    if (this.recallEngine.strategy !== "score") {
      await this.recallEngine.embed(mem.id, content);
    }

    this.audit("memory:stored", { id: mem.id, content: content.slice(0, 100), importance: mem.importance });
    this.emit("memory:stored", { id: mem.id, content, importance: mem.importance });
    this.log(`Stored memory: "${content.slice(0, 60)}..." (importance: ${mem.importance.toFixed(2)})`);
    return mem.id;
  }

  async recall(limit?: number): Promise<Memory[]>;
  async recall(query: string, limit?: number): Promise<Memory[]>;
  async recall(queryOrLimit?: string | number, maybeLimit?: number): Promise<Memory[]> {
    // Parse overloaded args
    const query = typeof queryOrLimit === "string" ? queryOrLimit : undefined;
    const limit = typeof queryOrLimit === "number" ? queryOrLimit : (maybeLimit ?? 5);

    // Compute decay scores for all memories
    const all = Array.from(this.memories.values()).map((m) => {
      m.score = computeScore(m.importance, m.lastAccessed, m.accessCount, this.decay);
      return m;
    });

    let results: Memory[];

    if (this.recallEngine.strategy !== "score" && query) {
      // Use vector/hybrid search with the query
      const searchResults = await this.recallEngine.search(query, all, limit);
      results = searchResults.map((r) => {
        const mem = this.memories.get(r.id)!;
        mem.score = r.combinedScore;
        return mem;
      });
    } else {
      // Default: score-based ranking
      all.sort((a, b) => b.score - a.score);
      results = all.slice(0, limit);
    }

    const now = new Date();
    for (const m of results) {
      m.lastAccessed = now;
      m.accessCount++;
    }
    this.emit("memory:recalled", { count: results.length });
    this.log(`Recalled ${results.length} memories (strategy: ${this.recallEngine.strategy})`);
    return results;
  }

  async forget(id: string): Promise<boolean> {
    const existed = this.memories.delete(id);
    if (existed) {
      this.recallEngine.remove(id);
      this.audit("memory:deleted", { id });
      this.log(`Forgot memory: ${id}`);
    }
    return existed;
  }

  async reinforce(id: string, boost = 0.1): Promise<void> {
    const mem = this.memories.get(id);
    if (!mem) throw new Error(`Memory ${id} not found`);
    mem.importance = Math.min(mem.importance + boost, 1.0);
    mem.lastAccessed = new Date();
    this.audit("memory:reinforced", { id, boost, newImportance: mem.importance });
    this.log(`Reinforced memory ${id} by +${boost} → ${mem.importance.toFixed(2)}`);
  }

  async consolidate(): Promise<number> {
    const threshold = 0.01;
    let pruned = 0;
    for (const [id, mem] of this.memories) {
      const score = computeScore(mem.importance, mem.lastAccessed, mem.accessCount, this.decay);
      if (score < threshold) {
        this.memories.delete(id);
        pruned++;
      }
    }
    this.audit("memory:consolidated", { pruned });
    this.log(`Consolidated: pruned ${pruned} stale memories`);
    return pruned;
  }

  // ── Payment Methods ─────────────────────────────────────────────────────

  async charge(amount: number, reason: string): Promise<Transaction> {
    if (amount <= 0) throw new Error("Amount must be positive");
    const maxCharge = 500 * this._reputation;
    if (amount > maxCharge) {
      throw new Error(
        `Amount $${amount.toFixed(2)} exceeds reputation ceiling $${maxCharge.toFixed(2)} ` +
        `(reputation: ${this._reputation.toFixed(2)}, max: $${maxCharge.toFixed(2)})`
      );
    }
    const tx: Transaction = {
      id: randomUUID(),
      agentId: this.agentId,
      amount,
      reason,
      status: "pending",
      createdAt: new Date(),
    };
    this.transactions.set(tx.id, tx);
    this.audit("payment:pending", { id: tx.id, amount, reason });
    this.emit("payment:pending", { id: tx.id, amount, reason });
    this.log(`Charge created: $${amount.toFixed(2)} for "${reason}" (pending)`);
    return { ...tx };
  }

  async settle(txId: string): Promise<Transaction> {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status !== "pending") throw new Error(`Transaction ${txId} is ${tx.status}, not pending`);

    // 1. Move funds to wallet
    tx.status = "completed";
    tx.completedAt = new Date();
    this._wallet += tx.amount;

    // 2. Boost reputation
    this._reputation = Math.min(this._reputation + 0.01, 1.0);

    // 3. Reinforce recently-accessed memories (feedback loop)
    const oneHourAgo = Date.now() - 3_600_000;
    let reinforced = 0;
    for (const mem of this.memories.values()) {
      if (mem.lastAccessed.getTime() > oneHourAgo) {
        mem.importance = Math.min(mem.importance + 0.05, 1.0);
        reinforced++;
      }
    }

    this.audit("payment:completed", { id: tx.id, amount: tx.amount, reinforcedMemories: reinforced });
    this.emit("payment:completed", { id: tx.id, amount: tx.amount });
    this.log(
      `Settled $${tx.amount.toFixed(2)} → wallet: $${this._wallet.toFixed(2)}, ` +
      `reputation: ${this._reputation.toFixed(2)}, reinforced: ${reinforced} memories`
    );
    return { ...tx };
  }

  async refund(txId: string): Promise<Transaction> {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status === "refunded") throw new Error(`Transaction ${txId} already refunded`);

    if (tx.status === "completed") {
      this._wallet -= tx.amount;
      this._reputation = Math.max(this._reputation - 0.05, 0);
    }
    tx.status = "refunded";

    this.audit("payment:refunded", { id: tx.id, amount: tx.amount });
    this.emit("payment:refunded", { id: tx.id });
    this.log(`Refunded $${tx.amount.toFixed(2)} → reputation: ${this._reputation.toFixed(2)}`);
    return { ...tx };
  }

  async balance(): Promise<BalanceInfo> {
    return { wallet: this._wallet, reputation: this._reputation };
  }

  // ── Observability ───────────────────────────────────────────────────────

  async profile(): Promise<AgentProfile> {
    return {
      id: this.agentId,
      reputation: this._reputation,
      wallet: this._wallet,
      memoriesCount: this.memories.size,
      transactionsCount: this.transactions.size,
    };
  }

  async logs(limit = 50): Promise<AuditEntry[]> {
    return this.auditLog.slice(-limit);
  }

  async history(limit = 20): Promise<Transaction[]> {
    const all = Array.from(this.transactions.values());
    // Reverse insertion order (Map preserves insertion order)
    all.reverse();
    return all.slice(0, limit).map((tx) => ({ ...tx }));
  }

  async disconnect(): Promise<void> {
    this.log("Disconnected (in-memory mode, data discarded)");
  }
}

// ─── MnemoPay (production — talks to Mnemosyne + AgentPay backends) ────────

export class MnemoPay extends EventEmitter {
  readonly agentId: string;
  private config: Required<
    Pick<MnemoPayConfig, "mnemoUrl" | "agentpayUrl" | "decay" | "debug">
  > & { mnemoApiKey?: string; agentpayApiKey?: string };
  private headers: Record<string, string>;

  constructor(config: MnemoPayConfig) {
    super();
    this.agentId = config.agentId;
    this.config = {
      mnemoUrl: config.mnemoUrl || "http://localhost:8100",
      agentpayUrl: config.agentpayUrl || "http://localhost:3100",
      decay: config.decay ?? 0.05,
      debug: config.debug ?? false,
      mnemoApiKey: config.mnemoApiKey,
      agentpayApiKey: config.agentpayApiKey,
    };
    this.headers = {
      "Content-Type": "application/json",
      "X-Agent-ID": this.agentId,
    };
    this.log("MnemoPay initialized (production mode)");
    this.init();
  }

  private async init(): Promise<void> {
    try {
      // Register agent with AgentPay if it doesn't exist
      await this.agentpayFetch("/api/agents", {
        method: "POST",
        body: JSON.stringify({ agentId: this.agentId, name: this.agentId }),
      }).catch(() => {});
      this.emit("ready");
    } catch {
      this.emit("ready");
    }
  }

  private log(msg: string): void {
    if (this.config.debug) console.log(`[mnemopay:${this.agentId}] ${msg}`);
  }

  private async mnemoFetch(path: string, init?: RequestInit): Promise<any> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.config.mnemoApiKey) headers["Authorization"] = `Bearer ${this.config.mnemoApiKey}`;
    const res = await fetch(`${this.config.mnemoUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mnemosyne ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private async agentpayFetch(path: string, init?: RequestInit): Promise<any> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.config.agentpayApiKey) headers["Authorization"] = `Bearer ${this.config.agentpayApiKey}`;
    const res = await fetch(`${this.config.agentpayUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AgentPay ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── Memory Methods (→ Mnemosyne API) ───────────────────────────────────

  async remember(content: string, opts?: RememberOptions): Promise<string> {
    const importance = opts?.importance ?? autoScore(content);
    const result = await this.mnemoFetch("/v1/memory", {
      method: "POST",
      body: JSON.stringify({
        content,
        tier: "long_term",
        metadata: {
          memory_type: "OBSERVATION",
          tags: opts?.tags ?? [],
          confidence: importance,
        },
      }),
    });
    this.emit("memory:stored", { id: result.id, content, importance });
    this.log(`Stored memory: "${content.slice(0, 60)}..." (id: ${result.id})`);
    return result.id;
  }

  async recall(limit = 5): Promise<Memory[]> {
    const result = await this.mnemoFetch("/v1/memory/search", {
      method: "POST",
      body: JSON.stringify({
        query: "*",
        top_k: limit,
        min_retrievability: 0.01,
      }),
    });
    const memories: Memory[] = (result.results || []).map((r: any) => ({
      id: r.id,
      agentId: this.agentId,
      content: r.content,
      importance: r.retrievability ?? 0.5,
      score: r.score ?? 0,
      createdAt: new Date(r.created_at || Date.now()),
      lastAccessed: new Date(),
      accessCount: r.access_count ?? 0,
      tags: r.tags ?? [],
    }));
    this.emit("memory:recalled", { count: memories.length });
    this.log(`Recalled ${memories.length} memories`);
    return memories;
  }

  async forget(id: string): Promise<boolean> {
    try {
      await this.mnemoFetch(`/v1/memory/${id}`, { method: "DELETE" });
      this.log(`Forgot memory: ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async reinforce(id: string, boost = 0.1): Promise<void> {
    await this.mnemoFetch(`/v1/memory/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ grade: boost >= 0.15 ? 4 : 3 }),
    });
    this.log(`Reinforced memory ${id}`);
  }

  async consolidate(): Promise<number> {
    const result = await this.mnemoFetch("/v1/consolidate", {
      method: "POST",
      body: JSON.stringify({ namespace: `agent:${this.agentId}`, scope: "incremental", dry_run: false }),
    });
    const pruned = result?.phases?.prune?.pruned ?? 0;
    this.log(`Consolidated: pruned ${pruned} stale memories`);
    return pruned;
  }

  // ── Payment Methods (→ AgentPay API) ───────────────────────────────────

  async charge(amount: number, reason: string): Promise<Transaction> {
    if (amount <= 0) throw new Error("Amount must be positive");
    const result = await this.agentpayFetch("/api/escrow", {
      method: "POST",
      body: JSON.stringify({
        agentId: this.agentId,
        amount,
        reason,
        currency: "USD",
      }),
    });
    const tx: Transaction = {
      id: result.id,
      agentId: this.agentId,
      amount,
      reason,
      status: "pending",
      createdAt: new Date(result.createdAt || Date.now()),
    };
    this.emit("payment:pending", { id: tx.id, amount, reason });
    this.log(`Charge created: $${amount.toFixed(2)} for "${reason}"`);
    return tx;
  }

  async settle(txId: string): Promise<Transaction> {
    const result = await this.agentpayFetch(`/api/escrow/${txId}/release`, {
      method: "POST",
    });
    this.emit("payment:completed", { id: txId, amount: result.amount });
    this.log(`Settled: $${result.amount?.toFixed(2)}`);
    return {
      id: txId,
      agentId: this.agentId,
      amount: result.amount,
      reason: result.reason || "",
      status: "completed",
      createdAt: new Date(result.createdAt || Date.now()),
      completedAt: new Date(),
    };
  }

  async refund(txId: string): Promise<Transaction> {
    const result = await this.agentpayFetch(`/api/escrow/${txId}/refund`, {
      method: "POST",
    });
    this.emit("payment:refunded", { id: txId });
    this.log(`Refunded: ${txId}`);
    return {
      id: txId,
      agentId: this.agentId,
      amount: result.amount,
      reason: result.reason || "",
      status: "refunded",
      createdAt: new Date(result.createdAt || Date.now()),
    };
  }

  async balance(): Promise<BalanceInfo> {
    const result = await this.agentpayFetch(`/api/agents/${this.agentId}/wallet`);
    return {
      wallet: result.balance ?? 0,
      reputation: result.reputation ?? 0.5,
    };
  }

  // ── Observability ─────────────────────────────────────────────────────

  async profile(): Promise<AgentProfile> {
    const [agentInfo, bal] = await Promise.all([
      this.agentpayFetch(`/api/agents/${this.agentId}`).catch(() => null),
      this.balance(),
    ]);
    return {
      id: this.agentId,
      reputation: bal.reputation,
      wallet: bal.wallet,
      memoriesCount: agentInfo?.memoriesCount ?? 0,
      transactionsCount: agentInfo?.transactionsCount ?? 0,
    };
  }

  async logs(limit = 50): Promise<AuditEntry[]> {
    const result = await this.agentpayFetch(`/api/events/audit?limit=${limit}`);
    return (result.entries || result || []).map((e: any) => ({
      id: e.id,
      agentId: e.agentId || this.agentId,
      action: e.action || e.type,
      details: e.details || e.data || {},
      createdAt: new Date(e.createdAt || e.timestamp || Date.now()),
    }));
  }

  async history(limit = 20): Promise<Transaction[]> {
    const result = await this.agentpayFetch(`/api/agents/${this.agentId}/transactions?limit=${limit}`);
    return (result.transactions || result || []).map((t: any) => ({
      id: t.id,
      agentId: t.agentId || this.agentId,
      amount: t.amount,
      reason: t.reason || t.description || "",
      status: t.status,
      createdAt: new Date(t.createdAt || Date.now()),
      completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
    }));
  }

  async disconnect(): Promise<void> {
    this.log("Disconnected");
  }

  // ── Static factory methods ────────────────────────────────────────────

  /**
   * Zero-infrastructure mode. In-memory, no database, no Redis.
   * Perfect for development, testing, and demos.
   */
  static quick(agentId: string, opts?: {
    decay?: number;
    debug?: boolean;
    recall?: RecallStrategy;
    embeddings?: EmbeddingProvider;
    openaiApiKey?: string;
    scoreWeight?: number;
    vectorWeight?: number;
  }): MnemoPayLite {
    const recallConfig: Partial<RecallEngineConfig> | undefined = opts?.recall
      ? {
          strategy: opts.recall,
          embeddingProvider: opts.embeddings,
          openaiApiKey: opts.openaiApiKey,
          scoreWeight: opts.scoreWeight,
          vectorWeight: opts.vectorWeight,
        }
      : undefined;
    return new MnemoPayLite(agentId, opts?.decay ?? 0.05, opts?.debug ?? false, recallConfig);
  }

  /**
   * Production mode. Connects to Mnemosyne + AgentPay backends.
   * Requires running services (use docker-compose.yml).
   */
  static create(config: MnemoPayConfig): MnemoPay {
    return new MnemoPay(config);
  }
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export default MnemoPay;
export { autoScore, computeScore };
export { RecallEngine, cosineSimilarity, localEmbed, l2Normalize } from "./recall/engine.js";
export type { RecallStrategy, EmbeddingProvider, RecallEngineConfig, RecallResult } from "./recall/engine.js";
