import { describe, it, expect, beforeEach } from "vitest";
import { MnemoPay } from "../src/index.js";
import {
  CommerceEngine,
  MockCommerceProvider,
  type ShoppingMandate,
  type PurchaseOrder,
} from "../src/commerce.js";

const NO_FRAUD = {
  maxChargeAmount: 500,
  velocityWindow: 60_000,
  velocityMaxCharges: 1000,
  reputationThreshold: 0,
  riskScoreThreshold: 1.0,
  settlementHoldMinutes: 0,
  disputeWindowMinutes: 0,
};

function createAgent(id = "shopper-agent") {
  return MnemoPay.quick(id, { fraud: NO_FRAUD });
}

describe("CommerceEngine — Autonomous Shopping", () => {
  let agent: ReturnType<typeof createAgent>;
  let commerce: CommerceEngine;

  beforeEach(() => {
    agent = createAgent();
    commerce = new CommerceEngine(agent);
    commerce.setMandate({
      budget: 200,
      categories: ["electronics"],
      issuedBy: "test-user",
    });
  });

  // ── Mandate Management ──────────────────────────────────────────────────

  describe("setMandate()", () => {
    it("sets a valid mandate", () => {
      const mandate = commerce.getMandate();
      expect(mandate).not.toBeNull();
      expect(mandate!.budget).toBe(200);
      expect(mandate!.categories).toEqual(["electronics"]);
      expect(mandate!.issuedBy).toBe("test-user");
      expect(mandate!.maxPerItem).toBe(200); // defaults to budget
    });

    it("rejects zero budget", () => {
      expect(() => commerce.setMandate({ budget: 0, issuedBy: "u" }))
        .toThrow("budget must be positive");
    });

    it("rejects negative budget", () => {
      expect(() => commerce.setMandate({ budget: -50, issuedBy: "u" }))
        .toThrow("budget must be positive");
    });

    it("rejects missing issuer", () => {
      expect(() => commerce.setMandate({ budget: 100, issuedBy: "" }))
        .toThrow("must have an issuer");
    });

    it("sets custom per-item limit", () => {
      commerce.setMandate({ budget: 500, maxPerItem: 50, issuedBy: "u" });
      expect(commerce.getMandate()!.maxPerItem).toBe(50);
    });

    it("tracks remaining budget", () => {
      expect(commerce.remainingBudget).toBe(200);
    });
  });

  // ── Product Search ──────────────────────────────────────────────────────

  describe("search()", () => {
    it("returns products matching query", async () => {
      const results = await commerce.search("cable");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title.toLowerCase()).toContain("cable");
    });

    it("filters by mandate category", async () => {
      const results = await commerce.search("laptop");
      // Mock catalog has "Laptop Stand" in "office" category,
      // but mandate only allows "electronics" — it should be filtered out
      for (const r of results) {
        if (r.category) {
          expect(r.category).toBe("electronics");
        }
      }
    });

    it("respects maxPrice from mandate", async () => {
      commerce.setMandate({ budget: 15, issuedBy: "u" });
      const results = await commerce.search("electronics");
      for (const r of results) {
        expect(r.price).toBeLessThanOrEqual(15);
      }
    });

    it("throws without mandate", async () => {
      const bare = new CommerceEngine(agent);
      await expect(bare.search("cable")).rejects.toThrow("No shopping mandate");
    });

    it("throws on expired mandate", async () => {
      commerce.setMandate({
        budget: 200,
        issuedBy: "u",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      await expect(commerce.search("cable")).rejects.toThrow("expired");
    });
  });

  // ── Purchase Flow ───────────────────────────────────────────────────────

  describe("purchase()", () => {
    it("creates an escrowed purchase order", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);

      expect(order.status).toBe("purchased");
      expect(order.txId).toBeTruthy();
      expect(order.product.title).toContain("Cable");
      expect(order.approved).toBe(true);
      expect(order.mandate.budget).toBe(200);
    });

    it("deducts from remaining budget", async () => {
      const results = await commerce.search("cable");
      const price = results[0].price;
      await commerce.purchase(results[0]);
      expect(commerce.remainingBudget).toBeCloseTo(200 - price, 2);
    });

    it("blocks purchase exceeding remaining budget", async () => {
      commerce.setMandate({ budget: 5, issuedBy: "u" });
      const results = await commerce.search("electronics");
      const expensive = results.find(r => r.price > 5);
      if (expensive) {
        await expect(commerce.purchase(expensive)).rejects.toThrow("Insufficient mandate budget");
      }
    });

    it("blocks purchase in wrong category", async () => {
      const provider = new MockCommerceProvider();
      const officeProduct = await provider.getProduct("mock-003"); // "office" category
      expect(officeProduct).not.toBeNull();
      await expect(commerce.purchase(officeProduct!)).rejects.toThrow("Mandate violation");
    });

    it("blocks blocked merchant", async () => {
      commerce.setMandate({
        budget: 200,
        blockedMerchants: ["techstore.com"],
        issuedBy: "u",
      });
      const provider = new MockCommerceProvider();
      const product = await provider.getProduct("mock-001"); // TechStore
      await expect(commerce.purchase(product!)).rejects.toThrow("Mandate violation");
    });

    it("stores purchase memory", async () => {
      const results = await commerce.search("cable");
      await commerce.purchase(results[0]);

      const memories = await agent.recall("purchased", 5);
      const purchaseMemory = memories.find((m: any) => m.content.includes("Purchased"));
      expect(purchaseMemory).toBeDefined();
    });

    it("records audit trail", async () => {
      const results = await commerce.search("cable");
      await commerce.purchase(results[0]);

      const logs = await agent.logs(10);
      const commerceLogs = logs.filter((l: any) => l.action.startsWith("commerce:"));
      expect(commerceLogs.length).toBeGreaterThanOrEqual(2); // mandate:set + purchase:escrowed + purchase:executed
    });
  });

  // ── Approval Flow ───────────────────────────────────────────────────────

  describe("approval flow", () => {
    it("auto-approves under threshold", async () => {
      commerce.setMandate({
        budget: 200,
        approvalThreshold: 50,
        issuedBy: "u",
      });
      let callbackCalled = false;
      commerce.onApprovalRequired(async () => { callbackCalled = true; return true; });

      const results = await commerce.search("cable");
      const cheap = results.find(r => r.price < 50);
      if (cheap) {
        const order = await commerce.purchase(cheap);
        expect(order.status).toBe("purchased");
        expect(callbackCalled).toBe(false);
      }
    });

    it("requests approval above threshold", async () => {
      commerce.setMandate({
        budget: 500,
        approvalThreshold: 50,
        issuedBy: "u",
      });
      let approvalRequested = false;
      commerce.onApprovalRequired(async (order) => {
        approvalRequested = true;
        expect(order.product.price).toBeGreaterThanOrEqual(50);
        return true;
      });

      const results = await commerce.search("electronics");
      const expensive = results.find(r => r.price >= 50);
      if (expensive) {
        const order = await commerce.purchase(expensive);
        expect(approvalRequested).toBe(true);
        expect(order.status).toBe("purchased");
      }
    });

    it("cancels order when approval denied", async () => {
      commerce.setMandate({
        budget: 500,
        approvalThreshold: 1, // $1 threshold — forces approval on any product
        issuedBy: "u",
      });
      commerce.onApprovalRequired(async () => false); // Always deny

      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);
      expect(order.status).toBe("cancelled");
      expect(order.failureReason).toContain("declined");
    });
  });

  // ── Delivery Confirmation ───────────────────────────────────────────────

  describe("confirmDelivery()", () => {
    it("settles escrow on delivery confirmation", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);
      expect(order.status).toBe("purchased");

      const confirmed = await commerce.confirmDelivery(order.id);
      expect(confirmed.status).toBe("delivered");

      // Wallet should have the net amount
      const balance = await agent.balance();
      expect(balance.wallet).toBeGreaterThan(0);
    });

    it("rejects double delivery confirmation", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);
      await commerce.confirmDelivery(order.id);

      await expect(commerce.confirmDelivery(order.id)).rejects.toThrow("already delivered");
    });

    it("rejects confirmation on cancelled order", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);
      await commerce.cancelOrder(order.id);

      await expect(commerce.confirmDelivery(order.id)).rejects.toThrow("cancelled");
    });
  });

  // ── Order Cancellation ──────────────────────────────────────────────────

  describe("cancelOrder()", () => {
    it("refunds escrow on cancellation", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);

      const cancelled = await commerce.cancelOrder(order.id, "Changed my mind");
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.failureReason).toBe("Changed my mind");
    });

    it("restores budget on cancellation", async () => {
      const results = await commerce.search("cable");
      const price = results[0].price;
      await commerce.purchase(results[0]);
      const budgetAfterPurchase = commerce.remainingBudget;

      const order = commerce.listOrders()[0];
      await commerce.cancelOrder(order.id);
      expect(commerce.remainingBudget).toBeCloseTo(budgetAfterPurchase + price, 2);
    });

    it("rejects cancellation of delivered order", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);
      await commerce.confirmDelivery(order.id);

      await expect(commerce.cancelOrder(order.id)).rejects.toThrow("delivered");
    });
  });

  // ── Delivery Status Check ───────────────────────────────────────────────

  describe("checkDeliveryStatus()", () => {
    it("updates tracking info from provider", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);

      const updated = await commerce.checkDeliveryStatus(order.id);
      expect(updated.trackingNumber).toBeDefined();
      expect(updated.trackingUrl).toBeDefined();
    });
  });

  // ── Order Management ────────────────────────────────────────────────────

  describe("order management", () => {
    it("lists all orders", async () => {
      const results = await commerce.search("electronics");
      await commerce.purchase(results[0]);
      if (results[1]) await commerce.purchase(results[1]);

      const orders = commerce.listOrders();
      expect(orders.length).toBeGreaterThanOrEqual(1);
    });

    it("filters orders by status", async () => {
      const results = await commerce.search("cable");
      const order = await commerce.purchase(results[0]);
      await commerce.confirmDelivery(order.id);

      expect(commerce.listOrders("delivered")).toHaveLength(1);
      expect(commerce.listOrders("cancelled")).toHaveLength(0);
    });

    it("returns spending summary", async () => {
      const results = await commerce.search("cable");
      await commerce.purchase(results[0]);

      const summary = commerce.spendingSummary();
      expect(summary.totalSpent).toBeGreaterThan(0);
      expect(summary.orderCount).toBe(1);
      expect(summary.pendingCount).toBe(1);
    });

    it("getOrder returns null for unknown ID", () => {
      expect(commerce.getOrder("nonexistent")).toBeNull();
    });
  });

  // ── Security: Mandate Enforcement ───────────────────────────────────────

  describe("mandate enforcement", () => {
    it("blocks purchase after budget exhausted", async () => {
      commerce.setMandate({ budget: 12, issuedBy: "u" });
      const results = await commerce.search("cable");
      const cheap = results.find(r => r.price <= 12);
      if (cheap) {
        await commerce.purchase(cheap);
        // Budget should be exhausted or near-exhausted
        const remaining = commerce.remainingBudget;
        if (remaining < 1) {
          await expect(
            commerce.purchase({ ...cheap, price: remaining + 1 })
          ).rejects.toThrow("Insufficient mandate budget");
        }
      }
    });

    it("enforces per-item limit separately from budget", async () => {
      commerce.setMandate({
        budget: 500,
        maxPerItem: 30,
        issuedBy: "u",
      });

      const provider = new MockCommerceProvider();
      const expensive = await provider.getProduct("mock-004"); // $79.99
      await expect(commerce.purchase(expensive!)).rejects.toThrow("Mandate violation");
    });

    it("enforces merchant whitelist", async () => {
      commerce.setMandate({
        budget: 500,
        allowedMerchants: ["audioworld.com"],
        issuedBy: "u",
      });

      const provider = new MockCommerceProvider();
      const wrongMerchant = await provider.getProduct("mock-001"); // techstore.com
      await expect(commerce.purchase(wrongMerchant!)).rejects.toThrow("Mandate violation");
    });

    it("full end-to-end: search → purchase → deliver", async () => {
      commerce.setMandate({
        budget: 300,
        categories: ["electronics"],
        approvalThreshold: 100,
        issuedBy: "test-user",
      });
      let approved = false;
      commerce.onApprovalRequired(async () => { approved = true; return true; });

      // Search
      const results = await commerce.search("headphones");
      expect(results.length).toBeGreaterThan(0);

      // Purchase (should trigger approval for $199.99)
      const order = await commerce.purchase(results[0], "Ship to 123 Main St");

      if (order.product.price >= 100) {
        expect(approved).toBe(true);
      }
      expect(order.status).toBe("purchased");

      // Check status
      const statusUpdate = await commerce.checkDeliveryStatus(order.id);
      expect(statusUpdate.trackingUrl).toBeDefined();

      // Confirm delivery
      const delivered = await commerce.confirmDelivery(order.id);
      expect(delivered.status).toBe("delivered");

      // Verify financials
      const balance = await agent.balance();
      expect(balance.wallet).toBeGreaterThan(0);

      // Verify memory recorded
      const memories = await agent.recall("purchased headphones", 5);
      expect(memories.length).toBeGreaterThan(0);

      // Verify audit trail
      const logs = await agent.logs(20);
      const commerceLogs = logs.filter((l: any) => l.action.startsWith("commerce:"));
      expect(commerceLogs.length).toBeGreaterThanOrEqual(3);
    });
  });
});
