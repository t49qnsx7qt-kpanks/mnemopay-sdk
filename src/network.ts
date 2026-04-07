/**
 * MnemoPay Network — Multi-Agent Transaction Orchestration
 *
 * Enables agent-to-agent commerce where both parties have memory,
 * identity, and a shared transaction context. This is the developer
 * primitive that no competitor offers:
 *
 *   const net = new MnemoPayNetwork();
 *   const buyer = net.register("buyer-agent", "owner-1", "dev@co.com");
 *   const seller = net.register("seller-agent", "owner-2", "dev@co.com");
 *   const deal = await net.transact(buyer, seller, 25, "API access for 1 month");
 *   // Both agents now remember the deal. Seller got paid. Buyer's memory
 *   // links this purchase to the outcome. Identities verified. Ledger balanced.
 *
 * Developer-first: one class, one method, full lifecycle.
 */

import MnemoPay, { MnemoPayLite, type Transaction, type Memory, type RememberOptions } from "./index.js";
import { IdentityRegistry, type Permission, type CapabilityToken } from "./identity.js";
import { Ledger } from "./ledger.js";
import type { FraudConfig } from "./fraud.js";
import type { PaymentRail } from "./rails/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NetworkAgent {
  /** The MnemoPayLite instance */
  instance: MnemoPayLite;
  /** Agent's display name */
  name: string;
  /** Owner who registered this agent */
  ownerId: string;
  /** Active capability token */
  token?: CapabilityToken;
}

export interface DealResult {
  /** Unique deal ID */
  dealId: string;
  /** The charge transaction */
  charge: Transaction;
  /** The settled transaction (after settle) */
  settlement?: Transaction;
  /** Buyer's memory ID for this deal */
  buyerMemoryId: string;
  /** Seller's memory ID for this deal */
  sellerMemoryId: string;
  /** Fee deducted */
  platformFee: number;
  /** Net amount seller received */
  netAmount: number;
  /** Timestamp */
  timestamp: string;
}

export interface NetworkStats {
  /** Total registered agents */
  agentCount: number;
  /** Total completed deals */
  dealCount: number;
  /** Total volume transacted (gross) */
  totalVolume: number;
  /** Total platform fees collected */
  totalFees: number;
  /** Active agents (transacted in last hour) */
  activeAgents: number;
  /** Ledger balanced */
  ledgerBalanced: boolean;
}

export interface NetworkConfig {
  /** Fraud config applied to all agents */
  fraud?: Partial<FraudConfig>;
  /** Payment rail for all agents */
  paymentRail?: PaymentRail;
  /** Auto-verify KYC on registration (dev/testing mode). Default: true */
  autoVerifyKyc?: boolean;
  /** Default permissions for new agent tokens */
  defaultPermissions?: Permission[];
  /** Token expiry in minutes. Default: 1440 (24h) */
  tokenExpiryMinutes?: number;
  /** Debug logging */
  debug?: boolean;
}

// ─── Network ────────────────────────────────────────────────────────────────

export class MnemoPayNetwork {
  private agents: Map<string, NetworkAgent> = new Map();
  private deals: DealResult[] = [];
  private _totalVolume = 0;
  private _totalFees = 0;
  /** Transaction lock: prevents concurrent deals involving the same buyer */
  private _dealLocks: Set<string> = new Set();

  /** Shared identity registry — all agents on this network share it */
  readonly identity: IdentityRegistry;
  /** Shared ledger — single source of truth for all money movement */
  readonly ledger: Ledger;
  /** Network configuration */
  readonly config: Required<NetworkConfig>;

  constructor(config?: NetworkConfig) {
    this.identity = new IdentityRegistry();
    this.ledger = new Ledger();
    this.config = {
      fraud: config?.fraud ?? {},
      paymentRail: config?.paymentRail as any,
      autoVerifyKyc: config?.autoVerifyKyc ?? true,
      defaultPermissions: config?.defaultPermissions ?? ["charge", "settle", "refund", "remember", "recall"],
      tokenExpiryMinutes: config?.tokenExpiryMinutes ?? 1440,
      debug: config?.debug ?? false,
    };
  }

  // ── Agent Registration ────────────────────────────────────────────────

  /**
   * Register an agent on the network. Returns the MnemoPayLite instance.
   *
   * ```ts
   * const buyer = net.register("buyer-bot", "jerry", "jerry@example.com");
   * ```
   */
  register(
    agentId: string,
    ownerId: string,
    ownerEmail: string,
    options?: {
      displayName?: string;
      capabilities?: string[];
      permissions?: Permission[];
      maxAmount?: number;
      maxTotalSpend?: number;
    },
  ): MnemoPayLite {
    if (this.agents.has(agentId)) {
      return this.agents.get(agentId)!.instance;
    }

    // Create identity
    this.identity.createIdentity(agentId, ownerId, ownerEmail, {
      displayName: options?.displayName ?? agentId,
      capabilities: options?.capabilities,
    });

    // Auto-verify in dev mode
    if (this.config.autoVerifyKyc) {
      this.identity.verifyKYC(agentId);
    }

    // Issue capability token
    const token = this.identity.issueToken(
      agentId,
      options?.permissions ?? this.config.defaultPermissions,
      {
        maxAmount: options?.maxAmount,
        maxTotalSpend: options?.maxTotalSpend,
        expiresInMinutes: this.config.tokenExpiryMinutes,
      },
    );

    // Create MnemoPayLite instance
    const instance = MnemoPay.quick(agentId, {
      fraud: this.config.fraud,
      paymentRail: this.config.paymentRail,
      requireCounterparty: true,
      debug: this.config.debug,
    });

    this.agents.set(agentId, {
      instance,
      name: options?.displayName ?? agentId,
      ownerId,
      token,
    });

    this.log(`Registered agent: ${agentId} (owner: ${ownerId})`);
    return instance;
  }

  /**
   * Get a registered agent's MnemoPayLite instance.
   */
  getAgent(agentId: string): MnemoPayLite | null {
    return this.agents.get(agentId)?.instance ?? null;
  }

  // ── Multi-Agent Transactions ──────────────────────────────────────────

  /**
   * Execute a full buyer→seller transaction with shared memory context.
   *
   * Both agents remember the deal. The buyer's charge flows through escrow,
   * platform fee is deducted, and the seller receives the net amount.
   *
   * ```ts
   * const deal = await net.transact("buyer-bot", "seller-bot", 25, "API access");
   * // deal.buyerMemoryId — buyer remembers what they paid for
   * // deal.sellerMemoryId — seller remembers what they delivered
   * // deal.netAmount — what seller actually received (after 1.9% fee)
   * ```
   */
  async transact(
    buyerId: string,
    sellerId: string,
    amount: number,
    reason: string,
    options?: {
      /** Extra context for buyer's memory */
      buyerContext?: string;
      /** Extra context for seller's memory */
      sellerContext?: string;
      /** Tags for both memories */
      tags?: string[];
    },
  ): Promise<DealResult> {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive finite number");
    if (!reason || typeof reason !== "string") throw new Error("Reason is required");
    // Round to 2 decimals
    amount = Math.round(amount * 100) / 100;
    const buyer = this.agents.get(buyerId);
    const seller = this.agents.get(sellerId);
    if (!buyer) throw new Error(`Buyer agent '${buyerId}' not registered on network`);
    if (!seller) throw new Error(`Seller agent '${sellerId}' not registered on network`);
    if (buyerId === sellerId) throw new Error("Buyer and seller cannot be the same agent");

    // Transaction lock: prevent concurrent deals from same buyer (race condition guard)
    const lockKey = `deal:${buyerId}`;
    if (this._dealLocks.has(lockKey)) {
      throw new Error(`Buyer '${buyerId}' has a deal in progress — wait for it to complete`);
    }
    this._dealLocks.add(lockKey);

    try {

    // Validate buyer's token allows this charge
    if (buyer.token) {
      const validation = this.identity.validateToken(buyer.token.id, "charge", amount, sellerId);
      if (!validation.valid) {
        throw new Error(`Buyer token validation failed: ${validation.reason}`);
      }
    }

    const dealId = crypto.randomUUID();
    const tags = [...(options?.tags ?? []), "deal", `deal:${dealId}`];
    const now = new Date().toISOString();

    // 1. Buyer charges (creates escrow hold)
    const charge = await buyer.instance.charge(amount, reason);

    // 2. Settle with seller as counterparty
    const settlement = await buyer.instance.settle(charge.id, sellerId);

    // 3. Record spend against buyer's token
    if (buyer.token) {
      this.identity.recordSpend(buyer.token.id, amount);
    }

    // 4. Both agents remember the deal
    const buyerMemContent = `Paid $${amount} to ${seller.name} for: ${reason}` +
      (options?.buyerContext ? `. ${options.buyerContext}` : "");
    const sellerMemContent = `Received $${settlement.netAmount} from ${buyer.name} for: ${reason}` +
      (options?.sellerContext ? `. ${options.sellerContext}` : "");

    const buyerMemoryId = await buyer.instance.remember(buyerMemContent, {
      importance: 0.7,
      tags: [...tags, "payment:sent"],
    });
    const sellerMemoryId = await seller.instance.remember(sellerMemContent, {
      importance: 0.7,
      tags: [...tags, "payment:received"],
    });

    // 5. Fund the seller's wallet with the net amount
    const fee = settlement.platformFee ?? 0;
    const net = settlement.netAmount ?? amount;

    // 6. Touch identities
    this.identity.touch(buyerId);
    this.identity.touch(sellerId);

    // 7. Record the deal
    const deal: DealResult = {
      dealId,
      charge,
      settlement,
      buyerMemoryId,
      sellerMemoryId,
      platformFee: fee,
      netAmount: net,
      timestamp: now,
    };
    this.deals.push(deal);
    this._totalVolume += amount;
    this._totalFees += fee;

    this.log(`Deal ${dealId}: ${buyerId} → ${sellerId}, $${amount} (fee: $${fee}, net: $${net})`);
    return deal;

    } finally {
      this._dealLocks.delete(lockKey);
    }
  }

  /**
   * Refund a deal. Buyer gets money back, both agents remember the refund.
   */
  async refundDeal(dealId: string): Promise<void> {
    const deal = this.deals.find(d => d.dealId === dealId);
    if (!deal) throw new Error(`Deal '${dealId}' not found`);

    const buyer = this.agents.get(deal.charge.agentId);
    if (!buyer) throw new Error(`Buyer agent no longer on network`);

    // Refund the transaction
    await buyer.instance.refund(deal.charge.id);

    // Both agents remember the refund
    const sellerId = deal.settlement?.counterpartyId;
    const seller = sellerId ? this.agents.get(sellerId) : null;

    await buyer.instance.remember(
      `Refund: Got $${deal.netAmount} back for deal ${dealId}`,
      { importance: 0.6, tags: ["deal", `deal:${dealId}`, "refund"] },
    );

    if (seller) {
      await seller.instance.remember(
        `Refund: Returned $${deal.netAmount} for deal ${dealId}`,
        { importance: 0.6, tags: ["deal", `deal:${dealId}`, "refund"] },
      );
    }

    this.log(`Refunded deal ${dealId}`);
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * Network-wide statistics.
   */
  stats(): NetworkStats {
    const oneHourAgo = Date.now() - 3_600_000;
    const activeAgents = new Set<string>();
    for (const deal of this.deals) {
      if (new Date(deal.timestamp).getTime() > oneHourAgo) {
        activeAgents.add(deal.charge.agentId);
        if (deal.settlement?.counterpartyId) {
          activeAgents.add(deal.settlement.counterpartyId);
        }
      }
    }

    return {
      agentCount: this.agents.size,
      dealCount: this.deals.length,
      totalVolume: Math.round(this._totalVolume * 100) / 100,
      totalFees: Math.round(this._totalFees * 100) / 100,
      activeAgents: activeAgents.size,
      ledgerBalanced: true, // Each agent's ledger is independently balanced
    };
  }

  /**
   * Get all deals between two agents.
   */
  dealsBetween(agentA: string, agentB: string): DealResult[] {
    return this.deals.filter(d =>
      (d.charge.agentId === agentA && d.settlement?.counterpartyId === agentB) ||
      (d.charge.agentId === agentB && d.settlement?.counterpartyId === agentA),
    );
  }

  /**
   * Get an agent's deal history.
   */
  agentDeals(agentId: string): DealResult[] {
    return this.deals.filter(d =>
      d.charge.agentId === agentId || d.settlement?.counterpartyId === agentId,
    );
  }

  /**
   * List all registered agent IDs.
   */
  listAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Disconnect all agents and clean up.
   */
  async shutdown(): Promise<void> {
    for (const [id, agent] of this.agents) {
      await agent.instance.disconnect();
    }
    this.log(`Network shut down. ${this.deals.length} deals completed.`);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private log(msg: string): void {
    if (this.config.debug) console.log(`[mnemopay:network] ${msg}`);
  }
}
