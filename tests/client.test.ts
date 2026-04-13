import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MnemoPayClient } from "../src/client.js";
import MnemoPay from "../src/index.js";

/**
 * Client + REST API integration tests.
 *
 * Spins up a real Express server with the REST API,
 * then tests the MnemoPayClient against it.
 */

const PORT = 9876;
const TOKEN = "test-secret-token";
const BASE_URL = `http://localhost:${PORT}`;

let server: any;

beforeAll(async () => {
  // Set env vars before importing server
  process.env.PORT = String(PORT);
  process.env.MNEMOPAY_MCP_TOKEN = TOKEN;
  process.env.MNEMOPAY_MODE = "quick";
  process.env.MNEMOPAY_AGENT_ID = "client-test-agent";

  // Build a minimal Express server with the REST API routes
  const express = (await import("express")).default;
  const { RateLimiter } = await import("../src/fraud.js");
  const { CommerceEngine } = await import("../src/commerce.js");

  const agent = MnemoPay.quick("client-test-agent", {
    fraud: {
      blockThreshold: 1.0,
      flagThreshold: 1.0,
      maxChargesPerMinute: 100000,
      maxChargesPerHour: 1000000,
      maxChargesPerDay: 10000000,
      maxDailyVolume: 100000000,
      settlementHoldMinutes: 0,
      disputeWindowMinutes: 0,
    },
  });

  // Import executeTool equivalent
  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
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
        const memories = args.query ? await agent.recall(args.query, limit) : await agent.recall(limit);
        if (memories.length === 0) return "No memories found.";
        return memories.map((m: any, i: number) => `${i + 1}. [score:${m.score.toFixed(2)}] ${m.content}`).join("\n");
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
        return JSON.stringify({ txId: tx.id, amount: tx.amount, status: tx.status });
      }
      case "settle": {
        const tx = await agent.settle(args.txId, args.counterpartyId);
        return JSON.stringify({ txId: tx.id, amount: tx.amount, status: tx.status });
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
        return entries.map((e: any) => `[${e.createdAt.toISOString()}] ${e.action}`).join("\n");
      }
      case "history": {
        const txns = await agent.history(args.limit ?? 10);
        if (txns.length === 0) return "No transactions yet.";
        return txns.map((t: any) => `$${t.amount.toFixed(2)} — ${t.status}`).join("\n");
      }
      case "reputation": {
        const rep = await agent.reputation();
        return JSON.stringify(rep, null, 2);
      }
      case "dispute": {
        const d = await (agent as any).dispute(args.txId, args.reason);
        return JSON.stringify({ disputeId: d.id, txId: d.txId, status: d.status });
      }
      case "fraud_stats": {
        const stats = (agent as any).fraud.stats();
        return JSON.stringify(stats, null, 2);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  const VALID_TOOLS = [
    "remember", "recall", "forget", "reinforce", "consolidate",
    "charge", "settle", "refund", "balance", "profile",
    "logs", "history", "reputation", "dispute", "fraud_stats",
  ];

  const app = express();
  app.use(express.json());

  // Auth middleware
  function mcpAuth(req: any, res: any, next: any) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${TOKEN}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // CORS
  app.use("/api", (req: any, res: any, next: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", mode: "quick" });
  });

  app.get("/api/tools", mcpAuth, (_req: any, res: any) => {
    res.json({ tools: VALID_TOOLS.map(t => ({ name: t, description: t })), version: "0.9.0" });
  });

  app.post("/api/:tool", mcpAuth, async (req: any, res: any) => {
    const toolName = req.params.tool;
    if (!VALID_TOOLS.includes(toolName)) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }
    try {
      const result = await executeTool(toolName, req.body ?? {});
      try {
        res.json({ ok: true, tool: toolName, result: JSON.parse(result) });
      } catch {
        res.json({ ok: true, tool: toolName, result });
      }
    } catch (err: any) {
      res.status(400).json({ ok: false, tool: toolName, error: err.message });
    }
  });

  // Commerce
  let commerceEngine: CommerceEngine | null = null;
  function getCommerce() {
    if (!commerceEngine) commerceEngine = new CommerceEngine(agent);
    return commerceEngine;
  }

  app.post("/api/commerce/mandate", mcpAuth, async (req: any, res: any) => {
    try {
      const c = getCommerce();
      c.setMandate(req.body);
      res.json({ ok: true, mandate: c.getMandate(), remainingBudget: c.remainingBudget });
    } catch (err: any) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/commerce/search", mcpAuth, async (req: any, res: any) => {
    try {
      const c = getCommerce();
      const results = await c.search(req.body.query, req.body.options);
      res.json({ ok: true, results, remainingBudget: c.remainingBudget });
    } catch (err: any) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/commerce/purchase", mcpAuth, async (req: any, res: any) => {
    try {
      const c = getCommerce();
      const order = await c.purchase(req.body.product, req.body.deliveryInstructions);
      res.json({ ok: true, order });
    } catch (err: any) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/commerce/confirm", mcpAuth, async (req: any, res: any) => {
    try {
      const c = getCommerce();
      const order = await c.confirmDelivery(req.body.orderId);
      res.json({ ok: true, order });
    } catch (err: any) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/commerce/cancel", mcpAuth, async (req: any, res: any) => {
    try {
      const c = getCommerce();
      const order = await c.cancelOrder(req.body.orderId, req.body.reason);
      res.json({ ok: true, order });
    } catch (err: any) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.get("/api/commerce/orders", mcpAuth, async (req: any, res: any) => {
    try {
      const c = getCommerce();
      const orders = c.listOrders(req.query.status as string | undefined);
      res.json({ ok: true, orders, summary: c.spendingSummary() });
    } catch (err: any) { res.status(400).json({ ok: false, error: err.message }); }
  });

  server = app.listen(PORT);
  // Give server time to bind
  await new Promise(resolve => setTimeout(resolve, 200));
}, 30_000);

afterAll(() => {
  if (server) server.close();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("MnemoPayClient — REST API Integration", () => {
  // ── Auth ──────────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("rejects requests without token", async () => {
      const noAuth = new MnemoPayClient(BASE_URL);
      await expect(noAuth.remember("test")).rejects.toThrow();
    });

    it("rejects requests with wrong token", async () => {
      const badAuth = new MnemoPayClient(BASE_URL, "wrong-token");
      await expect(badAuth.remember("test")).rejects.toThrow();
    });

    it("accepts requests with correct token", async () => {
      const client = new MnemoPayClient(BASE_URL, TOKEN);
      const result = await client.remember("Auth test memory");
      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
    });
  });

  // ── Health ─────────────────────────────────────────────────────────────

  describe("health()", () => {
    it("returns server status", async () => {
      const client = new MnemoPayClient(BASE_URL, TOKEN);
      const health = await client.health();
      expect(health.status).toBe("ok");
      expect(health.mode).toBe("quick");
    });
  });

  // ── Tools Discovery ────────────────────────────────────────────────────

  describe("tools()", () => {
    it("lists available tools", async () => {
      const client = new MnemoPayClient(BASE_URL, TOKEN);
      const result = await client.tools();
      expect(result.tools.length).toBeGreaterThanOrEqual(15);
      expect(result.version).toBe("0.9.0");
    });
  });

  // ── Memory ─────────────────────────────────────────────────────────────

  describe("memory operations", () => {
    const client = new MnemoPayClient(BASE_URL, TOKEN);

    it("remember + recall round-trip", async () => {
      const mem = await client.remember("Client test: user prefers dark mode");
      expect(mem.id).toBeTruthy();
      expect(mem.status).toBe("stored");

      const recalled = await client.recall("dark mode");
      expect(recalled).toContain("dark mode");
    });

    it("remember with tags and importance", async () => {
      const mem = await client.remember("High priority: server upgrade needed", {
        importance: 0.9,
        tags: ["ops", "urgent"],
      });
      expect(mem.id).toBeTruthy();
    });

    it("recall with limit", async () => {
      const recalled = await client.recall(2);
      expect(typeof recalled).toBe("string");
    });

    it("consolidate prunes stale memories", async () => {
      const result = await client.consolidate();
      expect(result).toContain("pruned");
    });
  });

  // ── Payments ───────────────────────────────────────────────────────────

  describe("payment operations", () => {
    const client = new MnemoPayClient(BASE_URL, TOKEN);

    it("charge → settle flow", async () => {
      const tx = await client.charge(10, "REST API test charge");
      expect(tx.txId).toBeTruthy();
      expect(tx.amount).toBe(10);
      expect(tx.status).toBe("pending");

      const settled = await client.settle(tx.txId);
      expect(settled.status).toBe("completed");
    });

    it("charge → refund flow", async () => {
      const tx = await client.charge(5, "Refund test");
      const refunded = await client.refund(tx.txId);
      expect(refunded.status).toBe("refunded");
    });

    it("balance returns wallet info", async () => {
      const bal = await client.balance();
      expect(typeof bal).toBe("string");
      expect(bal).toContain("Wallet:");
    });

    it("profile returns agent stats", async () => {
      const profile = await client.profile();
      expect(profile.id).toBe("client-test-agent");
      expect(typeof profile.reputation).toBe("number");
    });

    it("history returns transactions", async () => {
      const hist = await client.history(5);
      expect(typeof hist).toBe("string");
    });

    it("reputation returns full report", async () => {
      const rep = await client.reputation();
      expect(rep.agentId).toBe("client-test-agent");
      expect(rep.tier).toBeDefined();
    });

    it("logs returns audit trail", async () => {
      const logs = await client.logs(5);
      expect(typeof logs).toBe("string");
    });

    it("fraud_stats returns detection metrics", async () => {
      const stats = await client.fraudStats();
      expect(stats).toBeDefined();
    });
  });

  // ── Commerce ───────────────────────────────────────────────────────────

  describe("commerce operations", () => {
    const client = new MnemoPayClient(BASE_URL, TOKEN);

    it("set mandate → search → purchase → confirm delivery", async () => {
      // Set mandate
      const mandateResult = await client.setMandate({
        budget: 200,
        categories: ["electronics"],
        issuedBy: "test-user",
      });
      expect(mandateResult.mandate.budget).toBe(200);
      expect(mandateResult.remainingBudget).toBe(200);

      // Search
      const searchResult = await client.search("cable");
      expect(searchResult.results.length).toBeGreaterThan(0);
      expect(searchResult.remainingBudget).toBe(200);

      // Purchase
      const product = searchResult.results[0];
      const purchaseResult = await client.purchase(product, "Ship to office");
      expect(purchaseResult.order.status).toBe("purchased");
      expect(purchaseResult.order.txId).toBeTruthy();

      // Confirm delivery
      const confirmed = await client.confirmDelivery(purchaseResult.order.id);
      expect(confirmed.order.status).toBe("delivered");
    });

    it("list orders with summary", async () => {
      const result = await client.orders();
      expect(result.orders.length).toBeGreaterThanOrEqual(1);
      expect(result.summary.orderCount).toBeGreaterThanOrEqual(1);
    });

    it("cancel order refunds escrow", async () => {
      // New purchase
      const searchResult = await client.search("mouse");
      if (searchResult.results.length > 0) {
        const purchaseResult = await client.purchase(searchResult.results[0]);
        if (purchaseResult.order.status === "purchased") {
          const cancelled = await client.cancelOrder(purchaseResult.order.id, "Changed mind");
          expect(cancelled.order.status).toBe("cancelled");
        }
      }
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    const client = new MnemoPayClient(BASE_URL, TOKEN);

    it("rejects unknown tool", async () => {
      await expect(
        (client as any).post("/api/nonexistent", {})
      ).rejects.toThrow();
    });

    it("rejects charge with invalid amount", async () => {
      await expect(client.charge(-1, "bad")).rejects.toThrow();
    });

    it("rejects settle with invalid txId", async () => {
      await expect(client.settle("fake-tx-id")).rejects.toThrow();
    });

    it("handles connection errors gracefully", async () => {
      const badClient = new MnemoPayClient("http://localhost:1", TOKEN, { timeoutMs: 1000 });
      await expect(badClient.health()).rejects.toThrow();
    });
  });
});
