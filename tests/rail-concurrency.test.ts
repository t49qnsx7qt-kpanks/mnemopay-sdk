/**
 * Payment Rail Concurrency & Idempotency — Test Suite
 * 
 * Verifies:
 * 1. Double-capture protection
 * 2. Idempotency on retries
 * 3. Race conditions in in-flight requests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StripeRail, PaystackRail } from "../src/rails/index.js";

describe("Payment Rail Concurrency", () => {
  
  describe("StripeRail", () => {
    let mockStripe: any;
    let rail: StripeRail;

    beforeEach(() => {
      mockStripe = {
        paymentIntents: {
          create: vi.fn().mockResolvedValue({ id: "pi_123", status: "requires_capture" }),
          capture: vi.fn().mockImplementation(async () => {
            // Simulate network delay
            await new Promise(r => setTimeout(r, 50));
            return { id: "pi_123", status: "succeeded", latest_charge: "ch_123" };
          }),
        }
      };
      rail = StripeRail.fromClient(mockStripe);
    });

    it("SUCCESS: StripeRail prevents concurrent captures of the same ID locally", async () => {
      // Fire two captures simultaneously
      const p1 = rail.capturePayment("pi_123", 10);
      const p2 = rail.capturePayment("pi_123", 10);
      
      await Promise.all([p1, p2]);
      
      // Now it should ONLY call Stripe once due to inFlightCaptures map
      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
    });

    it("SUCCESS: StripeRail uses idempotencyKey for capture", async () => {
      await rail.capturePayment("pi_123", 10);
      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
        "pi_123",
        expect.anything(),
        expect.objectContaining({ idempotencyKey: "cap_pi_123" })
      );
    });

    it("SUCCESS: StripeRail createHold uses provided idempotencyKey", async () => {
      await rail.createHold(10, "test", "agent-1", {
        metadata: { idempotencyKey: "unique_hold_1" }
      });
      
      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ idempotencyKey: "unique_hold_1" })
      );
    });
  });

  describe("PaystackRail", () => {
    let rail: PaystackRail;
    let mockFetch: any;

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: true,
          data: { id: 123, status: "success", reference: "ref_123", amount: 1000 }
        })
      });
      global.fetch = mockFetch;
      rail = new PaystackRail("sk_test_123");
    });

    it("SUCCESS: PaystackRail prevents concurrent captures of the same reference", async () => {
      // Fire two captures simultaneously
      const p1 = rail.capturePayment("ref_123", 10);
      const p2 = rail.capturePayment("ref_123", 10);
      
      await Promise.all([p1, p2]);
      
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("SUCCESS: PaystackRail supports deterministic references for idempotency", async () => {
      await rail.createHold(10, "test", "agent-1", {
        metadata: { reference: "my_custom_ref" }
      });
      
      const lastCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(lastCall[1].body);
      expect(payload.reference).toBe("my_custom_ref");
    });
  });
});
