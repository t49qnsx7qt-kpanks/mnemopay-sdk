/**
 * StripeMPPRail — Stripe Machine Payments Protocol (MPP) tests.
 *
 * No real Stripe calls. A mock client is injected via
 * `StripeMPPRail.fromClient()` so we can assert the exact shape of
 * params we send to Stripe's PaymentIntents API — including the
 * MPP-specific crypto deposit fields.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StripeMPPRail } from "../src/rails/stripe-mpp.js";

interface Call {
  method: string;
  args: any[];
}

function makeMockStripe(): { client: any; calls: Call[] } {
  const calls: Call[] = [];

  const client = {
    paymentIntents: {
      create: async (params: any, options?: any) => {
        calls.push({ method: "paymentIntents.create", args: [params, options] });
        return {
          id: "pi_mpp_test_123",
          status: "requires_payment_method",
        };
      },
      capture: async (id: string, params: any, options?: any) => {
        calls.push({ method: "paymentIntents.capture", args: [id, params, options] });
        return { id, status: "succeeded", latest_charge: "ch_mpp_test_456" };
      },
      cancel: async (id: string) => {
        calls.push({ method: "paymentIntents.cancel", args: [id] });
        return { id, status: "canceled" };
      },
    },
  };

  return { client, calls };
}

describe("StripeMPPRail — createHold", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeMPPRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeMPPRail.fromClient(mock.client);
  });

  it("emits MPP-specific crypto deposit params on createHold", async () => {
    const res = await rail.createHold(25, "Monthly API access", "agent-1");

    expect(res.externalId).toBe("pi_mpp_test_123");
    expect(res.status).toBe("requires_payment_method");
    expect(mock.calls).toHaveLength(1);

    const params = mock.calls[0].args[0];
    // Standard PaymentIntent fields
    expect(params.amount).toBe(2500); // cents
    expect(params.currency).toBe("usd");
    expect(params.capture_method).toBe("manual"); // escrow

    // MPP-specific fields (per Stripe's 2026-03-04.preview docs)
    expect(params.payment_method_types).toEqual(["crypto"]);
    expect(params.payment_method_data).toEqual({ type: "crypto" });
    expect(params.payment_method_options.crypto.mode).toBe("deposit");
    expect(params.payment_method_options.crypto.deposit_options.networks).toEqual(["tempo"]);

    // Metadata for replay-protection + audit chain attribution
    expect(params.metadata.agentId).toBe("agent-1");
    expect(params.metadata.reason).toBe("Monthly API access");
    expect(params.metadata.source).toBe("mnemopay");
    expect(params.metadata.rail).toBe("stripe_mpp");
  });

  it("uses provided networks override", async () => {
    const railEth = StripeMPPRail.fromClient(mock.client, {
      networks: ["tempo", "base"],
    });
    await railEth.createHold(10, "x", "agent-1");
    const params = mock.calls[0].args[0];
    expect(params.payment_method_options.crypto.deposit_options.networks).toEqual(["tempo", "base"]);
  });

  it("falls back to ['tempo'] when networks is empty array", async () => {
    const railEmpty = StripeMPPRail.fromClient(mock.client, { networks: [] });
    await railEmpty.createHold(5, "x", "agent-1");
    const params = mock.calls[0].args[0];
    expect(params.payment_method_options.crypto.deposit_options.networks).toEqual(["tempo"]);
  });

  it("honors currency override from fromClient", async () => {
    const railEur = StripeMPPRail.fromClient(mock.client, { currency: "eur" });
    await railEur.createHold(10, "test", "agent-1");
    expect(mock.calls[0].args[0].currency).toBe("eur");
  });

  it("attaches customer when customerId provided", async () => {
    await rail.createHold(15, "task", "agent-9", { customerId: "cus_real_42" });
    const params = mock.calls[0].args[0];
    expect(params.customer).toBe("cus_real_42");
  });

  it("does not attach customer when customerId omitted", async () => {
    await rail.createHold(15, "task", "agent-9");
    const params = mock.calls[0].args[0];
    expect(params.customer).toBeUndefined();
  });

  it("forwards idempotencyKey to Stripe options bag", async () => {
    await rail.createHold(20, "y", "agent-7", {
      metadata: { idempotencyKey: "req_abc_123" },
    });
    const stripeOpts = mock.calls[0].args[1];
    expect(stripeOpts.idempotencyKey).toBe("req_abc_123");
  });

  it("falls back to requestId when idempotencyKey missing", async () => {
    await rail.createHold(20, "y", "agent-7", {
      metadata: { requestId: "req_xyz_789" },
    });
    const stripeOpts = mock.calls[0].args[1];
    expect(stripeOpts.idempotencyKey).toBe("req_xyz_789");
  });

  it("merges custom metadata over defaults but preserves rail tag", async () => {
    await rail.createHold(20, "task", "agent-5", {
      metadata: { customField: "v", source: "should_not_override" },
    });
    const params = mock.calls[0].args[0];
    expect(params.metadata.customField).toBe("v");
    // User-provided metadata wins over defaults (matches StripeRail behavior).
    expect(params.metadata.source).toBe("should_not_override");
  });

  it("truncates reason to 500 chars before sending to Stripe", async () => {
    const long = "x".repeat(1000);
    await rail.createHold(5, long, "agent-1");
    const params = mock.calls[0].args[0];
    expect(params.metadata.reason.length).toBe(500);
  });

  it("rejects non-positive amount", async () => {
    await expect(rail.createHold(0, "x", "agent-1")).rejects.toThrow(/positive/);
    await expect(rail.createHold(-5, "x", "agent-1")).rejects.toThrow(/positive/);
    await expect(rail.createHold(NaN, "x", "agent-1")).rejects.toThrow(/positive/);
  });

  it("rejects empty agentId", async () => {
    await expect(rail.createHold(5, "x", "")).rejects.toThrow(/agentId/);
    await expect(rail.createHold(5, "x", null as any)).rejects.toThrow(/agentId/);
  });
});

describe("StripeMPPRail — capturePayment", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeMPPRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeMPPRail.fromClient(mock.client);
  });

  it("captures the full hold amount in cents", async () => {
    const res = await rail.capturePayment("pi_mpp_test_123", 25);
    expect(res.externalId).toBe("pi_mpp_test_123");
    expect(res.status).toBe("succeeded");
    expect(res.receiptId).toBe("ch_mpp_test_456");

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe("paymentIntents.capture");
    expect(mock.calls[0].args[0]).toBe("pi_mpp_test_123");
    expect(mock.calls[0].args[1].amount_to_capture).toBe(2500);
    expect(mock.calls[0].args[2].idempotencyKey).toBe("cap_pi_mpp_test_123");
  });

  it("deduplicates parallel captures on the same intent", async () => {
    const [r1, r2] = await Promise.all([
      rail.capturePayment("pi_mpp_test_123", 25),
      rail.capturePayment("pi_mpp_test_123", 25),
    ]);
    expect(r1).toEqual(r2);
    // Only ONE actual Stripe call despite two callers.
    expect(mock.calls).toHaveLength(1);
  });

  it("rejects empty externalId", async () => {
    await expect(rail.capturePayment("", 25)).rejects.toThrow(/externalId/);
  });
});

describe("StripeMPPRail — reversePayment", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeMPPRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeMPPRail.fromClient(mock.client);
  });

  it("cancels the PaymentIntent and reports reversed", async () => {
    const res = await rail.reversePayment("pi_mpp_test_123", 25);
    expect(res.externalId).toBe("pi_mpp_test_123");
    expect(res.status).toBe("reversed");
    expect(mock.calls[0].method).toBe("paymentIntents.cancel");
  });

  it("rejects empty externalId", async () => {
    await expect(rail.reversePayment("", 25)).rejects.toThrow(/externalId/);
  });
});

describe("StripeMPPRail — constructor validation", () => {
  it("rejects missing options", () => {
    expect(() => new StripeMPPRail(undefined as any)).toThrow(/options/);
  });

  it("rejects missing secretKey", () => {
    expect(() => new StripeMPPRail({} as any)).toThrow(/secretKey/);
  });

  it("rejects null fromClient input", () => {
    expect(() => StripeMPPRail.fromClient(null)).toThrow(/client/);
  });
});
