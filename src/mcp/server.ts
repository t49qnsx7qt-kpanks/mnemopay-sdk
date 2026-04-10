#!/usr/bin/env node
/**
 * MnemoPay Unified MCP Server
 *
 * Exposes all MnemoPay SDK methods as MCP tools. Any MCP-compatible
 * client (Claude Desktop, Cursor, Windsurf, OpenClaw, Hermes) gets
 * agent memory + wallet capabilities instantly.
 *
 * Usage:
 *   npx @mnemopay/mcp-server                    # stdio mode (default)
 *   npx @mnemopay/mcp-server --http --port 3200 # HTTP/SSE mode
 *
 * Environment:
 *   MNEMOPAY_AGENT_ID   — Agent identifier (default: "mcp-agent")
 *   MNEMOPAY_MODE       — "quick" or "production" (default: "quick")
 *   MNEMO_URL           — Mnemosyne API URL (production mode)
 *   AGENTPAY_URL        — AgentPay API URL (production mode)
 *   MNEMO_API_KEY       — Mnemosyne API key (production mode)
 *   AGENTPAY_API_KEY    — AgentPay API key (production mode)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MnemoPay, MnemoPayLite, RateLimiter, constantTimeEqual, AgentFICO, MerkleTree, BehavioralEngine, EWMADetector } from "../index.js";
import { StripeRail, LightningRail, MockRail } from "../rails/index.js";
import { PaystackRail } from "../rails/paystack.js";
import type { PaymentRail } from "../rails/index.js";
import type { RequestContext } from "../fraud.js";

// ─── Security: MCP-level rate limiter ────────────────────────────────────────
// Separate from per-agent fraud rate limits — this guards the MCP server itself.

const MCP_RATE_LIMIT = {
  maxCallsPerMinute: 60,
  maxCallsPerHour: 500,
};

class McpRateLimiter {
  private timestamps: number[] = [];
  check(): void {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 3_600_000);
    const lastMinute = this.timestamps.filter(t => now - t < 60_000).length;
    if (lastMinute >= MCP_RATE_LIMIT.maxCallsPerMinute) {
      throw new Error("MCP rate limit exceeded: too many calls per minute");
    }
    if (this.timestamps.length >= MCP_RATE_LIMIT.maxCallsPerHour) {
      throw new Error("MCP rate limit exceeded: too many calls per hour");
    }
    this.timestamps.push(now);
  }
}

const mcpLimiter = new McpRateLimiter();

type Agent = MnemoPayLite | MnemoPay;

// ─── Agent initialization ───────────────────────────────────────────────────

function createAgent(): Agent {
  const agentId = process.env.MNEMOPAY_AGENT_ID || "mcp-agent";
  const mode = process.env.MNEMOPAY_MODE || "quick";

  if (mode === "production") {
    return MnemoPay.create({
      agentId,
      mnemoUrl: process.env.MNEMO_URL || "http://localhost:8100",
      agentpayUrl: process.env.AGENTPAY_URL || "http://localhost:3100",
      mnemoApiKey: process.env.MNEMO_API_KEY,
      agentpayApiKey: process.env.AGENTPAY_API_KEY,
      debug: process.env.DEBUG === "true",
    });
  }

  // ── Payment rail selection ────────────────────────────────────────────────
  // Set MNEMOPAY_PAYMENT_RAIL to "stripe", "paystack", or "lightning".
  // Defaults to MockRail when no rail/keys are configured (backwards compatible).
  const railName = (process.env.MNEMOPAY_PAYMENT_RAIL || "mock").toLowerCase();
  let paymentRail: PaymentRail;

  switch (railName) {
    case "stripe": {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) throw new Error("STRIPE_SECRET_KEY required when MNEMOPAY_PAYMENT_RAIL=stripe");
      const currency = process.env.STRIPE_CURRENCY || "usd";
      paymentRail = new StripeRail(key, currency);
      break;
    }
    case "paystack": {
      const key = process.env.PAYSTACK_SECRET_KEY;
      if (!key) throw new Error("PAYSTACK_SECRET_KEY required when MNEMOPAY_PAYMENT_RAIL=paystack");
      const currency = (process.env.PAYSTACK_CURRENCY || "NGN") as any;
      paymentRail = new PaystackRail(key, { currency });
      break;
    }
    case "lightning": {
      const url = process.env.LIGHTNING_LND_URL;
      const macaroon = process.env.LIGHTNING_MACAROON;
      if (!url || !macaroon) throw new Error("LIGHTNING_LND_URL and LIGHTNING_MACAROON required when MNEMOPAY_PAYMENT_RAIL=lightning");
      const btcPrice = Number(process.env.LIGHTNING_BTC_PRICE) || 60000;
      paymentRail = new LightningRail(url, macaroon, btcPrice);
      break;
    }
    default:
      paymentRail = new MockRail();
  }

  const recall = (process.env.MNEMOPAY_RECALL as "score" | "vector" | "hybrid") || undefined;
  const agent = MnemoPay.quick(agentId, {
    debug: process.env.DEBUG === "true",
    recall,
    openaiApiKey: process.env.OPENAI_API_KEY,
    paymentRail,
  });

  // Enable file persistence — always on by default.
  // Priority: MNEMOPAY_PERSIST_DIR env > Fly.io /data > ~/.mnemopay/data
  const persistDir =
    process.env.MNEMOPAY_PERSIST_DIR ||
    (process.env.FLY_APP_NAME ? "/data" : undefined) ||
    require("path").join(require("os").homedir(), ".mnemopay", "data");
  if (!process.env.MNEMOPAY_PERSIST_DIR) {
    agent.enablePersistence(persistDir);
  }

  return agent;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory. The agent will remember this across sessions. " +
      "Importance is auto-scored from content if not provided. " +
      "Use for facts, preferences, decisions, and observations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "What to remember", maxLength: 100000 },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Importance score (0-1). Auto-scored if omitted.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "Recall the most relevant memories. Supports semantic search when a query is provided. " +
      "Call this before making decisions or answering questions about past interactions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Semantic search query (optional). When provided, returns memories most similar to this query.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          default: 5,
          description: "Number of memories to recall (default: 5)",
        },
      },
    },
  },
  {
    name: "forget",
    description: "Permanently delete a memory by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Memory ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "reinforce",
    description:
      "Boost a memory's importance when external signals confirm it was valuable. " +
      "Use after a memory leads to a successful outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Memory ID to reinforce" },
        boost: {
          type: "number",
          minimum: 0.01,
          maximum: 0.5,
          default: 0.1,
          description: "Importance boost (default: 0.1)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "consolidate",
    description:
      "Prune stale memories whose composite score has decayed below threshold. " +
      "Run periodically to keep memory store clean.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "charge",
    description:
      "Create an escrow charge for work delivered. Held pending until settled. " +
      "Maximum charge = $500 x agent reputation. Only charge AFTER delivering value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: {
          type: "number",
          minimum: 0.01,
          maximum: 500,
          description: "Amount in USD",
        },
        reason: {
          type: "string",
          minLength: 5,
          description: "Clear description of value delivered",
        },
      },
      required: ["amount", "reason"],
    },
  },
  {
    name: "settle",
    description:
      "Finalize a pending escrow. Moves funds to wallet, boosts reputation +0.01, " +
      "and reinforces recently-accessed memories by +0.05 (the feedback loop). " +
      "If requireCounterparty is enabled, a different agent ID must confirm.",
    inputSchema: {
      type: "object" as const,
      properties: {
        txId: { type: "string", description: "Transaction ID from charge" },
        counterpartyId: { type: "string", description: "Counter-party agent ID (required when requireCounterparty is enabled)" },
      },
      required: ["txId"],
    },
  },
  {
    name: "refund",
    description:
      "Refund a transaction. If already settled, withdraws funds and docks " +
      "reputation by -0.05. Takes 5 successful settlements to recover.",
    inputSchema: {
      type: "object" as const,
      properties: {
        txId: { type: "string", description: "Transaction ID to refund" },
      },
      required: ["txId"],
    },
  },
  {
    name: "balance",
    description: "Check wallet balance and reputation score.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "profile",
    description: "Full agent stats: reputation, wallet, memory count, transaction count.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "logs",
    description: "Immutable audit trail of all memory and payment actions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", default: 20, description: "Number of entries" },
      },
    },
  },
  {
    name: "history",
    description: "Transaction history, most recent first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", default: 10, description: "Number of transactions" },
      },
    },
  },
  {
    name: "reputation",
    description:
      "Full reputation report: score, tier, settlement rate, total value settled, " +
      "memory stats. Use to prove agent trustworthiness to other agents or users.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "dispute",
    description:
      "File a dispute against a settled transaction within the dispute window (24h). " +
      "Freezes the transaction pending resolution.",
    inputSchema: {
      type: "object" as const,
      properties: {
        txId: { type: "string", description: "Transaction ID to dispute" },
        reason: { type: "string", minLength: 10, description: "Detailed reason for the dispute" },
      },
      required: ["txId", "reason"],
    },
  },
  {
    name: "fraud_stats",
    description:
      "View fraud detection stats: charges tracked, flagged agents, blocked agents, " +
      "open disputes, and total platform fees collected.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ── Commerce tools ───────────────────────────────────────────────────
  {
    name: "shop_set_mandate",
    description:
      "Set a shopping mandate — defines what the agent can buy. " +
      "Specify budget, allowed categories, merchant restrictions, and per-item limits. " +
      "MUST be called before any shopping. The mandate protects the user's money.",
    inputSchema: {
      type: "object" as const,
      properties: {
        budget: { type: "number", minimum: 0.01, description: "Total budget in USD" },
        maxPerItem: { type: "number", description: "Max spend per item (defaults to budget)" },
        categories: { type: "array", items: { type: "string" }, description: "Allowed categories (empty = any)" },
        blockedCategories: { type: "array", items: { type: "string" }, description: "Blocked categories" },
        allowedMerchants: { type: "array", items: { type: "string" }, description: "Allowed merchant domains" },
        approvalThreshold: { type: "number", description: "Purchases above this amount require user confirmation" },
        issuedBy: { type: "string", description: "Who authorized this mandate (user name or ID)" },
      },
      required: ["budget", "issuedBy"],
    },
  },
  {
    name: "shop_search",
    description:
      "Search for products within the current shopping mandate. " +
      "Returns products filtered by budget, category, and merchant restrictions. " +
      "Uses agent memory to consider past preferences.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "What to search for (e.g. 'USB-C cable under $15')" },
        maxPrice: { type: "number", description: "Maximum price filter" },
        category: { type: "string", description: "Category filter" },
        sortBy: { type: "string", enum: ["price_asc", "price_desc", "rating", "relevance"], description: "Sort order" },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "shop_buy",
    description:
      "Purchase a product. Holds funds in escrow — money is NOT released " +
      "until delivery is confirmed. If the purchase fails, escrow is automatically refunded. " +
      "Call shop_search first to find products.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "string", description: "Product ID from search results" },
        deliveryInstructions: { type: "string", description: "Shipping address or delivery notes" },
      },
      required: ["productId"],
    },
  },
  {
    name: "shop_confirm_delivery",
    description:
      "Confirm that a purchased item was delivered. This releases the escrow " +
      "and pays the merchant. Only call when the user confirms they received the item.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orderId: { type: "string", description: "Order ID to confirm delivery for" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "shop_orders",
    description:
      "List all shopping orders and spending summary. Shows order status, " +
      "remaining budget, and purchase history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Filter by status: purchased, delivered, cancelled" },
      },
    },
  },
  // ── Approval / HITL tools ──────────────────────────────────────────────────
  {
    name: "shop_pending_approvals",
    description:
      "List all purchases and charge requests waiting for your approval. " +
      "Items expire after 10 minutes if not approved.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "shop_approve",
    description:
      "Approve a pending purchase. Funds will be escrowed and purchase executed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orderId: { type: "string", description: "Order ID from shop_pending_approvals" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "shop_reject",
    description:
      "Reject a pending purchase. Order will be cancelled, no money moves.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orderId: { type: "string", description: "Order ID to reject" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "charge_request",
    description:
      "Request a charge that requires user approval before executing. " +
      "Unlike charge(), this queues the payment for review. " +
      "Use charge_approve or charge_reject to finalize.",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Amount in USD" },
        reason: { type: "string", description: "Why the charge is needed" },
      },
      required: ["amount", "reason"],
    },
  },
  {
    name: "charge_approve",
    description:
      "Approve a pending charge request. Executes the real charge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        requestId: { type: "string", description: "Request ID from charge_request" },
      },
      required: ["requestId"],
    },
  },
  {
    name: "charge_reject",
    description:
      "Reject a pending charge request. No money moves.",
    inputSchema: {
      type: "object" as const,
      properties: {
        requestId: { type: "string", description: "Request ID to reject" },
      },
      required: ["requestId"],
    },
  },
  // ── Payment method management ─────────────────────────────────────────────
  {
    name: "payment_method_add",
    description:
      "Create a Stripe customer and SetupIntent to collect a payment method. " +
      "Returns a client_secret for Stripe.js to confirm. Only works with Stripe rail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Customer email" },
        name: { type: "string", description: "Customer name (optional)" },
      },
      required: ["email"],
    },
  },
  {
    name: "payment_method_list",
    description:
      "List saved payment methods for a Stripe customer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customerId: { type: "string", description: "Stripe customer ID (cus_...)" },
      },
      required: ["customerId"],
    },
  },
  {
    name: "payment_method_remove",
    description:
      "Detach a payment method from a Stripe customer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paymentMethodId: { type: "string", description: "Payment method ID (pm_...)" },
      },
      required: ["paymentMethodId"],
    },
  },
  // ── Receipts & Export ─────────────────────────────────────────────────────
  {
    name: "receipt_get",
    description:
      "Get a formatted receipt for a transaction.",
    inputSchema: {
      type: "object" as const,
      properties: {
        txId: { type: "string", description: "Transaction ID" },
      },
      required: ["txId"],
    },
  },
  {
    name: "history_export",
    description:
      "Export full transaction history as JSON or CSV.",
    inputSchema: {
      type: "object" as const,
      properties: {
        format: { type: "string", enum: ["json", "csv"], description: "Export format (default: json)" },
        limit: { type: "number", description: "Max transactions (default: all)" },
      },
    },
  },
  // ── Agent FICO ─────────────────────────────────────────────────────────────
  {
    name: "agent_fico_score",
    description:
      "Compute the agent's FICO credit score (300-850). Uses payment history, " +
      "credit utilization, account age, behavior diversity, and fraud record. " +
      "Returns score, rating, fee rate, trust level, and HITL requirement.",
    inputSchema: {
      type: "object" as const,
      properties: {
        budgetCap: {
          type: "number",
          minimum: 1,
          description: "Agent's budget cap for utilization calculation (default: 10000)",
        },
        fraudFlags: { type: "number", minimum: 0, description: "Number of fraud flags (default: 0)" },
        disputeCount: { type: "number", minimum: 0, description: "Total disputes filed (default: 0)" },
        disputesLost: { type: "number", minimum: 0, description: "Disputes lost (default: 0)" },
        warnings: { type: "number", minimum: 0, description: "Fraud warnings (default: 0)" },
      },
    },
  },
  // ── Behavioral Finance ─────────────────────────────────────────────────────
  {
    name: "behavioral_analysis",
    description:
      "Run behavioral finance analysis on a proposed spending amount. " +
      "Returns prospect theory value, cooling-off recommendation, and loss framing. " +
      "Based on Kahneman & Tversky (1992) and Thaler & Benartzi (2004).",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "The spending amount to analyze" },
        monthlyIncome: {
          type: "number",
          minimum: 1,
          description: "Agent's monthly income/budget for cooling-off calculation",
        },
        goalName: { type: "string", description: "Savings goal name for loss framing" },
        goalTarget: { type: "number", description: "Savings goal target amount" },
        goalCurrent: { type: "number", description: "Current savings toward goal" },
        goalMonthlySavings: { type: "number", description: "Monthly savings rate" },
      },
      required: ["amount"],
    },
  },
  // ── Memory Integrity ───────────────────────────────────────────────────────
  {
    name: "memory_integrity_check",
    description:
      "Check the integrity of the agent's memory store using SHA-256 Merkle trees. " +
      "Detects tampering, injection, deletion, replay, and reordering attacks. " +
      "Returns root hash, leaf count, and tampering status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        snapshotHash: {
          type: "string",
          description: "Previous snapshot hash to compare against (optional — omit for first check)",
        },
      },
    },
  },
  // ── Checkout Executor ──────────────────────────────────────────────────────
  {
    name: "shop_checkout",
    description:
      "Complete a purchase on a merchant website using browser automation. " +
      "Navigates to the product URL, adds to cart, fills shipping/payment, " +
      "and completes checkout. Requires MNEMOPAY_BUYER_* env vars for buyer profile. " +
      "Supports Shopify natively; falls back to generic checkout for other sites.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productUrl: { type: "string", description: "Full URL of the product to purchase" },
        headless: { type: "boolean", description: "Run browser in headless mode (default: true)" },
        screenshotDir: { type: "string", description: "Directory to save debug screenshots" },
      },
      required: ["productUrl"],
    },
  },
  // ── Anomaly Detection ──────────────────────────────────────────────────────
  {
    name: "anomaly_check",
    description:
      "Check if a transaction amount is anomalous using EWMA streaming detection. " +
      "Returns whether the value is normal, a warning, or a critical anomaly. " +
      "Based on Roberts (1959) and Lucas & Saccucci (1990).",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Transaction amount to check" },
      },
      required: ["amount"],
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────────────────────

async function executeTool(agent: Agent, name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "remember": {
      const opts: any = {};
      if (args.importance !== undefined) opts.importance = args.importance;
      if (args.tags) opts.tags = args.tags;
      const id = await agent.remember(args.content, Object.keys(opts).length ? opts : undefined);
      return JSON.stringify({ id, status: "stored" });
    }

    case "recall": {
      const limit = args.limit ?? 5;
      const memories = args.query
        ? await agent.recall(args.query, limit)
        : await agent.recall(limit);
      if (memories.length === 0) return "No memories found.";
      return memories
        .map((m, i) => `${i + 1}. [score:${m.score.toFixed(2)}, importance:${m.importance.toFixed(2)}] ${m.content}`)
        .join("\n");
    }

    case "forget": {
      const deleted = await agent.forget(args.id);
      return deleted ? `Memory ${args.id} deleted.` : `Memory ${args.id} not found.`;
    }

    case "reinforce": {
      await agent.reinforce(args.id, args.boost ?? 0.1);
      return `Memory ${args.id} reinforced by +${args.boost ?? 0.1}`;
    }

    case "consolidate": {
      const pruned = await agent.consolidate();
      return `Consolidated: pruned ${pruned} stale memories.`;
    }

    case "charge": {
      const tx = await agent.charge(args.amount, args.reason);
      return JSON.stringify({ txId: tx.id, amount: tx.amount, status: tx.status, reason: tx.reason });
    }

    case "settle": {
      const tx = await agent.settle(args.txId, args.counterpartyId);
      return JSON.stringify({ txId: tx.id, amount: tx.amount, status: tx.status, rail: (agent as any).paymentRail?.name });
    }

    case "refund": {
      const tx = await agent.refund(args.txId);
      return JSON.stringify({ txId: tx.id, status: tx.status });
    }

    case "balance": {
      const bal = await agent.balance();
      return `Wallet: $${bal.wallet.toFixed(2)} | Reputation: ${bal.reputation.toFixed(2)}`;
    }

    case "profile": {
      const p = await agent.profile();
      return JSON.stringify(p, null, 2);
    }

    case "logs": {
      const entries = await agent.logs(args.limit ?? 20);
      return entries.map((e) => `[${e.createdAt.toISOString()}] ${e.action}: ${JSON.stringify(e.details)}`).join("\n");
    }

    case "history": {
      const txns = await agent.history(args.limit ?? 10);
      if (txns.length === 0) return "No transactions yet.";
      return txns.map((t) => `$${t.amount.toFixed(2)} — ${t.status} — ${t.reason}`).join("\n");
    }

    case "reputation": {
      const rep = await agent.reputation();
      return JSON.stringify(rep, null, 2);
    }

    case "dispute": {
      if (!("dispute" in agent)) throw new Error("Disputes only available in quick mode");
      const d = await (agent as MnemoPayLite).dispute(args.txId, args.reason);
      return JSON.stringify({ disputeId: d.id, txId: d.txId, status: d.status, reason: d.reason });
    }

    case "fraud_stats": {
      if (!("fraud" in agent)) throw new Error("Fraud stats only available in quick mode");
      const stats = (agent as MnemoPayLite).fraud.stats();
      return JSON.stringify(stats, null, 2);
    }

    // ── Commerce tools ───────────────────────────────────────────────────

    case "shop_set_mandate": {
      const commerce = await getCommerceEngine(agent);
      commerce.setMandate({
        budget: args.budget,
        maxPerItem: args.maxPerItem,
        categories: args.categories,
        blockedCategories: args.blockedCategories,
        allowedMerchants: args.allowedMerchants,
        approvalThreshold: args.approvalThreshold,
        issuedBy: args.issuedBy,
      });
      return JSON.stringify({
        status: "mandate_set",
        budget: args.budget,
        remainingBudget: commerce.remainingBudget,
        categories: args.categories ?? "any",
      });
    }

    case "shop_search": {
      const commerce = await getCommerceEngine(agent);
      const results = await commerce.search(args.query, {
        maxPrice: args.maxPrice,
        category: args.category,
        sortBy: args.sortBy,
        limit: args.limit,
      });
      if (results.length === 0) return "No products found matching your criteria.";
      return results.map((p: any, i: number) =>
        `${i + 1}. ${p.title} — $${p.price.toFixed(2)} from ${p.merchant}` +
        (p.rating ? ` (${p.rating}★, ${p.reviewCount} reviews)` : "") +
        (p.freeShipping ? " [Free shipping]" : "") +
        `\n   ID: ${p.productId}`
      ).join("\n\n") + `\n\nRemaining budget: $${commerce.remainingBudget.toFixed(2)}`;
    }

    case "shop_buy": {
      const commerce = await getCommerceEngine(agent);
      // Look up the product by ID from a fresh search
      const product = await commerce["provider"].getProduct(args.productId);
      if (!product) throw new Error(`Product not found: ${args.productId}`);
      const order = await commerce.purchase(product, args.deliveryInstructions);
      if (order.status === "cancelled") {
        return `Order cancelled: ${order.failureReason}`;
      }

      // If using a real provider (firecrawl/shopify), the purchase may need
      // browser checkout to actually complete. Attempt it if buyer profile is configured.
      const providerName = commerce["provider"]?.name;
      if (product.url && (providerName === "firecrawl" || providerName === "shopify")) {
        try {
          const { CheckoutExecutor } = await import("../commerce/checkout/index.js");
          const { loadProfileFromEnv } = await import("../commerce/checkout/profile.js");
          const buyerProfile = loadProfileFromEnv();
          if (buyerProfile) {
            const executor = new CheckoutExecutor({ profile: buyerProfile, headless: true });
            const checkoutResult = await executor.checkout(product.url);
            if (checkoutResult.success) {
              return JSON.stringify({
                orderId: order.id,
                product: order.product.title,
                price: order.product.price,
                status: "purchased",
                escrowTxId: order.txId,
                externalOrderId: checkoutResult.orderId,
                confirmationUrl: checkoutResult.confirmationUrl,
                totalCharged: checkoutResult.totalCharged,
                message: "Purchase completed via browser checkout. Funds in escrow until delivery confirmed.",
                remainingBudget: commerce.remainingBudget,
              });
            }
          }
        } catch { /* checkout executor not available — return standard result */ }
      }

      return JSON.stringify({
        orderId: order.id,
        product: order.product.title,
        price: order.product.price,
        status: order.status,
        escrowTxId: order.txId,
        message: "Funds held in escrow. Will be released when you confirm delivery.",
        remainingBudget: commerce.remainingBudget,
      });
    }

    case "shop_confirm_delivery": {
      const commerce = await getCommerceEngine(agent);
      const order = await commerce.confirmDelivery(args.orderId);
      return JSON.stringify({
        orderId: order.id,
        product: order.product.title,
        status: order.status,
        message: "Delivery confirmed. Escrow released. Merchant paid.",
      });
    }

    case "shop_orders": {
      const commerce = await getCommerceEngine(agent);
      const orders = commerce.listOrders(args.status);
      const summary = commerce.spendingSummary();
      if (orders.length === 0) return "No orders yet.";
      const list = orders.map((o: any) =>
        `• ${o.product.title} — $${o.product.price.toFixed(2)} [${o.status}]` +
        (o.trackingUrl ? ` Track: ${o.trackingUrl}` : "")
      ).join("\n");
      return `${list}\n\nSpent: $${summary.totalSpent.toFixed(2)} | Remaining: $${summary.remainingBudget.toFixed(2)} | Orders: ${summary.orderCount}`;
    }

    // ── Approval / HITL handlers ───────────────────────────────────────────

    case "shop_pending_approvals": {
      const shopApprovals = Array.from(pendingApprovals.entries()).map(([id, entry]) => ({
        orderId: id,
        product: entry.order.product?.title,
        price: entry.order.product?.price,
        merchant: entry.order.product?.merchant,
        waitingSince: new Date(entry.createdAt).toISOString(),
        expiresIn: Math.max(0, Math.round((600_000 - (Date.now() - entry.createdAt)) / 1000)) + "s",
      }));
      const chargeRequests = Array.from(pendingChargeRequests.entries()).map(([id, entry]) => ({
        requestId: id,
        amount: entry.amount,
        reason: entry.reason,
        waitingSince: new Date(entry.createdAt).toISOString(),
        expiresIn: Math.max(0, Math.round((600_000 - (Date.now() - entry.createdAt)) / 1000)) + "s",
      }));
      if (shopApprovals.length === 0 && chargeRequests.length === 0) {
        return "No pending approvals.";
      }
      return JSON.stringify({ shopApprovals, chargeRequests }, null, 2);
    }

    case "shop_approve": {
      const entry = pendingApprovals.get(args.orderId);
      if (!entry) throw new Error(`No pending approval for order ${args.orderId}`);
      entry.resolve(true);
      pendingApprovals.delete(args.orderId);
      return JSON.stringify({ status: "approved", orderId: args.orderId, message: "Purchase approved. Escrow and purchase executing." });
    }

    case "shop_reject": {
      const entry = pendingApprovals.get(args.orderId);
      if (!entry) throw new Error(`No pending approval for order ${args.orderId}`);
      entry.resolve(false);
      pendingApprovals.delete(args.orderId);
      return JSON.stringify({ status: "rejected", orderId: args.orderId, message: "Purchase rejected. No money moved." });
    }

    case "charge_request": {
      const requestId = `cr_${Date.now()}_${require("crypto").randomBytes(4).toString("hex")}`;
      pendingChargeRequests.set(requestId, {
        id: requestId,
        amount: args.amount,
        reason: args.reason,
        context: args.context,
        payOptions: args.payOptions,
        createdAt: Date.now(),
      });
      return JSON.stringify({
        requestId,
        amount: args.amount,
        reason: args.reason,
        status: "pending_approval",
        message: `Charge of $${args.amount.toFixed(2)} queued for approval. Use charge_approve("${requestId}") to execute.`,
        expiresIn: "10 minutes",
      });
    }

    case "charge_approve": {
      const req = pendingChargeRequests.get(args.requestId);
      if (!req) throw new Error(`No pending charge request ${args.requestId}`);
      pendingChargeRequests.delete(args.requestId);
      // Execute the real charge
      const tx = await agent.charge(req.amount, req.reason, req.context, req.payOptions);
      return JSON.stringify({
        status: "charged",
        requestId: args.requestId,
        txId: tx.id,
        amount: tx.amount,
        reason: req.reason,
        rail: (agent as any).paymentRail?.name,
        message: "Charge executed. Funds held in escrow. Use settle() to finalize.",
      });
    }

    case "charge_reject": {
      const req = pendingChargeRequests.get(args.requestId);
      if (!req) throw new Error(`No pending charge request ${args.requestId}`);
      pendingChargeRequests.delete(args.requestId);
      return JSON.stringify({
        status: "rejected",
        requestId: args.requestId,
        message: `Charge of $${req.amount.toFixed(2)} for "${req.reason}" rejected. No money moved.`,
      });
    }

    // ── Payment method management ─────────────────────────────────────────

    case "payment_method_add": {
      const rail = (agent as any).paymentRail;
      if (!rail || rail.name !== "stripe") throw new Error("payment_method_add requires Stripe rail. Set MNEMOPAY_PAYMENT_RAIL=stripe");
      const customer = await rail.createCustomer(args.email, args.name);
      const setup = await rail.createSetupIntent(customer.customerId);
      return JSON.stringify({
        customerId: customer.customerId,
        setupIntentId: setup.setupIntentId,
        clientSecret: setup.clientSecret,
        message: "Use this clientSecret with Stripe.js to collect the card. Then pass customerId + paymentMethodId to charge().",
      });
    }

    case "payment_method_list": {
      const rail = (agent as any).paymentRail;
      if (!rail || rail.name !== "stripe") throw new Error("payment_method_list requires Stripe rail");
      const stripe = (rail as any).stripe;
      const methods = await stripe.paymentMethods.list({ customer: args.customerId, type: "card" });
      const cards = methods.data.map((pm: any) => ({
        id: pm.id,
        brand: pm.card?.brand,
        last4: pm.card?.last4,
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
      }));
      if (cards.length === 0) return "No saved payment methods.";
      return JSON.stringify(cards, null, 2);
    }

    case "payment_method_remove": {
      const rail = (agent as any).paymentRail;
      if (!rail || rail.name !== "stripe") throw new Error("payment_method_remove requires Stripe rail");
      const stripe = (rail as any).stripe;
      await stripe.paymentMethods.detach(args.paymentMethodId);
      return JSON.stringify({ status: "removed", paymentMethodId: args.paymentMethodId });
    }

    // ── Receipts & Export ────────────────────────────────────────────────

    case "receipt_get": {
      const txHistory = await agent.history(10000);
      const tx = txHistory.find((t: any) => t.id === args.txId);
      if (!tx) throw new Error(`Transaction ${args.txId} not found`);
      const profile = await agent.profile();
      const receipt = [
        "═══════════════════════════════════════",
        "           MNEMOPAY RECEIPT            ",
        "═══════════════════════════════════════",
        `Transaction ID: ${tx.id}`,
        `Date:           ${tx.createdAt}`,
        `Agent:          ${tx.agentId || profile.id}`,
        `Amount:         $${tx.amount.toFixed(2)}`,
        `Status:         ${tx.status}`,
        `Reason:         ${tx.reason || "N/A"}`,
        tx.platformFee ? `Platform Fee:   $${tx.platformFee.toFixed(2)}` : null,
        tx.netAmount ? `Net Amount:     $${tx.netAmount.toFixed(2)}` : null,
        tx.externalId ? `External Ref:   ${tx.externalId}` : null,
        `Rail:           ${(agent as any).paymentRail?.name || "mock"}`,
        "═══════════════════════════════════════",
      ].filter(Boolean).join("\n");
      return receipt;
    }

    case "history_export": {
      const format = args.format || "json";
      const limit = args.limit || 10000;
      const txHistory = await agent.history(limit);
      if (format === "csv") {
        const railName = (agent as any).paymentRail?.name || "mock";
        const headers = "id,date,amount,status,reason,rail,externalId,platformFee,netAmount";
        const rows = txHistory.map((tx: any) =>
          [tx.id, tx.createdAt, tx.amount, tx.status, `"${(tx.reason || "").replace(/"/g, '""')}"`, railName, tx.externalId || "", tx.platformFee || "", tx.netAmount || ""].join(",")
        );
        return [headers, ...rows].join("\n");
      }
      return JSON.stringify(txHistory, null, 2);
    }

    // ── Agent FICO ─────────────────────────────────────────────────────────

    case "agent_fico_score": {
      const fico = new AgentFICO();
      const txHistory = await agent.history(1000);
      const profile = await agent.profile();
      const result = fico.compute({
        transactions: txHistory.map((tx: any) => ({
          id: tx.id,
          amount: tx.amount,
          status: tx.status,
          reason: tx.reason || "",
          createdAt: new Date(tx.createdAt),
          settledAt: tx.settledAt ? new Date(tx.settledAt) : undefined,
          counterparty: tx.counterparty,
        })),
        createdAt: new Date(Date.now() - 86400000 * 30),
        fraudFlags: args.fraudFlags ?? 0,
        disputeCount: args.disputeCount ?? 0,
        disputesLost: args.disputesLost ?? 0,
        warnings: args.warnings ?? 0,
        budgetCap: args.budgetCap ?? 10000,
        memoriesCount: profile.memoriesCount ?? 0,
      });
      return JSON.stringify(result, null, 2);
    }

    // ── Behavioral Finance ─────────────────────────────────────────────────

    case "behavioral_analysis": {
      const behavioral = new BehavioralEngine();
      const prospect = behavioral.prospectValue(args.amount);
      const analysis: any = { prospect };

      if (args.monthlyIncome) {
        analysis.coolingOff = behavioral.coolingOff(args.amount, args.monthlyIncome);
      }

      if (args.goalName && args.goalTarget && args.goalCurrent !== undefined && args.goalMonthlySavings) {
        analysis.lossFrame = behavioral.lossFrame(args.amount, {
          name: args.goalName,
          target: args.goalTarget,
          current: args.goalCurrent,
          monthlySavings: args.goalMonthlySavings,
        });
      }

      return JSON.stringify(analysis, null, 2);
    }

    // ── Memory Integrity ─────────────────────────────────────────────────

    case "memory_integrity_check": {
      const tree = _merkleTree;
      if (!tree || tree.size === 0) {
        // Build tree from current memories
        const memories = await agent.recall(50);
        for (const m of memories) {
          tree.addLeaf(m.id, m.content);
        }
      }
      const snapshot = tree.snapshot();
      const result: any = {
        rootHash: snapshot.rootHash,
        leafCount: snapshot.leafCount,
        snapshotHash: snapshot.snapshotHash,
      };
      if (args.snapshotHash) {
        const check = tree.detectTampering({
          rootHash: args.snapshotHash,
          leafCount: snapshot.leafCount,
          snapshotHash: args.snapshotHash,
          timestamp: new Date().toISOString(),
        });
        result.tampering = check;
      }
      return JSON.stringify(result, null, 2);
    }

    // ── Anomaly Detection ────────────────────────────────────────────────

    case "anomaly_check": {
      const result = _ewmaDetector.update(args.amount);
      return JSON.stringify(result, null, 2);
    }

    case "shop_checkout": {
      const { CheckoutExecutor } = await import("../commerce/checkout/index.js");
      const { loadProfileFromEnv } = await import("../commerce/checkout/profile.js");
      const profile = loadProfileFromEnv();
      if (!profile) {
        throw new Error(
          "Buyer profile not configured. Set MNEMOPAY_BUYER_NAME, MNEMOPAY_BUYER_EMAIL, " +
          "MNEMOPAY_BUYER_ADDRESS_LINE1, MNEMOPAY_BUYER_ADDRESS_CITY, MNEMOPAY_BUYER_ADDRESS_STATE, " +
          "MNEMOPAY_BUYER_ADDRESS_ZIP, MNEMOPAY_BUYER_ADDRESS_COUNTRY env vars."
        );
      }
      const executor = new CheckoutExecutor({
        profile,
        headless: args.headless ?? true,
        screenshotDir: args.screenshotDir,
      });
      const result = await executor.checkout(args.productUrl);
      return JSON.stringify({
        success: result.success,
        orderId: result.orderId,
        totalCharged: result.totalCharged,
        confirmationUrl: result.confirmationUrl,
        steps: result.steps,
        elapsedMs: result.elapsedMs,
        failureReason: result.failureReason,
        screenshots: result.screenshots,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Module singletons ────────────────────────────────────────────────────────

const _merkleTree = new MerkleTree();
const _ewmaDetector = new EWMADetector(0.15, 2.5, 3.5, 10);

// ── Approval queues (HITL) ──────────────────────────────────────────────────

interface PendingApproval {
  order: any;
  resolve: (approved: boolean) => void;
  createdAt: number;
}

interface PendingChargeRequest {
  id: string;
  amount: number;
  reason: string;
  context?: any;
  payOptions?: any;
  createdAt: number;
}

const pendingApprovals = new Map<string, PendingApproval>();
const pendingChargeRequests = new Map<string, PendingChargeRequest>();

// Auto-expire pending approvals after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingApprovals) {
    if (now - entry.createdAt > 600_000) {
      entry.resolve(false); // auto-reject expired approvals
      pendingApprovals.delete(id);
    }
  }
  for (const [id, entry] of pendingChargeRequests) {
    if (now - entry.createdAt > 600_000) {
      pendingChargeRequests.delete(id);
    }
  }
}, 60_000);

// ── Commerce singleton ──────────────────────────────────────────────────────

let _commerceEngine: any = null;

async function getCommerceEngine(agent: Agent): Promise<any> {
  if (!_commerceEngine) {
    const { CommerceEngine } = await import("../commerce.js");

    // ── Commerce provider selection ──────────────────────────────────────
    // Set MNEMOPAY_COMMERCE_PROVIDER to "firecrawl", "shopify", or "mock".
    const providerName = (process.env.MNEMOPAY_COMMERCE_PROVIDER || "mock").toLowerCase();
    let provider: any;

    switch (providerName) {
      case "firecrawl": {
        const { FirecrawlProvider } = await import("../commerce/providers/firecrawl.js");
        const apiKey = process.env.FIRECRAWL_API_KEY;
        if (!apiKey) throw new Error("FIRECRAWL_API_KEY required when MNEMOPAY_COMMERCE_PROVIDER=firecrawl");
        provider = new FirecrawlProvider({ apiKey });
        break;
      }
      case "shopify": {
        const { ShopifyProvider } = await import("../commerce/providers/shopify.js");
        const domain = process.env.SHOPIFY_STORE_DOMAIN;
        const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
        if (!domain || !token) throw new Error("SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN required when MNEMOPAY_COMMERCE_PROVIDER=shopify");
        provider = new ShopifyProvider({ storeDomain: domain, storefrontToken: token });
        break;
      }
      default:
        provider = undefined; // CommerceEngine uses MockCommerceProvider
    }

    _commerceEngine = new CommerceEngine(agent, provider);

    // ── Wire approval callback (HITL) ────────────────────────────────────
    _commerceEngine.onApprovalRequired(async (order: any) => {
      // Queue the order for user approval instead of auto-approving
      return new Promise<boolean>((resolve) => {
        pendingApprovals.set(order.id, { order, resolve, createdAt: Date.now() });
      });
    });
  }
  return _commerceEngine;
}

// ─── Server setup ───────────────────────────────────────────────────────────

export async function startServer(): Promise<void> {
  const agent = createAgent();

  const server = new Server(
    { name: "mnemopay", version: "1.0.0-beta.1" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // ── Tools ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      // Security: MCP-level rate limiting (prevents tool call flooding)
      mcpLimiter.check();

      // Security: API key auth when MNEMOPAY_API_KEY is set
      // Uses constant-time comparison to prevent timing attacks
      const requiredKey = process.env.MNEMOPAY_API_KEY;
      if (requiredKey) {
        const providedKey = (request as any).params?._apiKey || process.env.MNEMOPAY_CLIENT_KEY || "";
        if (!constantTimeEqual(providedKey, requiredKey)) {
          return {
            content: [{ type: "text", text: "Error: Unauthorized — invalid API key" }],
            isError: true,
          };
        }
      }

      const result = await executeTool(agent, name, args ?? {});
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      // Security: sanitize error messages — never leak internal state
      const safeMessage = (err.message || "Unknown error")
        .replace(/[\r\n]/g, " ")               // prevent header injection
        .replace(/\/[^\s]+/g, "[path]")        // strip file paths
        .replace(/[a-f0-9-]{36}/gi, "[id]")    // strip UUIDs
        .replace(/\$[\d.]+/g, "[amount]")       // strip dollar amounts from errors
        .slice(0, 200);                          // cap length
      return {
        content: [{ type: "text", text: `Error: ${safeMessage}` }],
        isError: true,
      };
    }
  });

  // ── Resources ───────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "mnemopay://health",
        name: "Agent Health",
        description: "Current agent profile, wallet, reputation, and memory stats",
        mimeType: "application/json",
      },
      {
        uri: "mnemopay://memories",
        name: "All Memories",
        description: "Top 20 memories ranked by composite score",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "mnemopay://health") {
      const profile = await agent.profile();
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(profile, null, 2) }],
      };
    }

    if (uri === "mnemopay://memories") {
      const memories = await agent.recall(20);
      const text = memories.length === 0
        ? "No memories stored."
        : memories
            .map((m, i) => `${i + 1}. [${m.importance.toFixed(2)}] ${m.content}`)
            .join("\n");
      return { contents: [{ uri, mimeType: "text/plain", text }] };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // ── Prompts ─────────────────────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "recall-and-decide",
        description:
          "Recall all relevant memories, analyze them, and make a decision. " +
          "Includes the agent's current reputation and wallet status.",
        arguments: [
          { name: "question", description: "The decision or question to address", required: true },
        ],
      },
      {
        name: "agent-status-report",
        description: "Generate a full status report of the agent's memory health and financial state.",
      },
      {
        name: "session-start",
        description:
          "Load memory context at the beginning of a session. " +
          "Recalls relevant memories from prior sessions. " +
          "Call this at the start of every Claude Code session.",
        arguments: [
          { name: "context", description: "Optional topic or task to focus memory recall on", required: false },
        ],
      },
      {
        name: "session-end",
        description:
          "Consolidate memory and save a session summary before stopping. " +
          "Prunes stale memories, stores a summary, and forces a disk save. " +
          "Call this before every session end.",
        arguments: [
          { name: "summary", description: "A brief summary of what was accomplished this session", required: false },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "recall-and-decide") {
      const memories = await agent.recall(10);
      const profile = await agent.profile();
      const memoryBlock = memories.length === 0
        ? "No memories available."
        : memories.map((m, i) => `${i + 1}. [${m.score.toFixed(2)}] ${m.content}`).join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Question: ${args?.question || "What should I do next?"}`,
                "",
                "## Agent Status",
                `Reputation: ${profile.reputation} | Wallet: $${profile.wallet} | Memories: ${profile.memoriesCount}`,
                "",
                "## Relevant Memories",
                memoryBlock,
                "",
                "Based on these memories and the agent's current state, provide your analysis and recommendation.",
                "If you take an action that delivers value, use the charge tool to invoice for it.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    if (name === "agent-status-report") {
      const profile = await agent.profile();
      const memories = await agent.recall(10);
      const recent = await agent.history(5);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "## Agent Status Report",
                "",
                `Agent: ${profile.id}`,
                `Reputation: ${profile.reputation.toFixed(2)}`,
                `Wallet: $${profile.wallet.toFixed(2)}`,
                `Memories: ${profile.memoriesCount}`,
                `Transactions: ${profile.transactionsCount}`,
                "",
                "## Top Memories",
                ...memories.map((m, i) => `${i + 1}. [${m.importance.toFixed(2)}] ${m.content}`),
                "",
                "## Recent Transactions",
                ...(recent.length === 0
                  ? ["No transactions yet."]
                  : recent.map((t) => `$${t.amount.toFixed(2)} — ${t.status} — ${t.reason}`)),
                "",
                "Analyze this agent's health: memory quality, financial performance, reputation trajectory.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    if (name === "session-start") {
      const query = args?.context as string | undefined;
      const memories = query ? await agent.recall(query, 10) : await agent.recall(10);
      const profile = await agent.profile();
      const memoryBlock =
        memories.length === 0
          ? "No memories found from previous sessions."
          : memories
              .map((m, i) => `${i + 1}. [score:${m.score.toFixed(2)}, importance:${m.importance.toFixed(2)}] ${m.content}`)
              .join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "## Session Start — Memory Context",
                "",
                `Agent: ${profile.id} | Memories: ${profile.memoriesCount} | Reputation: ${profile.reputation.toFixed(2)}`,
                "",
                "## Recalled Memories",
                memoryBlock,
                "",
                "Use this context to inform your responses. When you learn new important information this session, call the remember tool.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    if (name === "session-end") {
      const summary = args?.summary as string | undefined;
      const result = await (agent as any).onSessionEnd(summary);
      const profile = await agent.profile();
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "## Session End — Complete",
                "",
                `Memories pruned: ${result.pruned}`,
                `Session summary stored: ${result.memorized ? "yes" : "no"}`,
                `Remaining memories: ${profile.memoriesCount}`,
                "",
                summary ? `Summary recorded: "${summary}"` : "No summary provided.",
                "",
                "Memory store has been consolidated and saved to disk.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // ── Start ───────────────────────────────────────────────────────────────

  const useHttp = process.argv.includes("--http") || !!process.env.PORT;

  if (useHttp) {
    const express = (await import("express")).default;
    const { SSEServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/sse.js"
    );

    const app = express();
    app.use(express.json());

    // ── Rate limiting middleware ──────────────────────────────────────────
    const rateLimiter = new RateLimiter({
      maxRequests: parseInt(process.env.MNEMOPAY_RATE_LIMIT || "60", 10),
      windowMs: 60_000,
      maxPaymentRequests: parseInt(process.env.MNEMOPAY_PAYMENT_RATE_LIMIT || "10", 10),
      paymentWindowMs: 60_000,
    });

    // Cleanup stale rate limit entries every 5 minutes
    setInterval(() => rateLimiter.cleanup(), 300_000);

    function getClientIp(req: any): string {
      return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
        || req.headers["x-real-ip"]
        || req.socket?.remoteAddress
        || "unknown";
    }

    app.use((req: any, res: any, next: any) => {
      const ip = getClientIp(req);
      // Store IP on request for downstream use
      req.clientIp = ip;

      const { allowed, remaining, retryAfterMs } = rateLimiter.check(ip);
      res.setHeader("X-RateLimit-Remaining", remaining);
      if (!allowed) {
        res.setHeader("Retry-After", Math.ceil((retryAfterMs || 60000) / 1000));
        res.status(429).json({ error: "Rate limit exceeded", retryAfterMs });
        return;
      }
      next();
    });

    const transports: Record<string, InstanceType<typeof SSEServerTransport>> = {};

    app.get("/health", (_req, res) => {
      res.json({ status: "ok", mode: process.env.MNEMOPAY_MODE || "quick" });
    });

    // A2A Agent Card — makes this agent discoverable by other agents
    app.get("/.well-known/agent.json", (_req, res) => {
      res.json(agent.agentCard(
        process.env.MNEMOPAY_URL || `http://localhost:${process.env.PORT || 3200}`,
        process.env.MNEMOPAY_CONTACT,
      ));
    });

    // ── Authentication for SSE/HTTP endpoints ────────────────────────────
    const MCP_AUTH_TOKEN = process.env.MNEMOPAY_MCP_TOKEN;
    if (!MCP_AUTH_TOKEN) {
      console.error("[mnemopay-mcp] WARNING: MNEMOPAY_MCP_TOKEN not set — SSE endpoints are unauthenticated");
    }

    function mcpAuth(req: any, res: any, next: any) {
      if (!MCP_AUTH_TOKEN) { next(); return; }
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    }

    app.get("/mcp", mcpAuth, async (req: any, res: any) => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      transport.onclose = async () => {
        delete transports[transport.sessionId];
        try {
          await (agent as any).onSessionEnd();
        } catch (err) {
          console.error("[mnemopay-mcp] onclose session-end error:", err);
        }
      };
      await server.connect(transport);
      console.error(`[mnemopay-mcp] SSE session: ${transport.sessionId}`);
    });

    app.post("/messages", mcpAuth, async (req: any, res: any) => {
      const sessionId = req.query.sessionId as string;
      if (!sessionId || typeof sessionId !== "string" || sessionId.length > 128) {
        res.status(400).json({ error: "Invalid session ID" });
        return;
      }
      const transport = transports[sessionId];
      if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
      await transport.handlePostMessage(req, res, req.body);
    });

    // ── REST API ─────────────────────────────────────────────────────────
    // Every MnemoPay tool as a simple POST endpoint.
    // Works from any client: browser, React Native, curl, other agents.

    // CORS for browser/mobile access
    app.use("/api", (req: any, res: any, next: any) => {
      // CORS: restrict to configured origins only. Default blocks cross-origin to prevent CSRF on payment APIs.
      const allowedOrigin = process.env.MNEMOPAY_CORS_ORIGIN || "";
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "null");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      if (req.method === "OPTIONS") { res.status(204).end(); return; }
      next();
    });

    // Tool discovery
    app.get("/api/tools", mcpAuth, (_req: any, res: any) => {
      res.json({
        tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
        version: "0.9.3",
      });
    });

    // Generic tool executor: POST /api/:tool
    app.post("/api/:tool", mcpAuth, async (req: any, res: any) => {
      const toolName = req.params.tool;
      const validTools = TOOLS.map(t => t.name);
      if (!validTools.includes(toolName)) {
        res.status(404).json({ error: `Unknown tool: ${toolName}` });
        return;
      }
      try {
        const result = await executeTool(agent, toolName, req.body ?? {});
        // Try to parse as JSON for structured response
        try {
          res.json({ ok: true, tool: toolName, result: JSON.parse(result) });
        } catch {
          res.json({ ok: true, tool: toolName, result });
        }
      } catch (err: any) {
        res.status(400).json({ ok: false, tool: toolName, error: err.message });
      }
    });

    // ── Commerce REST endpoints ──────────────────────────────────────────
    // Higher-level shopping flows on top of the core tools.

    let commerceEngine: any = null;

    async function getCommerce() {
      if (!commerceEngine) {
        const { CommerceEngine } = await import("../commerce.js");
        commerceEngine = new CommerceEngine(agent);
      }
      return commerceEngine;
    }

    app.post("/api/commerce/mandate", mcpAuth, async (req: any, res: any) => {
      try {
        const commerce = await getCommerce();
        commerce.setMandate(req.body);
        res.json({ ok: true, mandate: commerce.getMandate(), remainingBudget: commerce.remainingBudget });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    app.post("/api/commerce/search", mcpAuth, async (req: any, res: any) => {
      try {
        const commerce = await getCommerce();
        const results = await commerce.search(req.body.query, req.body.options);
        res.json({ ok: true, results, remainingBudget: commerce.remainingBudget });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    app.post("/api/commerce/purchase", mcpAuth, async (req: any, res: any) => {
      try {
        const commerce = await getCommerce();
        const order = await commerce.purchase(req.body.product, req.body.deliveryInstructions);
        res.json({ ok: true, order });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    app.post("/api/commerce/confirm", mcpAuth, async (req: any, res: any) => {
      try {
        const commerce = await getCommerce();
        const order = await commerce.confirmDelivery(req.body.orderId);
        res.json({ ok: true, order });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    app.post("/api/commerce/cancel", mcpAuth, async (req: any, res: any) => {
      try {
        const commerce = await getCommerce();
        const order = await commerce.cancelOrder(req.body.orderId, req.body.reason);
        res.json({ ok: true, order });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    app.get("/api/commerce/orders", mcpAuth, async (req: any, res: any) => {
      try {
        const commerce = await getCommerce();
        const status = req.query.status as string | undefined;
        const orders = commerce.listOrders(status);
        res.json({ ok: true, orders, summary: commerce.spendingSummary() });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    const port = parseInt(process.env.PORT || "3200", 10);
    app.listen(port, () => {
      console.error(`[mnemopay] Server on port ${port} — MCP: /mcp | REST: /api/:tool | Commerce: /api/commerce/*`);
    });
  } else {
    const transport = new StdioServerTransport();
    process.on("exit", () => {
      if ("_saveToDisk" in agent) (agent as any)._saveToDisk();
    });
    await server.connect(transport);
    console.error("[mnemopay-mcp] Server started (stdio mode)");
  }
}

// ─── Smithery sandbox — allows tool scanning without real credentials ──────

export default function createSandboxServer(): Server {
  const agent = MnemoPay.quick("smithery-sandbox");

  const server = new Server(
    { name: "mnemopay", version: "1.0.0-beta.1" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await executeTool(agent, name, args ?? {});
    return { content: [{ type: "text", text: result }] };
  });

  return server;
}

// Auto-start when run directly
const isDirectRun = process.argv[1]?.includes("mcp") || process.argv.includes("--start");
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
