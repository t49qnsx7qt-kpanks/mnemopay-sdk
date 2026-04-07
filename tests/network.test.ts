import { describe, it, expect, beforeEach } from "vitest";
import { MnemoPayNetwork } from "../src/network.js";

describe("MnemoPayNetwork — Multi-Agent Transactions", () => {
  let net: MnemoPayNetwork;

  beforeEach(() => {
    net = new MnemoPayNetwork({ fraud: { platformFeeRate: 0.019, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
  });

  // ── Registration ──────────────────────────────────────────────────────

  describe("register()", () => {
    it("registers an agent and returns MnemoPayLite instance", () => {
      const agent = net.register("bot-1", "owner-1", "dev@co.com");
      expect(agent).toBeDefined();
      expect(agent.agentId).toBe("bot-1");
    });

    it("returns existing instance for duplicate registration", () => {
      const a1 = net.register("bot-1", "owner-1", "dev@co.com");
      const a2 = net.register("bot-1", "owner-1", "dev@co.com");
      expect(a1).toBe(a2);
    });

    it("auto-verifies KYC in default mode", () => {
      net.register("bot-1", "owner-1", "dev@co.com");
      const identity = net.identity.getIdentity("bot-1");
      expect(identity!.verified).toBe(true);
      expect(identity!.kya.financialAuthorized).toBe(true);
    });

    it("tracks registered agents", () => {
      net.register("a", "o", "e@e.com");
      net.register("b", "o", "e@e.com");
      net.register("c", "o", "e@e.com");
      expect(net.listAgents()).toEqual(["a", "b", "c"]);
    });

    it("getAgent returns instance or null", () => {
      net.register("bot-1", "o", "e@e.com");
      expect(net.getAgent("bot-1")).not.toBeNull();
      expect(net.getAgent("ghost")).toBeNull();
    });

    it("supports custom permissions and spend limits", () => {
      net.register("limited", "o", "e@e.com", {
        permissions: ["charge"],
        maxAmount: 50,
        maxTotalSpend: 200,
      });
      const identity = net.identity.getIdentity("limited");
      expect(identity).not.toBeNull();
    });
  });

  // ── Transactions ──────────────────────────────────────────────────────

  describe("transact()", () => {
    beforeEach(() => {
      net.register("buyer", "owner-1", "buyer@co.com", { displayName: "Buyer Bot" });
      net.register("seller", "owner-2", "seller@co.com", { displayName: "Seller Bot" });
    });

    it("executes a buyer→seller deal", async () => {
      const deal = await net.transact("buyer", "seller", 100, "API access");

      expect(deal.dealId).toBeDefined();
      expect(deal.charge.amount).toBe(100);
      expect(deal.settlement).toBeDefined();
      expect(deal.settlement!.status).toBe("completed");
      expect(deal.platformFee).toBe(1.9);
      expect(deal.netAmount).toBe(98.1);
      expect(deal.buyerMemoryId).toBeDefined();
      expect(deal.sellerMemoryId).toBeDefined();
    });

    it("both agents remember the deal", async () => {
      await net.transact("buyer", "seller", 50, "Data scraping service");

      const buyerMems = await net.getAgent("buyer")!.recall("paid", 5);
      const sellerMems = await net.getAgent("seller")!.recall("received", 5);

      expect(buyerMems.length).toBeGreaterThan(0);
      expect(buyerMems[0].content).toContain("Paid $50");
      expect(buyerMems[0].content).toContain("Seller Bot");
      expect(buyerMems[0].tags).toContain("payment:sent");

      expect(sellerMems.length).toBeGreaterThan(0);
      expect(sellerMems[0].content).toContain("Received");
      expect(sellerMems[0].content).toContain("Buyer Bot");
      expect(sellerMems[0].tags).toContain("payment:received");
    });

    it("supports custom context per side", async () => {
      const deal = await net.transact("buyer", "seller", 25, "Image generation", {
        buyerContext: "Used DALL-E 3 model, 1024x1024",
        sellerContext: "Delivered 10 images in 3.2 seconds",
        tags: ["ai-service", "images"],
      });

      const buyerMems = await net.getAgent("buyer")!.recall("DALL-E", 5);
      expect(buyerMems[0].content).toContain("DALL-E 3");

      const sellerMems = await net.getAgent("seller")!.recall("delivered", 5);
      expect(sellerMems[0].content).toContain("10 images");
    });

    it("rejects self-dealing", async () => {
      await expect(net.transact("buyer", "buyer", 10, "Self-deal"))
        .rejects.toThrow("same agent");
    });

    it("rejects unregistered agents", async () => {
      await expect(net.transact("ghost", "seller", 10, "Bad"))
        .rejects.toThrow("not registered");
      await expect(net.transact("buyer", "ghost", 10, "Bad"))
        .rejects.toThrow("not registered");
    });

    it("handles multiple sequential deals", async () => {
      await net.transact("buyer", "seller", 10, "Service 1");
      await net.transact("buyer", "seller", 20, "Service 2");
      await net.transact("buyer", "seller", 30, "Service 3");

      const stats = net.stats();
      expect(stats.dealCount).toBe(3);
      expect(stats.totalVolume).toBe(60);
    });

    it("enforces token spend limits", async () => {
      // Register with strict limits
      const strictNet = new MnemoPayNetwork({ fraud: { platformFeeRate: 0, settlementHoldMinutes: 0, disputeWindowMinutes: 0 } });
      strictNet.register("limited-buyer", "o", "e@e.com", {
        permissions: ["charge", "settle", "remember", "recall"],
        maxAmount: 50,
        maxTotalSpend: 100,
      });
      strictNet.register("payee", "o", "e@e.com");

      // First deal OK
      await strictNet.transact("limited-buyer", "payee", 40, "Under limit");

      // Second deal OK (total = 80 < 100)
      await strictNet.transact("limited-buyer", "payee", 40, "Still under");

      // Third deal exceeds total spend limit
      await expect(strictNet.transact("limited-buyer", "payee", 40, "Over limit"))
        .rejects.toThrow(/exceed|validation failed/i);
    });
  });

  // ── Refunds ───────────────────────────────────────────────────────────

  describe("refundDeal()", () => {
    it("refunds a deal and both agents remember", async () => {
      net.register("buyer", "o1", "b@e.com", { displayName: "Buyer" });
      net.register("seller", "o2", "s@e.com", { displayName: "Seller" });

      const deal = await net.transact("buyer", "seller", 100, "Will refund");
      await net.refundDeal(deal.dealId);

      const buyerMems = await net.getAgent("buyer")!.recall("refund", 5);
      expect(buyerMems.some(m => m.content.includes("Refund"))).toBe(true);

      const sellerMems = await net.getAgent("seller")!.recall("refund", 5);
      expect(sellerMems.some(m => m.content.includes("Refund"))).toBe(true);
    });

    it("rejects refund for unknown deal", async () => {
      await expect(net.refundDeal("nonexistent")).rejects.toThrow("not found");
    });
  });

  // ── Queries ───────────────────────────────────────────────────────────

  describe("queries", () => {
    beforeEach(async () => {
      net.register("alice", "o", "e@e.com");
      net.register("bob", "o", "e@e.com");
      net.register("charlie", "o", "e@e.com");

      await net.transact("alice", "bob", 10, "Deal 1");
      await net.transact("alice", "charlie", 20, "Deal 2");
      await net.transact("bob", "charlie", 30, "Deal 3");
    });

    it("dealsBetween returns deals between specific agents", () => {
      const ab = net.dealsBetween("alice", "bob");
      expect(ab).toHaveLength(1);
      expect(ab[0].charge.amount).toBe(10);

      const ac = net.dealsBetween("alice", "charlie");
      expect(ac).toHaveLength(1);

      const bc = net.dealsBetween("bob", "charlie");
      expect(bc).toHaveLength(1);
    });

    it("agentDeals returns all deals for an agent", () => {
      const aliceDeals = net.agentDeals("alice");
      expect(aliceDeals).toHaveLength(2); // alice bought from bob and charlie

      const charlieDeals = net.agentDeals("charlie");
      expect(charlieDeals).toHaveLength(2); // charlie sold to alice and bob
    });

    it("stats returns network-wide metrics", () => {
      const stats = net.stats();
      expect(stats.agentCount).toBe(3);
      expect(stats.dealCount).toBe(3);
      expect(stats.totalVolume).toBe(60);
      expect(stats.totalFees).toBeGreaterThan(0);
      expect(stats.activeAgents).toBe(3);
    });
  });

  // ── Multi-Agent Scenarios ─────────────────────────────────────────────

  describe("real-world scenarios", () => {
    it("marketplace: multiple buyers, one seller", async () => {
      net.register("shop", "merchant", "shop@e.com", { displayName: "AI Shop" });
      net.register("buyer-1", "user-1", "u1@e.com");
      net.register("buyer-2", "user-2", "u2@e.com");
      net.register("buyer-3", "user-3", "u3@e.com");

      await net.transact("buyer-1", "shop", 15, "Widget A");
      await net.transact("buyer-2", "shop", 25, "Widget B");
      await net.transact("buyer-3", "shop", 35, "Widget C");

      const shopDeals = net.agentDeals("shop");
      expect(shopDeals).toHaveLength(3);

      // Shop remembers all customers
      const shopMems = await net.getAgent("shop")!.recall("received", 10);
      expect(shopMems.length).toBe(3);
    });

    it("supply chain: A pays B, B pays C", async () => {
      net.register("manufacturer", "m", "m@e.com", { displayName: "Manufacturer" });
      net.register("distributor", "d", "d@e.com", { displayName: "Distributor" });
      net.register("retailer", "r", "r@e.com", { displayName: "Retailer" });

      // Retailer pays distributor
      await net.transact("retailer", "distributor", 100, "Wholesale order");
      // Distributor pays manufacturer
      await net.transact("distributor", "manufacturer", 60, "Parts order");

      const stats = net.stats();
      expect(stats.dealCount).toBe(2);
      expect(stats.totalVolume).toBe(160);

      // Distributor remembers both sides of the chain
      const distMems = await net.getAgent("distributor")!.recall(5);
      expect(distMems.length).toBe(2); // one payment received, one payment sent
    });

    it("handles 50 agents with cross-transactions", async () => {
      // Register 50 agents
      for (let i = 0; i < 50; i++) {
        net.register(`agent-${i}`, "owner", "o@e.com");
      }

      // Each agent transacts with the next
      for (let i = 0; i < 49; i++) {
        await net.transact(`agent-${i}`, `agent-${i + 1}`, 1, `Transfer ${i}`);
      }

      const stats = net.stats();
      expect(stats.agentCount).toBe(50);
      expect(stats.dealCount).toBe(49);
      expect(stats.totalVolume).toBe(49);
    });
  });

  // ── Shutdown ──────────────────────────────────────────────────────────

  describe("shutdown()", () => {
    it("disconnects all agents cleanly", async () => {
      net.register("a", "o", "e@e.com");
      net.register("b", "o", "e@e.com");
      await net.transact("a", "b", 10, "Before shutdown");
      await expect(net.shutdown()).resolves.not.toThrow();
    });
  });
});
