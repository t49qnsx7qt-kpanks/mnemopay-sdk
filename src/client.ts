/**
 * MnemoPay Universal Client
 *
 * Thin client that works everywhere: browser, React Native, Node.js, Deno.
 * Zero dependencies. Talks to a MnemoPay server via REST API.
 *
 * Usage:
 *   import { MnemoPayClient } from "@mnemopay/sdk/client";
 *
 *   const client = new MnemoPayClient("http://localhost:3200", "your-token");
 *   await client.remember("User prefers monthly billing");
 *   const memories = await client.recall("billing preferences");
 *   const tx = await client.charge(25, "Monthly access");
 *   await client.settle(tx.txId);
 *
 * Works from:
 *   - Browser (any modern browser with fetch)
 *   - React Native
 *   - Node.js 18+
 *   - Deno
 *   - Any HTTP client
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClientConfig {
  /** MnemoPay server URL (e.g. "http://localhost:3200") */
  baseUrl: string;
  /** Bearer token for authentication (MNEMOPAY_MCP_TOKEN) */
  token?: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Custom fetch implementation (for React Native polyfills, etc.) */
  fetch?: typeof globalThis.fetch;
}

export interface ApiResponse<T = any> {
  ok: boolean;
  tool?: string;
  result?: T;
  error?: string;
}

export interface MemoryResult {
  id: string;
  status: string;
}

export interface TransactionResult {
  txId: string;
  amount: number;
  status: string;
  reason?: string;
  rail?: string;
}

export interface BalanceResult {
  wallet: number;
  reputation: number;
}

export interface ProductResult {
  productId: string;
  title: string;
  price: number;
  url: string;
  merchant: string;
  category?: string;
  rating?: number;
  freeShipping?: boolean;
}

export interface PurchaseOrder {
  id: string;
  agentId: string;
  product: ProductResult;
  txId: string;
  status: string;
  trackingUrl?: string;
  approved: boolean;
}

export interface ShoppingMandate {
  budget: number;
  maxPerItem?: number;
  categories?: string[];
  blockedCategories?: string[];
  allowedMerchants?: string[];
  blockedMerchants?: string[];
  approvalThreshold?: number;
  expiresAt?: string;
  issuedBy: string;
}

export interface SpendingSummary {
  totalSpent: number;
  remainingBudget: number;
  orderCount: number;
  deliveredCount: number;
  pendingCount: number;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class MnemoPayClient {
  private baseUrl: string;
  private token?: string;
  private timeoutMs: number;
  private _fetch: typeof globalThis.fetch;

  constructor(baseUrl: string, token?: string, config?: Partial<ClientConfig>) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = config?.timeoutMs ?? 30_000;
    this._fetch = config?.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── Core HTTP ───────────────────────────────────────────────────────────

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    try {
      const res = await this._fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const json = await res.json() as ApiResponse<T>;

      if (!res.ok || json.ok === false) {
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }

      return json.result !== undefined ? json.result : json as any;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private get<T = any>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  // ── Memory ──────────────────────────────────────────────────────────────

  /** Store a memory */
  async remember(content: string, options?: { importance?: number; tags?: string[] }): Promise<MemoryResult> {
    return this.post("/api/remember", { content, ...options });
  }

  /** Recall memories, optionally filtered by semantic query */
  async recall(queryOrLimit?: string | number, limit?: number): Promise<string> {
    if (typeof queryOrLimit === "number") {
      return this.post("/api/recall", { limit: queryOrLimit });
    }
    return this.post("/api/recall", { query: queryOrLimit, limit });
  }

  /** Delete a memory by ID */
  async forget(id: string): Promise<string> {
    return this.post("/api/forget", { id });
  }

  /** Boost a memory's importance */
  async reinforce(id: string, boost?: number): Promise<string> {
    return this.post("/api/reinforce", { id, boost });
  }

  /** Prune stale memories */
  async consolidate(): Promise<string> {
    return this.post("/api/consolidate", {});
  }

  // ── Payments ────────────────────────────────────────────────────────────

  /** Create an escrow charge */
  async charge(amount: number, reason: string): Promise<TransactionResult> {
    return this.post("/api/charge", { amount, reason });
  }

  /** Settle a pending escrow */
  async settle(txId: string, counterpartyId?: string): Promise<TransactionResult> {
    return this.post("/api/settle", { txId, counterpartyId });
  }

  /** Refund a transaction */
  async refund(txId: string): Promise<TransactionResult> {
    return this.post("/api/refund", { txId });
  }

  /** Check wallet balance and reputation */
  async balance(): Promise<string> {
    return this.post("/api/balance", {});
  }

  /** Full agent profile */
  async profile(): Promise<any> {
    return this.post("/api/profile", {});
  }

  /** Transaction history */
  async history(limit?: number): Promise<string> {
    return this.post("/api/history", { limit });
  }

  /** Audit logs */
  async logs(limit?: number): Promise<string> {
    return this.post("/api/logs", { limit });
  }

  /** Reputation report */
  async reputation(): Promise<any> {
    return this.post("/api/reputation", {});
  }

  /** File a dispute */
  async dispute(txId: string, reason: string): Promise<any> {
    return this.post("/api/dispute", { txId, reason });
  }

  /** Fraud detection stats */
  async fraudStats(): Promise<any> {
    return this.post("/api/fraud_stats", {});
  }

  // ── Commerce ────────────────────────────────────────────────────────────

  /** Set a shopping mandate (budget, categories, merchant restrictions) */
  async setMandate(mandate: ShoppingMandate): Promise<{ mandate: ShoppingMandate; remainingBudget: number }> {
    return this.request("POST", "/api/commerce/mandate", mandate);
  }

  /** Search for products within mandate constraints */
  async search(query: string, options?: {
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    category?: string;
    sortBy?: "price_asc" | "price_desc" | "rating" | "relevance";
    freeShippingOnly?: boolean;
  }): Promise<{ results: ProductResult[]; remainingBudget: number }> {
    return this.request("POST", "/api/commerce/search", { query, options });
  }

  /** Purchase a product (creates escrow, executes purchase) */
  async purchase(product: ProductResult, deliveryInstructions?: string): Promise<{ order: PurchaseOrder }> {
    return this.request("POST", "/api/commerce/purchase", { product, deliveryInstructions });
  }

  /** Confirm delivery (settles escrow) */
  async confirmDelivery(orderId: string): Promise<{ order: PurchaseOrder }> {
    return this.request("POST", "/api/commerce/confirm", { orderId });
  }

  /** Cancel an order (refunds escrow) */
  async cancelOrder(orderId: string, reason?: string): Promise<{ order: PurchaseOrder }> {
    return this.request("POST", "/api/commerce/cancel", { orderId, reason });
  }

  /** List orders, optionally filtered by status */
  async orders(status?: string): Promise<{ orders: PurchaseOrder[]; summary: SpendingSummary }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request("GET", `/api/commerce/orders${qs}`);
  }

  // ── Utility ─────────────────────────────────────────────────────────────

  /** Check server health */
  async health(): Promise<{ status: string; mode: string }> {
    return this.get("/health");
  }

  /** List available tools */
  async tools(): Promise<{ tools: Array<{ name: string; description: string }>; version: string }> {
    return this.get("/api/tools");
  }
}

export default MnemoPayClient;
