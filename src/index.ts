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

import { RecallEngine, type RecallStrategy, type EmbeddingProvider, type RecallEngineConfig } from "./recall/engine.js";
import { FraudGuard, type FraudConfig, type RiskAssessment, type Dispute, type PlatformFeeRecord, type RequestContext } from "./fraud.js";
import { type PaymentRail, MockRail } from "./rails/index.js";
import { type StorageAdapter, JSONFileStorage } from "./storage/sqlite.js";

// ─── Browser-compatible EventEmitter ──────────────────────────────────────
// Replaces Node's "events" module so MnemoPayLite runs in browsers too.

type Listener = (...args: any[]) => void;

class EventEmitter {
  private _events: Map<string, Listener[]> = new Map();

  on(event: string, fn: Listener): this {
    const listeners = this._events.get(event) || [];
    listeners.push(fn);
    this._events.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const listeners = this._events.get(event);
    if (!listeners || listeners.length === 0) return false;
    for (const fn of listeners) fn(...args);
    return true;
  }

  removeListener(event: string, fn: Listener): this {
    const listeners = this._events.get(event);
    if (listeners) {
      this._events.set(event, listeners.filter(l => l !== fn));
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this._events.delete(event);
    else this._events.clear();
    return this;
  }
}

// ─── Browser-compatible UUID ──────────────────────────────────────────────

function randomUUID(): string {
  return crypto.randomUUID();
}

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
  status: "pending" | "completed" | "refunded" | "disputed";
  createdAt: Date;
  completedAt?: Date;
  /** Platform fee deducted on settlement */
  platformFee?: number;
  /** Net amount after fee */
  netAmount?: number;
  /** Fraud risk score at time of charge */
  riskScore?: number;
  /** External payment rail ID (Stripe PaymentIntent, Lightning invoice, etc.) */
  externalId?: string;
  /** External payment rail status */
  externalStatus?: string;
  /** Counter-party agent ID (required when requireCounterparty is enabled) */
  counterpartyId?: string;
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

// ─── Reputation ────────────────────────────────────────────────────────────

export interface ReputationReport {
  agentId: string;
  /** Overall reputation score 0-1 */
  score: number;
  /** Reputation tier: untrusted | newcomer | established | trusted | exemplary */
  tier: "untrusted" | "newcomer" | "established" | "trusted" | "exemplary";
  /** Total successful settlements */
  settledCount: number;
  /** Total refunds issued */
  refundCount: number;
  /** Settlement rate (settled / total completed) */
  settlementRate: number;
  /** Total value settled */
  totalValueSettled: number;
  /** Total memories stored */
  memoriesCount: number;
  /** Average memory importance */
  avgMemoryImportance: number;
  /** Account age in hours */
  ageHours: number;
  /** Generated at */
  generatedAt: Date;
}

function reputationTier(score: number): ReputationReport["tier"] {
  if (score >= 0.9) return "exemplary";
  if (score >= 0.7) return "trusted";
  if (score >= 0.4) return "established";
  if (score >= 0.2) return "newcomer";
  return "untrusted";
}

// ─── A2A Agent Card ────────────────────────────────────────────────────────

export interface AgentCard {
  name: string;
  description: string;
  url?: string;
  version: string;
  capabilities: {
    memory: boolean;
    payments: boolean;
    reputation: boolean;
  };
  protocols: string[];
  tools: string[];
  contact?: string;
}

// ─── x402 Settlement ───────────────────────────────────────────────────────

export interface X402Config {
  /** x402 facilitator URL */
  facilitatorUrl: string;
  /** Payment token (e.g. "USDC") */
  token?: string;
  /** Chain (e.g. "base", "ethereum") */
  chain?: string;
  /** Agent wallet address */
  walletAddress?: string;
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
  private _createdAt: Date = new Date();
  private x402?: X402Config;
  private persistPath?: string;
  private persistTimer?: ReturnType<typeof setInterval>;
  private storageAdapter?: StorageAdapter;
  /** Fraud detection, rate limiting, dispute resolution, and platform fee */
  readonly fraud: FraudGuard;
  /** Pluggable payment rail (Stripe, Lightning, etc.). Default: in-memory mock. */
  readonly paymentRail: PaymentRail;
  /** When true, settle() requires a different agentId than the charge creator */
  readonly requireCounterparty: boolean;

  constructor(agentId: string, decay = 0.05, debug = false, recallConfig?: Partial<RecallEngineConfig>, fraudConfig?: Partial<FraudConfig>, paymentRail?: PaymentRail, requireCounterparty = false, storage?: StorageAdapter) {
    super();
    this.agentId = agentId;
    this.decay = decay;
    this.debugMode = debug;
    this.recallEngine = new RecallEngine(recallConfig);
    this.fraud = new FraudGuard(fraudConfig);
    this.paymentRail = paymentRail ?? new MockRail();
    this.requireCounterparty = requireCounterparty;

    // Use provided storage adapter, or auto-detect persistence
    if (storage) {
      this.storageAdapter = storage;
      this._loadFromStorage();
    } else {
      // Auto-detect persistence: MNEMOPAY_PERSIST_DIR env > ~/.mnemopay/data (always on in Node.js)
      // Disabled during tests to ensure clean state
      const isTest = typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || process.env?.VITEST);
      const persistDir = !isTest && typeof process !== "undefined"
        ? process.env?.MNEMOPAY_PERSIST_DIR ||
          (() => { try { return require("path").join(require("os").homedir(), ".mnemopay", "data"); } catch { return undefined; } })()
        : undefined;
      if (persistDir) {
        this.enablePersistence(persistDir);
      }
    }

    const storageMode = this.storageAdapter ? this.storageAdapter.constructor.name : (this.persistPath ? "json-file" : "in-memory");
    this.log(`MnemoPayLite initialized (${storageMode}, recall: ${this.recallEngine.strategy}, rail: ${this.paymentRail.name})`);
    setTimeout(() => this.emit("ready"), 0);
  }

  // ── Persistence ────────────────────────────────────────────────────────

  enablePersistence(dir: string): void {
    try {
      const fs = require("fs");
      const path = require("path");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.persistPath = path.join(dir, `${this.agentId}.json`);
      this._loadFromDisk();
      // Auto-save every 30 seconds
      this.persistTimer = setInterval(() => this._saveToDisk(), 30_000);
      this.log(`Persistence enabled: ${this.persistPath}`);
    } catch (e) {
      this.log(`Persistence unavailable (browser?): ${e}`);
    }
  }

  private _loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const fs = require("fs");
      if (!fs.existsSync(this.persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
      // Restore memories
      if (raw.memories) {
        for (const m of raw.memories) {
          m.createdAt = new Date(m.createdAt);
          m.lastAccessed = new Date(m.lastAccessed);
          this.memories.set(m.id, m);
        }
      }
      // Restore transactions
      if (raw.transactions) {
        for (const t of raw.transactions) {
          t.createdAt = new Date(t.createdAt);
          if (t.completedAt) t.completedAt = new Date(t.completedAt);
          this.transactions.set(t.id, t);
        }
      }
      // Restore state
      if (raw.wallet !== undefined) this._wallet = raw.wallet;
      if (raw.reputation !== undefined) this._reputation = raw.reputation;
      if (raw.createdAt) this._createdAt = new Date(raw.createdAt);
      if (raw.auditLog) {
        this.auditLog = raw.auditLog.map((e: any) => ({ ...e, createdAt: new Date(e.createdAt) }));
      }
      // Restore fraud guard state
      if (raw.fraudGuard) {
        try {
          const restored = FraudGuard.deserialize(raw.fraudGuard, this.fraud.config);
          // Copy restored state into existing guard (preserve config from constructor)
          Object.assign(this.fraud, {
            // Only copy internal state, not config
          });
          // Re-create fraud guard with restored data
          const restoredGuard = FraudGuard.deserialize(raw.fraudGuard, this.fraud.config);
          (this as any).fraud = restoredGuard;
        } catch (e) {
          this.log(`Failed to restore fraud guard state: ${e}`);
        }
      }
      this.log(`Loaded ${this.memories.size} memories, ${this.transactions.size} transactions from disk`);
    } catch (e) {
      this.log(`Failed to load persisted data: ${e}`);
    }
  }

  private _saveToStorage(): void {
    if (!this.storageAdapter) return;
    try {
      this.storageAdapter.save({
        agentId: this.agentId,
        wallet: this._wallet,
        reputation: this._reputation,
        createdAt: this._createdAt.toISOString(),
        memories: Array.from(this.memories.values()).map(m => ({
          ...m,
          createdAt: m.createdAt.toISOString(),
          lastAccessed: m.lastAccessed.toISOString(),
          tags: JSON.stringify(m.tags),
        })) as any,
        transactions: Array.from(this.transactions.values()).map(t => ({
          ...t,
          createdAt: t.createdAt.toISOString(),
          completedAt: t.completedAt?.toISOString(),
        })) as any,
        auditLog: this.auditLog.slice(-500).map(a => ({
          ...a,
          details: JSON.stringify(a.details),
          createdAt: a.createdAt.toISOString(),
        })) as any,
        fraudGuard: this.fraud.serialize(),
      });
    } catch (e) {
      this.log(`Failed to save to storage: ${e}`);
    }
  }

  private _loadFromStorage(): void {
    if (!this.storageAdapter) return;
    try {
      const state = this.storageAdapter.load(this.agentId);
      if (!state) return;

      if (state.wallet !== undefined) this._wallet = state.wallet;
      if (state.reputation !== undefined) this._reputation = state.reputation;
      if (state.createdAt) this._createdAt = new Date(state.createdAt);

      for (const m of state.memories) {
        this.memories.set(m.id, {
          ...m,
          createdAt: new Date(m.createdAt),
          lastAccessed: new Date(m.lastAccessed),
          tags: typeof m.tags === "string" ? JSON.parse(m.tags) : m.tags,
        } as any);
      }

      for (const t of state.transactions) {
        this.transactions.set(t.id, {
          ...t,
          createdAt: new Date(t.createdAt),
          completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
        } as any);
      }

      if (state.auditLog) {
        this.auditLog = state.auditLog.map(a => ({
          ...a,
          details: typeof a.details === "string" ? JSON.parse(a.details) : a.details,
          createdAt: new Date(a.createdAt),
        })) as any;
      }

      if (state.fraudGuard) {
        try {
          const restoredGuard = FraudGuard.deserialize(state.fraudGuard, this.fraud.config);
          (this as any).fraud = restoredGuard;
        } catch (e) {
          this.log(`Failed to restore fraud guard: ${e}`);
        }
      }

      this.log(`Loaded ${this.memories.size} memories, ${this.transactions.size} transactions from storage`);
    } catch (e) {
      this.log(`Failed to load from storage: ${e}`);
    }
  }

  private _saveToDisk(): void {
    // Use storage adapter if available
    if (this.storageAdapter) {
      this._saveToStorage();
      return;
    }
    if (!this.persistPath) return;
    try {
      const fs = require("fs");
      const data = JSON.stringify({
        agentId: this.agentId,
        wallet: this._wallet,
        reputation: this._reputation,
        createdAt: this._createdAt.toISOString(),
        memories: Array.from(this.memories.values()),
        transactions: Array.from(this.transactions.values()),
        auditLog: this.auditLog.slice(-500), // Keep last 500 entries
        fraudGuard: this.fraud.serialize(),
        savedAt: new Date().toISOString(),
      });
      // Atomic write
      const tmpPath = this.persistPath + ".tmp";
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (e) {
      this.log(`Failed to persist data: ${e}`);
    }
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
    this._saveToDisk();
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
      this._saveToDisk();
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
    this._saveToDisk();
    this.log(`Reinforced memory ${id} by +${boost} → ${mem.importance.toFixed(2)}`);
  }

  async consolidate(): Promise<number> {
    const threshold = 0.01;
    let pruned = 0;
    const prunedIds: string[] = [];
    for (const [id, mem] of this.memories) {
      const score = computeScore(mem.importance, mem.lastAccessed, mem.accessCount, this.decay);
      if (score < threshold) {
        this.memories.delete(id);
        prunedIds.push(id);
        pruned++;
      }
    }
    // Clean up embedding cache for pruned memories
    this.recallEngine.removeBatch(prunedIds);
    this.audit("memory:consolidated", { pruned });
    this._saveToDisk();
    this.log(`Consolidated: pruned ${pruned} stale memories`);
    return pruned;
  }

  // ── Payment Methods ─────────────────────────────────────────────────────

  async charge(amount: number, reason: string, ctx?: RequestContext): Promise<Transaction> {
    if (amount <= 0) throw new Error("Amount must be positive");
    const maxCharge = 500 * this._reputation;
    if (amount > maxCharge) {
      throw new Error(
        `Amount $${amount.toFixed(2)} exceeds reputation ceiling $${maxCharge.toFixed(2)} ` +
        `(reputation: ${this._reputation.toFixed(2)}, max: $${maxCharge.toFixed(2)})`
      );
    }

    // ── Fraud check ──────────────────────────────────────────────────────
    const pendingCount = Array.from(this.transactions.values()).filter((t) => t.status === "pending").length;
    const risk = this.fraud.assessCharge(
      this.agentId, amount, this._reputation, this._createdAt, pendingCount, ctx,
    );
    if (!risk.allowed) {
      this.audit("fraud:blocked", { amount, reason, riskScore: risk.score, signals: risk.signals.map((s) => s.type) });
      this._saveToDisk();
      this.emit("fraud:blocked", { amount, risk });
      throw new Error(risk.reason || `Charge blocked: risk score ${risk.score}`);
    }
    if (risk.flagged) {
      this.audit("fraud:flagged", { amount, reason, riskScore: risk.score, signals: risk.signals.map((s) => s.type) });
      this.emit("fraud:flagged", { amount, risk });
    }

    // Record charge for velocity tracking
    this.fraud.recordCharge(this.agentId, amount, ctx);

    // Create hold on external payment rail
    const hold = await this.paymentRail.createHold(amount, reason, this.agentId);

    const tx: Transaction = {
      id: randomUUID(),
      agentId: this.agentId,
      amount,
      reason,
      status: "pending",
      createdAt: new Date(),
      riskScore: risk.score,
      externalId: hold.externalId,
      externalStatus: hold.status,
    };
    this.transactions.set(tx.id, tx);
    this.audit("payment:pending", { id: tx.id, amount, reason, riskScore: risk.score, rail: this.paymentRail.name, externalId: hold.externalId });
    this._saveToDisk();
    this.emit("payment:pending", { id: tx.id, amount, reason });
    this.log(`Charge created: $${amount.toFixed(2)} for "${reason}" (pending, risk: ${risk.score}, rail: ${this.paymentRail.name})`);
    return { ...tx };
  }

  async settle(txId: string, counterpartyId?: string): Promise<Transaction> {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status !== "pending") throw new Error(`Transaction ${txId} is ${tx.status}, not pending`);

    // Counter-party validation: prevent self-referential trust building
    if (this.requireCounterparty) {
      if (!counterpartyId) {
        throw new Error("Counter-party ID required for settlement (requireCounterparty is enabled)");
      }
      if (counterpartyId === tx.agentId) {
        throw new Error("Counter-party cannot be the same agent that created the charge");
      }
      tx.counterpartyId = counterpartyId;
    }

    // 1. Capture payment on external rail
    if (tx.externalId) {
      const capture = await this.paymentRail.capturePayment(tx.externalId, tx.amount);
      tx.externalStatus = capture.status;
    }

    // 2. Apply platform fee
    const fee = this.fraud.applyPlatformFee(tx.id, this.agentId, tx.amount);
    tx.platformFee = fee.feeAmount;
    tx.netAmount = fee.netAmount;

    // 2. Move NET funds to wallet (after fee)
    tx.status = "completed";
    tx.completedAt = new Date();
    this._wallet += fee.netAmount;

    // 3. Boost reputation
    this._reputation = Math.min(this._reputation + 0.01, 1.0);

    // 4. Reinforce recently-accessed memories (feedback loop)
    const oneHourAgo = Date.now() - 3_600_000;
    let reinforced = 0;
    for (const mem of this.memories.values()) {
      if (mem.lastAccessed.getTime() > oneHourAgo) {
        mem.importance = Math.min(mem.importance + 0.05, 1.0);
        reinforced++;
      }
    }

    this.audit("payment:completed", {
      id: tx.id, grossAmount: tx.amount, platformFee: fee.feeAmount,
      netAmount: fee.netAmount, feeRate: fee.feeRate, reinforcedMemories: reinforced,
    });
    this._saveToDisk();
    this.emit("payment:completed", { id: tx.id, amount: fee.netAmount, fee: fee.feeAmount });
    this.log(
      `Settled $${tx.amount.toFixed(2)} (fee: $${fee.feeAmount.toFixed(2)}, net: $${fee.netAmount.toFixed(2)}) → ` +
      `wallet: $${this._wallet.toFixed(2)}, reputation: ${this._reputation.toFixed(2)}, reinforced: ${reinforced} memories`
    );
    return { ...tx };
  }

  async refund(txId: string): Promise<Transaction> {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status === "refunded") throw new Error(`Transaction ${txId} already refunded`);

    // Reverse on external rail
    if (tx.externalId) {
      const reversal = await this.paymentRail.reversePayment(tx.externalId, tx.amount);
      tx.externalStatus = reversal.status;
    }

    if (tx.status === "completed") {
      // Refund the net amount (platform fee is NOT refunded)
      const refundAmount = tx.netAmount ?? tx.amount;
      this._wallet = Math.max(this._wallet - refundAmount, 0);
      this._reputation = Math.max(this._reputation - 0.05, 0);
    }
    tx.status = "refunded";

    this.audit("payment:refunded", { id: tx.id, amount: tx.amount, netRefunded: tx.netAmount ?? tx.amount });
    this._saveToDisk();
    this.emit("payment:refunded", { id: tx.id });
    this.log(`Refunded $${tx.amount.toFixed(2)} → reputation: ${this._reputation.toFixed(2)}`);
    return { ...tx };
  }

  // ── Dispute Resolution ─────────────────────────────────────────────────

  async dispute(txId: string, reason: string, evidence?: string[]): Promise<Dispute> {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status !== "completed") throw new Error(`Can only dispute completed transactions (current: ${tx.status})`);
    if (!tx.completedAt) throw new Error(`Transaction ${txId} has no completion date`);

    const d = this.fraud.fileDispute(txId, this.agentId, reason, tx.completedAt, evidence);
    tx.status = "disputed";
    this.audit("payment:disputed", { id: tx.id, disputeId: d.id, reason });
    this._saveToDisk();
    this.emit("payment:disputed", { txId, disputeId: d.id, reason });
    this.log(`Dispute filed for tx ${txId}: ${reason}`);
    return d;
  }

  async resolveDispute(disputeId: string, outcome: "refund" | "uphold"): Promise<Dispute> {
    const d = this.fraud.resolveDispute(disputeId, outcome);
    if (outcome === "refund") {
      const tx = this.transactions.get(d.txId);
      if (tx && tx.status === "disputed") {
        const refundAmount = tx.netAmount ?? tx.amount;
        this._wallet = Math.max(this._wallet - refundAmount, 0);
        this._reputation = Math.max(this._reputation - 0.05, 0);
        tx.status = "refunded";
      }
    } else {
      const tx = this.transactions.get(d.txId);
      if (tx && tx.status === "disputed") {
        tx.status = "completed"; // Restore to completed
      }
    }
    this.audit("dispute:resolved", { disputeId, outcome, txId: d.txId });
    this._saveToDisk();
    this.emit("dispute:resolved", { disputeId, outcome });
    this.log(`Dispute ${disputeId} resolved: ${outcome}`);
    return d;
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

  // ── Reputation ──────────────────────────────────────────────────────────

  async reputation(): Promise<ReputationReport> {
    const txs = Array.from(this.transactions.values());
    const settled = txs.filter((t) => t.status === "completed");
    const refunded = txs.filter((t) => t.status === "refunded");
    const totalCompleted = settled.length + refunded.length;
    const settlementRate = totalCompleted > 0 ? settled.length / totalCompleted : 0;
    const totalValueSettled = settled.reduce((sum, t) => sum + t.amount, 0);

    const mems = Array.from(this.memories.values());
    const avgImportance = mems.length > 0
      ? mems.reduce((sum, m) => sum + m.importance, 0) / mems.length
      : 0;

    const ageHours = (Date.now() - this._createdAt.getTime()) / 3_600_000;

    const report: ReputationReport = {
      agentId: this.agentId,
      score: this._reputation,
      tier: reputationTier(this._reputation),
      settledCount: settled.length,
      refundCount: refunded.length,
      settlementRate,
      totalValueSettled,
      memoriesCount: this.memories.size,
      avgMemoryImportance: Math.round(avgImportance * 100) / 100,
      ageHours: Math.round(ageHours * 10) / 10,
      generatedAt: new Date(),
    };

    this.log(`Reputation: ${report.tier} (${report.score.toFixed(2)}), ${report.settledCount} settled, rate: ${(report.settlementRate * 100).toFixed(0)}%`);
    return report;
  }

  // ── A2A Agent Card ─────────────────────────────────────────────────────

  agentCard(url?: string, contact?: string): AgentCard {
    return {
      name: `MnemoPay Agent (${this.agentId})`,
      description: "AI agent with persistent cognitive memory and micropayment capabilities via MnemoPay protocol.",
      url,
      version: "0.6.0",
      capabilities: {
        memory: true,
        payments: true,
        reputation: true,
      },
      protocols: ["mcp", "a2a"],
      tools: [
        "remember", "recall", "forget", "reinforce", "consolidate",
        "charge", "settle", "refund", "balance", "profile",
        "reputation", "logs", "history",
      ],
      contact,
    };
  }

  // ── x402 Settlement ────────────────────────────────────────────────────

  configureX402(config: X402Config): void {
    this.x402 = config;
    this.log(`x402 configured: ${config.facilitatorUrl} (${config.token || "USDC"} on ${config.chain || "base"})`);
  }

  async settleViaX402(txId: string): Promise<Transaction> {
    if (!this.x402) throw new Error("x402 not configured. Call configureX402() first.");

    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status !== "pending") throw new Error(`Transaction ${txId} is ${tx.status}, not pending`);

    // Submit payment to x402 facilitator
    const res = await fetch(`${this.x402.facilitatorUrl}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: tx.amount,
        token: this.x402.token || "USDC",
        chain: this.x402.chain || "base",
        from: this.x402.walletAddress,
        memo: `mnemopay:${tx.id}:${tx.reason}`,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`x402 settlement failed (${res.status}): ${body}`);
    }

    // On success, settle locally
    return this.settle(txId);
  }

  async disconnect(): Promise<void> {
    this._saveToDisk();
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.storageAdapter) this.storageAdapter.close();
    this.log("Disconnected" + (this.storageAdapter || this.persistPath ? " (data saved)" : " (in-memory, data discarded)"));
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
    const result = await this.mnemoFetch("/v1/memories", {
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

  async recall(limit?: number): Promise<Memory[]>;
  async recall(query: string, limit?: number): Promise<Memory[]>;
  async recall(queryOrLimit?: string | number, maybeLimit?: number): Promise<Memory[]> {
    const query = typeof queryOrLimit === "string" ? queryOrLimit : "*";
    const limit = typeof queryOrLimit === "number" ? queryOrLimit : (maybeLimit ?? 5);

    const result = await this.mnemoFetch("/v1/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        top_k: limit,
        min_retrievability: 0.01,
      }),
    });
    const memories: Memory[] = (result.results || []).map((r: any) => {
      // API returns { memory: {...}, score: ... } per result
      const m = r.memory || r;
      return {
        id: m.id,
        agentId: this.agentId,
        content: m.content,
        importance: m.retrievability ?? 0.5,
        score: r.score ?? m.score ?? 0,
        createdAt: new Date((m.created_at || Date.now()) * 1000),
        lastAccessed: new Date(),
        accessCount: m.access_count ?? 0,
        tags: m.tags ?? [],
      };
    });
    this.emit("memory:recalled", { count: memories.length });
    this.log(`Recalled ${memories.length} memories`);
    return memories;
  }

  async forget(id: string): Promise<boolean> {
    try {
      await this.mnemoFetch(`/v1/memories/${id}`, { method: "DELETE" });
      this.log(`Forgot memory: ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async reinforce(id: string, boost = 0.1): Promise<void> {
    await this.mnemoFetch(`/v1/memories/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ grade: boost >= 0.15 ? 4 : 3 }),
    });
    this.log(`Reinforced memory ${id}`);
  }

  async consolidate(): Promise<number> {
    const result = await this.mnemoFetch("/v1/memories/consolidate", {
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
      body: JSON.stringify({}),
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
      body: JSON.stringify({}),
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

  // ── Reputation ──────────────────────────────────────────────────────────

  async reputation(): Promise<ReputationReport> {
    const [prof, txs] = await Promise.all([
      this.profile(),
      this.history(1000),
    ]);
    const settled = txs.filter((t) => t.status === "completed");
    const refunded = txs.filter((t) => t.status === "refunded");
    const totalCompleted = settled.length + refunded.length;
    const settlementRate = totalCompleted > 0 ? settled.length / totalCompleted : 0;
    const totalValueSettled = settled.reduce((sum, t) => sum + t.amount, 0);

    return {
      agentId: this.agentId,
      score: prof.reputation,
      tier: reputationTier(prof.reputation),
      settledCount: settled.length,
      refundCount: refunded.length,
      settlementRate,
      totalValueSettled,
      memoriesCount: prof.memoriesCount,
      avgMemoryImportance: 0, // not available via API
      ageHours: 0, // not tracked server-side yet
      generatedAt: new Date(),
    };
  }

  // ── A2A Agent Card ─────────────────────────────────────────────────────

  agentCard(url?: string, contact?: string): AgentCard {
    return {
      name: `MnemoPay Agent (${this.agentId})`,
      description: "AI agent with persistent cognitive memory and micropayment capabilities via MnemoPay protocol.",
      url,
      version: "0.6.0",
      capabilities: {
        memory: true,
        payments: true,
        reputation: true,
      },
      protocols: ["mcp", "a2a"],
      tools: [
        "remember", "recall", "forget", "reinforce", "consolidate",
        "charge", "settle", "refund", "balance", "profile",
        "reputation", "logs", "history",
      ],
      contact,
    };
  }

  // ── x402 Settlement ────────────────────────────────────────────────────

  private x402?: X402Config;

  configureX402(config: X402Config): void {
    this.x402 = config;
    this.log(`x402 configured: ${config.facilitatorUrl} (${config.token || "USDC"} on ${config.chain || "base"})`);
  }

  async settleViaX402(txId: string): Promise<Transaction> {
    if (!this.x402) throw new Error("x402 not configured. Call configureX402() first.");

    // Get transaction details from AgentPay
    const txData = await this.agentpayFetch(`/api/escrow/${txId}`);

    // Submit to x402 facilitator
    const res = await fetch(`${this.x402.facilitatorUrl}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: txData.amount,
        token: this.x402.token || "USDC",
        chain: this.x402.chain || "base",
        from: this.x402.walletAddress,
        memo: `mnemopay:${txId}:${txData.reason || ""}`,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`x402 settlement failed (${res.status}): ${body}`);
    }

    // On success, settle in AgentPay
    return this.settle(txId);
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
    fraud?: Partial<FraudConfig>;
    /** Pluggable payment rail (Stripe, Lightning). Default: in-memory mock. */
    paymentRail?: PaymentRail;
    /** Require different agentId for settlement (prevents self-referential trust) */
    requireCounterparty?: boolean;
    /** Storage adapter: SQLiteStorage, JSONFileStorage, or custom. Default: auto-detect JSON file. */
    storage?: StorageAdapter;
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
    return new MnemoPayLite(agentId, opts?.decay ?? 0.05, opts?.debug ?? false, recallConfig, opts?.fraud, opts?.paymentRail, opts?.requireCounterparty ?? false, opts?.storage);
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
export { autoScore, computeScore, reputationTier };
export { RecallEngine, cosineSimilarity, localEmbed, l2Normalize } from "./recall/engine.js";
export type { RecallStrategy, EmbeddingProvider, RecallEngineConfig, RecallResult } from "./recall/engine.js";
export { FraudGuard, RateLimiter, DEFAULT_FRAUD_CONFIG, DEFAULT_RATE_LIMIT } from "./fraud.js";
export type { FraudConfig, FraudSignal, RiskAssessment, Dispute, PlatformFeeRecord, RequestContext, RateLimitConfig } from "./fraud.js";
export { IsolationForest, TransactionGraph, BehaviorProfile } from "./fraud-ml.js";
export type { CollusionSignal, DriftSignal, BehaviorSnapshot } from "./fraud-ml.js";
export { MockRail, StripeRail, LightningRail } from "./rails/index.js";
export type { PaymentRail, PaymentRailResult } from "./rails/index.js";
export { SQLiteStorage, JSONFileStorage } from "./storage/sqlite.js";
export type { StorageAdapter, PersistedState } from "./storage/sqlite.js";
export { default as createSandboxServer } from "./mcp/server.js";
