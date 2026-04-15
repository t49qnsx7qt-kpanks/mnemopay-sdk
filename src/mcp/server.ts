#!/usr/bin/env node
/**
 * MnemoPay Unified MCP Server
 *
 * Exposes MnemoPay SDK methods as MCP tools. Any MCP-compatible client
 * (Claude Desktop, Cursor, Windsurf, OpenClaw, Hermes) gets agent memory
 * + wallet capabilities instantly.
 *
 * Usage:
 *   npx @mnemopay/mcp-server                         # stdio, essentials (default)
 *   npx @mnemopay/mcp-server --tools=all             # all 40 tools
 *   npx @mnemopay/mcp-server --tools=memory,wallet   # memory + wallet only
 *   npx @mnemopay/mcp-server --http --port 3200      # HTTP/SSE mode
 *
 * Tool groups (pass via --tools=... or MNEMOPAY_TOOLS env var):
 *   essentials  memory + wallet + tx          (default — minimal context)
 *   memory      remember/recall/forget/reinforce/consolidate
 *   wallet      balance/profile/history/logs
 *   tx          charge/settle/refund/dispute/receipt_get
 *   commerce    shop_* + checkout executor
 *   hitl        approval queue (shop + charge requests)
 *   payments    payment_method_* + payout_*
 *   webhooks    webhook_register/list
 *   fico        agent_fico_score/behavioral/anomaly/fraud/reputation
 *   security    memory_integrity_check/history_export
 *   agent       essentials + commerce + hitl + payments + webhooks
 *   all         every tool (40)
 *
 * Environment:
 *   MNEMOPAY_TOOLS      — Comma-separated group list (alternative to --tools)
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
import { MnemoPay, MnemoPayLite, RateLimiter, constantTimeEqual, AgentCreditScore, MerkleTree, BehavioralEngine, EWMADetector } from "../index.js";
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

// ─── Tool group registry ────────────────────────────────────────────────────
// Users select tool groups via --tools=<csv> or MNEMOPAY_TOOLS env var to
// control MCP context weight. Default = "essentials" (~1K tokens instead of ~3.8K).

const TOOL_GROUPS: Record<string, string[]> = {
  memory: ["remember", "recall", "forget", "reinforce", "consolidate"],
  wallet: ["balance", "profile", "history", "logs"],
  tx: ["charge", "settle", "refund", "dispute", "receipt_get"],
  commerce: [
    "shop_set_mandate", "shop_search", "shop_buy",
    "shop_confirm_delivery", "shop_orders", "shop_checkout",
  ],
  hitl: [
    "shop_pending_approvals", "shop_approve", "shop_reject",
    "charge_request", "charge_approve", "charge_reject",
  ],
  payments: [
    "payment_method_add", "payment_method_list", "payment_method_remove",
    "payout_create", "payout_status",
  ],
  webhooks: ["webhook_register", "webhook_list"],
  fico: [
    "agent_fico_score", "behavioral_analysis",
    "anomaly_check", "fraud_stats", "reputation",
  ],
  security: ["memory_integrity_check", "history_export"],
};

const GROUP_ALIASES: Record<string, string[]> = {
  essentials: ["memory", "wallet", "tx"],
  agent: ["memory", "wallet", "tx", "commerce", "hitl", "payments", "webhooks"],
  all: Object.keys(TOOL_GROUPS),
};

function resolveToolFilter(spec: string | undefined): Set<string> {
  const raw = (spec ?? "essentials").trim().toLowerCase();
  if (!raw) return new Set(TOOL_GROUPS.memory.concat(TOOL_GROUPS.wallet, TOOL_GROUPS.tx));
  const requested = raw.split(",").map(s => s.trim()).filter(Boolean);
  const allowed = new Set<string>();
  for (const token of requested) {
    if (GROUP_ALIASES[token]) {
      for (const g of GROUP_ALIASES[token]) TOOL_GROUPS[g].forEach(t => allowed.add(t));
    } else if (TOOL_GROUPS[token]) {
      TOOL_GROUPS[token].forEach(t => allowed.add(t));
    } else {
      console.error(`[mnemopay-mcp] Unknown tool group: "${token}" (ignored). Valid: ${[...Object.keys(GROUP_ALIASES), ...Object.keys(TOOL_GROUPS)].join(", ")}`);
    }
  }
  if (allowed.size === 0) {
    GROUP_ALIASES.essentials.forEach(g => TOOL_GROUPS[g].forEach(t => allowed.add(t)));
  }
  return allowed;
}

function getToolFilterSpec(argv: string[]): string | undefined {
  const flagEq = argv.find(a => a.startsWith("--tools="));
  if (flagEq) return flagEq.slice("--tools=".length);
  const flagIdx = argv.indexOf("--tools");
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  return process.env.MNEMOPAY_TOOLS;
}

// ─── Guide resources ────────────────────────────────────────────────────────
// Tutorial prose that used to live in tool descriptions. Agents read these
// on demand via resources/read when they need the full context. This keeps
// tools/list lean (invocation signatures only).

const GUIDES: Record<string, { name: string; description: string; body: string }> = {
  "guide/tx": {
    name: "Guide: Transactions",
    description: "charge / settle / refund mechanics, reputation effects, dispute window",
    body: [
      "# Transactions",
      "",
      "**charge(amount, reason)** — opens an escrow held pending settlement.",
      "- Max charge = $500 × agent reputation. Call only AFTER delivering value.",
      "- Returns a txId for later settle/refund/dispute.",
      "",
      "**settle(txId, counterpartyId?)** — finalizes the escrow:",
      "- Moves funds to the agent wallet.",
      "- Boosts reputation +0.01.",
      "- Reinforces recently-accessed memories +0.05 (the learning feedback loop).",
      "- If `requireCounterparty` is enabled for this agent, a *different* agent ID must confirm.",
      "",
      "**refund(txId)** — reverses a transaction:",
      "- If already settled, withdraws funds and docks reputation -0.05.",
      "- Recovery cost: ~5 successful settlements to earn back a refund.",
      "",
      "**dispute(txId, reason)** — opens a dispute inside the 24h window. Freezes the tx until resolved.",
    ].join("\n"),
  },
  "guide/commerce": {
    name: "Guide: Commerce",
    description: "Shopping mandates, escrow-backed purchase, delivery confirmation",
    body: [
      "# Commerce",
      "",
      "The commerce flow is mandate-gated — the agent cannot buy anything without a mandate",
      "issued by the user. The mandate protects the user's money.",
      "",
      "## 1. shop_set_mandate",
      "Required first call. Defines:",
      "- `budget` (USD, total cap)",
      "- `maxPerItem` (defaults to budget)",
      "- `categories` / `blockedCategories`",
      "- `allowedMerchants` (merchant domain allow-list)",
      "- `approvalThreshold` — purchases above this require HITL approval",
      "- `issuedBy` — user name or ID who authorized the mandate (audit trail)",
      "",
      "## 2. shop_search(query, filters)",
      "Searches within the active mandate. Considers agent memory for past preferences.",
      "",
      "## 3. shop_buy(productId)",
      "Escrows funds — money is NOT released until `shop_confirm_delivery`. If the",
      "purchase fails at the provider level, escrow is automatically refunded.",
      "",
      "## 4. shop_confirm_delivery(orderId)",
      "Releases escrow to the merchant. Call only when the user confirms physical receipt.",
      "",
      "Use `shop_orders` to view status and remaining budget at any time.",
    ].join("\n"),
  },
  "guide/hitl": {
    name: "Guide: Human-in-the-loop",
    description: "Approval queues for purchases and charge requests",
    body: [
      "# Human-in-the-loop (HITL)",
      "",
      "Two approval queues run in parallel:",
      "",
      "## Shop approvals",
      "Triggered when a purchase exceeds `approvalThreshold` in the shopping mandate.",
      "- `shop_pending_approvals` — list items awaiting review",
      "- `shop_approve(orderId)` — escrow funds + execute",
      "- `shop_reject(orderId)` — cancel, no funds move",
      "- Items expire after 10 minutes.",
      "",
      "## Charge request approvals",
      "Unlike `charge()` (which runs immediately), `charge_request()` queues the",
      "payment for the user to review.",
      "- `charge_request(amount, reason)` — returns a requestId",
      "- `charge_approve(requestId)` — executes the real charge",
      "- `charge_reject(requestId)` — drops it, no money moves",
    ].join("\n"),
  },
  "guide/fico": {
    name: "Guide: Agent FICO & behavioral finance",
    description: "Credit score model, behavioral analysis, anomaly detection",
    body: [
      "# Agent FICO (300-850)",
      "",
      "Computed from five factors:",
      "1. Payment history (35%) — settlement rate, on-time rate",
      "2. Credit utilization (30%) — outstanding escrows vs budget cap",
      "3. Account age (15%) — time since agent creation",
      "4. Behavior diversity (10%) — variety of merchants/categories",
      "5. Fraud record (10%) — flags, disputes lost, warnings",
      "",
      "Returns: `score`, `rating` (Exceptional/Very Good/Good/Fair/Poor), `feeRate`,",
      "`trustLevel`, and `hitlRequired` (forces approval queues below threshold).",
      "",
      "# behavioral_analysis(amount, ...)",
      "",
      "Applies prospect theory (Kahneman & Tversky 1992) and mental accounting",
      "(Thaler & Benartzi 2004). Returns:",
      "- Prospect theory value function output",
      "- Cooling-off recommendation (delay in hours) based on monthlyIncome ratio",
      "- Loss framing vs an active savings goal if provided",
      "",
      "# anomaly_check(amount)",
      "",
      "EWMA streaming detector (Roberts 1959, Lucas & Saccucci 1990). Returns",
      "`normal` / `warning` / `critical`. Call inline before executing large charges.",
    ].join("\n"),
  },
  "guide/webhooks": {
    name: "Guide: Webhooks",
    description: "Event types and payload format for webhook_register",
    body: [
      "# Webhooks",
      "",
      "`webhook_register(url, events)` subscribes a callback URL to lifecycle events.",
      "Events are stored in-memory and dispatched when matching events occur.",
      "",
      "Event types:",
      "- `charge.success` — charge accepted into escrow",
      "- `charge.failed`  — charge rejected (reputation cap, fraud, mandate breach)",
      "- `settle`         — escrow released, funds moved",
      "- `refund`         — transaction reversed",
      "- `transfer.success` — Paystack payout completed",
      "- `transfer.failed`  — Paystack payout failed",
      "",
      "Payloads are JSON with `event`, `txId`, `timestamp`, and event-specific fields.",
    ].join("\n"),
  },
  "guide/checkout": {
    name: "Guide: Browser checkout executor",
    description: "Buyer profile env vars and merchant support for shop_checkout",
    body: [
      "# shop_checkout",
      "",
      "Browser-automates a real purchase on a merchant website: navigates to the",
      "product URL, adds to cart, fills shipping/payment, submits.",
      "",
      "## Supported merchants",
      "- **Shopify** — native detection, optimized selectors",
      "- **Other** — falls back to a generic checkout heuristic",
      "",
      "## Required env (buyer profile)",
      "Set these before calling `shop_checkout`:",
      "- `MNEMOPAY_BUYER_EMAIL`",
      "- `MNEMOPAY_BUYER_NAME`",
      "- `MNEMOPAY_BUYER_ADDRESS1`, `MNEMOPAY_BUYER_CITY`, `MNEMOPAY_BUYER_STATE`, `MNEMOPAY_BUYER_ZIP`, `MNEMOPAY_BUYER_COUNTRY`",
      "- `MNEMOPAY_BUYER_CARD_NUMBER`, `MNEMOPAY_BUYER_CARD_EXP`, `MNEMOPAY_BUYER_CARD_CVC`",
      "",
      "## Options",
      "- `headless` (default true) — set false to watch the run",
      "- `screenshotDir` — save debug screenshots at each checkout step",
    ].join("\n"),
  },
};

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory persisted across sessions. Importance auto-scored if omitted.",
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
      "Recall top memories. Semantic search if query provided, else importance-ranked.",
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
    description: "Boost a memory's importance after it yielded a good outcome.",
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
    description: "Prune stale memories below the decay threshold.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "charge",
    description:
      "Create an escrow charge for delivered work. Max = $500 × reputation. See mnemopay://guide/tx.",
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
      "Finalize a pending escrow. Releases funds, +0.01 reputation. See mnemopay://guide/tx.",
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
    description: "Refund a transaction. Docks reputation -0.05 if already settled.",
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
    description: "Agent stats: reputation, wallet, memory count, tx count.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "logs",
    description: "Audit trail of memory and payment actions.",
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
    description: "Reputation report: score, tier, settlement rate, memory stats.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "dispute",
    description: "Dispute a settled tx within 24h window. Freezes it pending resolution.",
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
    description: "Fraud stats: tracked/flagged/blocked agents, open disputes, fees.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ── Commerce tools ───────────────────────────────────────────────────
  {
    name: "shop_set_mandate",
    description:
      "Set shopping mandate (budget + restrictions). Required before shop_search/buy. See mnemopay://guide/commerce.",
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
    description: "Search products within the active mandate (budget/category/merchant filtered).",
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
    description: "Purchase a product. Funds held in escrow until shop_confirm_delivery.",
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
    description: "Confirm delivery and release escrow to the merchant.",
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
    description: "List orders with status, remaining budget, and purchase history.",
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
    description: "List purchases/charges pending approval. Expire in 10 min.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "shop_approve",
    description: "Approve a pending purchase. Escrows funds and executes.",
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
    description: "Reject a pending purchase. Order cancelled, no funds move.",
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
    description: "Queue a charge for user approval. Finalize via charge_approve/reject.",
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
    description: "Approve a pending charge request and execute it.",
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
    description: "Reject a pending charge request.",
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
    description: "Create Stripe customer + SetupIntent. Returns client_secret. Stripe rail only.",
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
    description: "List saved payment methods for a Stripe customer.",
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
    description: "Detach a payment method from a Stripe customer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paymentMethodId: { type: "string", description: "Payment method ID (pm_...)" },
      },
      required: ["paymentMethodId"],
    },
  },
  // ── Payouts (Paystack) ─────────────────────────────────────────────────────
  {
    name: "payout_create",
    description: "Initiate a Paystack bank payout (creates recipient + transfer). Paystack rail only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        accountName: { type: "string", description: "Recipient's name" },
        accountNumber: { type: "string", description: "Bank account number" },
        bankCode: { type: "string", description: "Bank code (e.g., '058' for GTBank)" },
        amount: { type: "number", description: "Amount in NGN" },
        reason: { type: "string", description: "Reason for the transfer" },
      },
      required: ["accountName", "accountNumber", "bankCode", "amount", "reason"],
    },
  },
  {
    name: "payout_status",
    description: "Check Paystack payout status by transfer code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        transferCode: { type: "string", description: "Transfer code from payout_create (e.g., TRF_...)" },
      },
      required: ["transferCode"],
    },
  },
  // ── Webhooks ──────────────────────────────────────────────────────────────
  {
    name: "webhook_register",
    description: "Register a webhook URL for payment events. See mnemopay://guide/webhooks for event types.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Callback URL to receive events" },
        events: {
          type: "array",
          items: { type: "string" },
          description: "Event types to subscribe to: charge.success, charge.failed, settle, refund, transfer.success, transfer.failed",
        },
      },
      required: ["url", "events"],
    },
  },
  {
    name: "webhook_list",
    description: "List registered webhook subscriptions.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ── Receipts & Export ─────────────────────────────────────────────────────
  {
    name: "receipt_get",
    description: "Get a formatted receipt for a transaction.",
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
    description: "Export full tx history as JSON or CSV.",
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
      "Compute Agent FICO score (300-850). Returns score, tier, fee rate. See mnemopay://guide/fico.",
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
      "Analyze a spending amount (prospect theory, cooling-off, loss framing). See mnemopay://guide/fico.",
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
      "SHA-256 Merkle integrity check over memories. Returns root hash, leaf count, tamper status.",
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
      "Browser-automated checkout on a merchant URL. See mnemopay://guide/checkout for env setup.",
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
    description: "EWMA streaming anomaly check on a tx amount. Returns normal/warning/critical.",
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
      const fico = new AgentCreditScore();
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

    // ── Payouts (Paystack) ──────────────────────────────────────────────

    case "payout_create": {
      const rail = (agent as any).paymentRail;
      if (!rail || rail.name !== "paystack") throw new Error("payout_create requires Paystack rail. Set MNEMOPAY_PAYMENT_RAIL=paystack");
      const recipient = await rail.createTransferRecipient(
        args.accountName,
        args.accountNumber,
        args.bankCode,
      );
      const transfer = await rail.initiateTransfer(
        recipient.recipientCode,
        args.amount,
        args.reason,
        (agent as any).agentId,
      );
      return JSON.stringify({
        status: "initiated",
        transferCode: transfer.externalId,
        reference: transfer.reference,
        amount: transfer.amount,
        recipientCode: recipient.recipientCode,
        recipientName: recipient.name,
        transferStatus: transfer.transferStatus,
      }, null, 2);
    }

    case "payout_status": {
      const rail = (agent as any).paymentRail;
      if (!rail || rail.name !== "paystack") throw new Error("payout_status requires Paystack rail");
      const response = await rail.request("GET", `/transfer/verify/${encodeURIComponent(args.transferCode)}`);
      return JSON.stringify({
        transferCode: args.transferCode,
        status: response.data?.status ?? "unknown",
        amount: response.data?.amount ? response.data.amount / 100 : null,
        recipient: response.data?.recipient?.details?.account_name,
        createdAt: response.data?.createdAt,
        updatedAt: response.data?.updatedAt,
      }, null, 2);
    }

    // ── Webhooks ────────────────────────────────────────────────────────

    case "webhook_register": {
      const id = `wh_${Date.now()}_${require("crypto").randomBytes(4).toString("hex")}`;
      _webhooks.set(id, { id, url: args.url, events: args.events, createdAt: Date.now() });
      return JSON.stringify({
        webhookId: id,
        url: args.url,
        events: args.events,
        status: "registered",
        message: "Webhook will receive POST requests when matching events occur.",
      });
    }

    case "webhook_list": {
      const hooks = Array.from(_webhooks.values()).map(w => ({
        webhookId: w.id,
        url: w.url,
        events: w.events,
        createdAt: new Date(w.createdAt).toISOString(),
      }));
      if (hooks.length === 0) return "No webhooks registered.";
      return JSON.stringify(hooks, null, 2);
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

// ── Webhook registry ───────────────────────────────────────────────────────

interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  createdAt: number;
}

const _webhooks = new Map<string, WebhookSubscription>();

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

  const allowedTools = resolveToolFilter(getToolFilterSpec(process.argv));
  const filteredTools = TOOLS.filter(t => allowedTools.has(t.name));
  console.error(`[mnemopay-mcp] Tool filter: ${filteredTools.length}/${TOOLS.length} tools exposed`);

  const server = new Server(
    { name: "mnemopay", version: "1.3.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // ── Tools ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: filteredTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      // Security: block tools outside the active filter
      if (!allowedTools.has(name)) {
        throw new Error(`Tool "${name}" is disabled — start server with --tools including this group`);
      }

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
      ...Object.entries(GUIDES).map(([slug, g]) => ({
        uri: `mnemopay://${slug}`,
        name: g.name,
        description: g.description,
        mimeType: "text/markdown",
      })),
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

    const slug = uri.replace(/^mnemopay:\/\//, "");
    if (GUIDES[slug]) {
      return { contents: [{ uri, mimeType: "text/markdown", text: GUIDES[slug].body }] };
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

    // ── Portal API Key Verification ──────────────────────────────────────
    const PORTAL_URL = process.env.PORTAL_URL || "https://getbizsuite.com";
    const REQUIRE_PORTAL_AUTH = process.env.REQUIRE_PORTAL_AUTH !== "false";

    async function portalKeyAuth(req: any, res: any, next: any) {
      if (!REQUIRE_PORTAL_AUTH) return next();
      if (req.path === "/health" || req.path.startsWith("/.well-known")) return next();

      const apiKey = req.headers["x-api-key"] || req.query.key;
      if (!apiKey) return next(); // Fall through to existing mcpAuth if no portal key

      try {
        const resp = await fetch(`${PORTAL_URL}/portal/verify-key`, {
          headers: { "x-api-key": apiKey }
        });
        const data = await resp.json() as { valid: boolean; within_limits?: boolean; error?: string };
        if (!data.valid) { res.status(403).json({ error: data.error || "Invalid API key" }); return; }
        if (!data.within_limits) { res.status(429).json({ error: "Usage limit exceeded. Upgrade at getbizsuite.com/developers/" }); return; }
        req._portalKey = { apiKey, valid: data.valid, within_limits: data.within_limits };
        next();
      } catch {
        if (process.env.NODE_ENV === "production") {
          res.status(503).json({ error: "Auth service unavailable" });
          return;
        }
        next();
      }
    }

    app.use(portalKeyAuth);

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

    // Smithery MCP Server Card — enables registry discovery without scanning
    app.get("/.well-known/mcp/server-card.json", (_req, res) => {
      res.json({
        serverInfo: { name: "MnemoPay", version: "1.2.0" },
        authentication: { required: false },
        tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        resources: [],
        prompts: [],
      });
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

    // ── Streamable HTTP transport (modern MCP, used by Smithery) ────────
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const streamTransports: Record<string, InstanceType<typeof StreamableHTTPServerTransport>> = {};

    app.post("/mcp", mcpAuth, async (req: any, res: any) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && streamTransports[sessionId]) {
        // Existing session — forward message
        await streamTransports[sessionId].handleRequest(req, res, req.body);
        return;
      }
      // New session
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      const sid = (transport as any).sessionId || crypto.randomUUID();
      streamTransports[sid] = transport;
      transport.onclose = async () => {
        delete streamTransports[sid];
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      console.error(`[mnemopay-mcp] Streamable HTTP session: ${sid}`);
    });

    app.get("/mcp", mcpAuth, async (req: any, res: any) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && streamTransports[sessionId]) {
        await streamTransports[sessionId].handleRequest(req, res);
        return;
      }
      // Legacy SSE fallback
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

    app.delete("/mcp", mcpAuth, async (req: any, res: any) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && streamTransports[sessionId]) {
        await streamTransports[sessionId].handleRequest(req, res);
        delete streamTransports[sessionId];
        return;
      }
      res.status(404).json({ error: "Session not found" });
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
      const start = Date.now();
      try {
        const result = await executeTool(agent, toolName, req.body ?? {});
        // Log usage to portal
        if (req._portalKey?.apiKey) {
          fetch(`${PORTAL_URL}/portal/log-usage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: req._portalKey.apiKey, product: "mnemopay", tool: toolName, response_ms: Date.now() - start }),
          }).catch(() => {});
        }
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

  // Sandbox honors MNEMOPAY_TOOLS but defaults to "all" so Smithery
  // can scan the full surface during indexing.
  const allowedTools = resolveToolFilter(process.env.MNEMOPAY_TOOLS ?? "all");
  const filteredTools = TOOLS.filter(t => allowedTools.has(t.name));

  const server = new Server(
    { name: "mnemopay", version: "1.3.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: filteredTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!allowedTools.has(name)) {
      return { content: [{ type: "text", text: `Error: Tool "${name}" is disabled` }], isError: true };
    }
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
