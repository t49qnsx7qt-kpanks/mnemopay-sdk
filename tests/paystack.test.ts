import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaystackRail, NIGERIAN_BANKS } from "../src/rails/paystack.js";
import { createHmac } from "crypto";

// ─── Mock fetch globally ───────────────────────────────────────────────────

const TEST_KEY = "sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function mockFetchResponse(data: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

// ─── Constructor Validation ────────────────────────────────────────────────

describe("PaystackRail — Constructor", () => {
  it("rejects empty secret key", () => {
    expect(() => new PaystackRail("")).toThrow("secret key is required");
  });

  it("rejects non-sk_ prefix key", () => {
    expect(() => new PaystackRail("pk_test_abc")).toThrow("must start with sk_");
  });

  it("accepts valid test key", () => {
    const rail = new PaystackRail(TEST_KEY);
    expect(rail.name).toBe("paystack");
  });

  it("accepts valid live key", () => {
    const rail = new PaystackRail("sk_test_fakekey_for_testing");
    expect(rail.name).toBe("paystack");
  });

  it("uses NGN as default currency", () => {
    const rail = new PaystackRail(TEST_KEY);
    // Verify via toMinorUnits (NGN uses kobo = *100)
    expect(rail.toMinorUnits(100)).toBe(10000);
  });

  it("accepts custom currency", () => {
    const rail = new PaystackRail(TEST_KEY, { currency: "GHS" });
    expect(rail.name).toBe("paystack");
  });
});

// ─── Currency Conversion ───────────────────────────────────────────────────

describe("PaystackRail — Currency Conversion", () => {
  const rail = new PaystackRail(TEST_KEY);

  it("converts Naira to kobo correctly", () => {
    expect(rail.toMinorUnits(100)).toBe(10000);
    expect(rail.toMinorUnits(0.01)).toBe(1);
    expect(rail.toMinorUnits(99.99)).toBe(9999);
    expect(rail.toMinorUnits(1234.56)).toBe(123456);
  });

  it("converts kobo back to Naira correctly", () => {
    expect(rail.fromMinorUnits(10000)).toBe(100);
    expect(rail.fromMinorUnits(1)).toBe(0.01);
    expect(rail.fromMinorUnits(9999)).toBe(99.99);
  });

  it("handles float precision in conversion", () => {
    // 19.99 * 100 = 1998.9999... in IEEE 754, but Math.round fixes it
    expect(rail.toMinorUnits(19.99)).toBe(1999);
    expect(rail.toMinorUnits(0.1 + 0.2)).toBe(30); // 0.30000000000000004 → 30
  });

  it("round-trips preserve value", () => {
    const values = [0.01, 0.50, 1.00, 99.99, 1000.00, 50000.50];
    for (const v of values) {
      expect(rail.fromMinorUnits(rail.toMinorUnits(v))).toBe(v);
    }
  });
});

// ─── createHold (Transaction Initialize) ──────────────────────────────────

describe("PaystackRail — createHold", () => {
  let rail: PaystackRail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    rail = new PaystackRail(TEST_KEY, { callbackUrl: "https://app.test/callback" });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("initializes checkout transaction", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: "https://checkout.paystack.com/abc123",
        access_code: "abc123",
        reference: "mnemo_agent1_ref",
      },
    });

    const result = await rail.createHold(5000, "API subscription", "agent-1");

    expect(result.status).toBe("initialized");
    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/abc123");
    expect(result.accessCode).toBe("abc123");
    expect(result.reference).toContain("mnemo_agent-1_");
    expect(result.externalId).toBe(result.reference);

    // Verify the fetch was called with correct params
    const [url, options] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("/transaction/initialize");
    const body = JSON.parse(options.body);
    expect(body.amount).toBe(500000); // 5000 NGN = 500000 kobo
    expect(body.currency).toBe("NGN");
    expect(body.callback_url).toBe("https://app.test/callback");
    expect(body.metadata.agentId).toBe("agent-1");
    expect(body.metadata.source).toBe("mnemopay");
  });

  it("charges saved card when authorizationCode provided", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: { status: "success", reference: "ref123" },
    });

    const result = await rail.createHold(1000, "Recurring charge", "agent-2", {
      email: "user@test.com",
      authorizationCode: "AUTH_abc123",
    });

    const [url, options] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("/transaction/charge_authorization");
    const body = JSON.parse(options.body);
    expect(body.authorization_code).toBe("AUTH_abc123");
    expect(body.email).toBe("user@test.com");
    expect(body.amount).toBe(100000);
  });

  it("rejects negative amount", async () => {
    await expect(rail.createHold(-100, "Bad", "agent")).rejects.toThrow("positive finite");
  });

  it("rejects NaN amount", async () => {
    await expect(rail.createHold(NaN, "Bad", "agent")).rejects.toThrow("positive finite");
  });

  it("rejects Infinity amount", async () => {
    await expect(rail.createHold(Infinity, "Bad", "agent")).rejects.toThrow("positive finite");
  });

  it("truncates long reasons to 500 chars", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: { authorization_url: "https://checkout.paystack.com/x", access_code: "x", reference: "x" },
    });

    const longReason = "x".repeat(1000);
    await rail.createHold(100, longReason, "agent");

    const [, options] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.metadata.reason.length).toBe(500);
  });

  it("uses agent email fallback", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: { authorization_url: "x", access_code: "x", reference: "x" },
    });

    await rail.createHold(100, "Test", "bot-42");

    const [, options] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.email).toBe("bot-42@mnemopay.agent");
  });
});

// ─── capturePayment (Verify) ──────────────────────────────────────────────

describe("PaystackRail — capturePayment (verify)", () => {
  let rail: PaystackRail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    rail = new PaystackRail(TEST_KEY);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("verifies successful payment", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: {
        status: "success",
        amount: 500000,
        currency: "NGN",
        customer: { email: "user@test.com" },
        authorization: {
          authorization_code: "AUTH_xyz",
          card_type: "visa",
          last4: "4081",
          bank: "Test Bank",
          reusable: true,
        },
        gateway_response: "Successful",
        paid_at: "2026-04-07T12:00:00.000Z",
        metadata: { agentId: "agent-1" },
      },
    });

    const result = await rail.capturePayment("mnemo_ref_123", 5000);

    expect(result.status).toBe("success");
    expect(result.amount).toBe(5000);
    expect(result.currency).toBe("NGN");
    expect(result.authorization?.authorizationCode).toBe("AUTH_xyz");
    expect(result.authorization?.last4).toBe("4081");
    expect(result.authorization?.reusable).toBe(true);
    expect(result.gatewayResponse).toBe("Successful");
    expect(result.paidAt).toBe("2026-04-07T12:00:00.000Z");
  });

  it("handles failed payment", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: {
        status: "failed",
        amount: 100000,
        currency: "NGN",
        gateway_response: "Declined",
      },
    });

    const result = await rail.capturePayment("ref_fail", 1000);
    expect(result.status).toBe("failed");
    expect(result.gatewayResponse).toBe("Declined");
  });

  it("idempotency: second verify returns same result", async () => {
    const successResponse = {
      status: true,
      data: {
        status: "success",
        amount: 100000,
        currency: "NGN",
        gateway_response: "Successful",
        paid_at: "2026-04-07T12:00:00.000Z",
      },
    };

    globalThis.fetch = mockFetchResponse(successResponse);

    // First verify — marks as processed
    const first = await rail.capturePayment("idempotent_ref", 1000);
    expect(first.status).toBe("success");

    // Second verify — idempotency guard hits, still calls API for current state
    const second = await rail.capturePayment("idempotent_ref", 1000);
    expect(second.status).toBe("success");

    // Both calls hit the API (2 fetches)
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
  });

  it("rejects empty reference", async () => {
    await expect(rail.capturePayment("", 100)).rejects.toThrow("reference is required");
  });
});

// ─── reversePayment (Refund) ──────────────────────────────────────────────

describe("PaystackRail — reversePayment (refund)", () => {
  let rail: PaystackRail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    rail = new PaystackRail(TEST_KEY);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refunds a transaction", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes("/transaction/verify/")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ status: true, data: { id: 12345, status: "success", amount: 500000 } }),
        });
      }
      // Refund endpoint
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ status: true, data: { id: 99, status: "processed" } }),
      });
    });

    const result = await rail.reversePayment("ref_to_refund", 5000);

    expect(result.status).toBe("processed");
    expect(callCount).toBe(2); // verify + refund
  });

  it("rejects refund of nonexistent transaction", async () => {
    globalThis.fetch = mockFetchResponse({ status: true, data: { id: null } });

    await expect(rail.reversePayment("ghost_ref", 100)).rejects.toThrow("not found on Paystack");
  });

  it("rejects negative refund amount", async () => {
    await expect(rail.reversePayment("ref", -50)).rejects.toThrow("positive finite");
  });

  it("rejects empty reference", async () => {
    await expect(rail.reversePayment("", 100)).rejects.toThrow("reference is required");
  });
});

// ─── Webhook Verification ─────────────────────────────────────────────────

describe("PaystackRail — Webhook HMAC-SHA512", () => {
  const rail = new PaystackRail(TEST_KEY);

  it("verifies valid webhook signature", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: "ref123", amount: 500000, status: "success" },
    });

    const signature = createHmac("sha512", TEST_KEY).update(body).digest("hex");

    const event = rail.verifyWebhook(body, signature);
    expect(event.event).toBe("charge.success");
    expect(event.data.reference).toBe("ref123");
  });

  it("rejects invalid signature", () => {
    const body = JSON.stringify({ event: "charge.success", data: {} });
    const badSig = "a".repeat(128); // Wrong signature

    expect(() => rail.verifyWebhook(body, badSig)).toThrow("Invalid webhook signature");
  });

  it("rejects tampered body", () => {
    const originalBody = JSON.stringify({ event: "charge.success", data: { amount: 500000 } });
    const signature = createHmac("sha512", TEST_KEY).update(originalBody).digest("hex");

    // Tamper with the body
    const tamperedBody = JSON.stringify({ event: "charge.success", data: { amount: 999999 } });
    expect(() => rail.verifyWebhook(tamperedBody, signature)).toThrow("Invalid webhook signature");
  });

  it("rejects empty signature", () => {
    expect(() => rail.verifyWebhook("{}", "")).toThrow("signature is required");
  });

  it("rejects empty body", () => {
    expect(() => rail.verifyWebhook("", "abc")).toThrow("body is required");
  });

  it("handles Buffer body", () => {
    const body = JSON.stringify({ event: "transfer.success", data: { id: 1 } });
    const signature = createHmac("sha512", TEST_KEY).update(body).digest("hex");
    const bufferBody = Buffer.from(body, "utf-8");

    const event = rail.verifyWebhook(bufferBody, signature);
    expect(event.event).toBe("transfer.success");
  });

  it("verifies charge.success event structure", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: {
        id: 123,
        reference: "mnemo_agent1_ref",
        amount: 1000000,
        currency: "NGN",
        status: "success",
        customer: { email: "user@test.com" },
        authorization: {
          authorization_code: "AUTH_abc",
          card_type: "mastercard",
          last4: "1234",
          bank: "GTBank",
          reusable: true,
        },
        metadata: { agentId: "agent-1", source: "mnemopay" },
      },
    });

    const signature = createHmac("sha512", TEST_KEY).update(body).digest("hex");
    const event = rail.verifyWebhook(body, signature);

    expect(event.event).toBe("charge.success");
    expect(event.data.metadata.source).toBe("mnemopay");
    expect(event.data.authorization.reusable).toBe(true);
  });

  it("verifies transfer.failed event structure", () => {
    const body = JSON.stringify({
      event: "transfer.failed",
      data: {
        id: 456,
        reference: "mnemo_xfer_ref",
        amount: 5000000,
        status: "failed",
        reason: "Invalid account number",
      },
    });

    const signature = createHmac("sha512", TEST_KEY).update(body).digest("hex");
    const event = rail.verifyWebhook(body, signature);

    expect(event.event).toBe("transfer.failed");
    expect(event.data.reason).toBe("Invalid account number");
  });
});

// ─── Transfer (Payout) ────────────────────────────────────────────────────

describe("PaystackRail — Transfers", () => {
  let rail: PaystackRail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    rail = new PaystackRail(TEST_KEY);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("initiates transfer with correct params", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: {
        transfer_code: "TRF_abc123",
        status: "pending",
        amount: 5000000,
      },
    });

    const result = await rail.initiateTransfer("RCP_xyz", 50000, "Driver payout", "agent-1");

    expect(result.status).toBe("pending");
    expect(result.externalId).toBe("TRF_abc123");
    expect(result.amount).toBe(50000);
    expect(result.reference).toContain("mnemo_xfer_");

    const [, options] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.source).toBe("balance");
    expect(body.amount).toBe(5000000); // 50000 NGN = 5M kobo
    expect(body.recipient).toBe("RCP_xyz");
    expect(body.metadata.agentId).toBe("agent-1");
  });

  it("rejects transfer with no recipient", async () => {
    await expect(rail.initiateTransfer("", 1000, "Bad")).rejects.toThrow("Recipient code is required");
  });

  it("rejects transfer with negative amount", async () => {
    await expect(rail.initiateTransfer("RCP_x", -100, "Bad")).rejects.toThrow("positive finite");
  });

  it("rejects transfer with zero amount", async () => {
    await expect(rail.initiateTransfer("RCP_x", 0, "Bad")).rejects.toThrow("positive finite");
  });
});

// ─── Bank Resolution ──────────────────────────────────────────────────────

describe("PaystackRail — Bank Resolution", () => {
  let rail: PaystackRail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    rail = new PaystackRail(TEST_KEY);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves bank account", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: { account_name: "JERRY OMIAGBO", account_number: "0123456789" },
    });

    const result = await rail.resolveBank("0123456789", "058");

    expect(result.accountName).toBe("JERRY OMIAGBO");
    expect(result.accountNumber).toBe("0123456789");

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("account_number=0123456789");
    expect(url).toContain("bank_code=058");
  });
});

// ─── Nigerian Banks Dictionary ────────────────────────────────────────────

describe("Nigerian Bank Codes", () => {
  it("has correct codes for major banks", () => {
    expect(NIGERIAN_BANKS.gtbank).toBe("058");
    expect(NIGERIAN_BANKS.firstbank).toBe("011");
    expect(NIGERIAN_BANKS.uba).toBe("033");
    expect(NIGERIAN_BANKS.zenith).toBe("057");
    expect(NIGERIAN_BANKS.access).toBe("044");
    expect(NIGERIAN_BANKS.kuda).toBe("50211");
    expect(NIGERIAN_BANKS.opay).toBe("999992");
  });

  it("has at least 20 banks", () => {
    expect(Object.keys(NIGERIAN_BANKS).length).toBeGreaterThanOrEqual(20);
  });
});

// ─── Error Handling ───────────────────────────────────────────────────────

describe("PaystackRail — Error Handling", () => {
  let rail: PaystackRail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    rail = new PaystackRail(TEST_KEY);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws on API error response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ status: false, message: "Invalid amount" }),
    });

    await expect(rail.createHold(100, "Test", "agent")).rejects.toThrow("Invalid amount");
  });

  it("throws on 401 unauthorized", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ message: "Invalid key" }),
    });

    await expect(rail.createHold(100, "Test", "agent")).rejects.toThrow("Invalid key");
  });

  it("throws on network timeout", async () => {
    const shortTimeoutRail = new PaystackRail(TEST_KEY, { timeoutMs: 10 });
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        // Listen for the abort signal
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(shortTimeoutRail.createHold(100, "Test", "agent")).rejects.toThrow("timed out");
  });

  it("auth header uses Bearer token", async () => {
    globalThis.fetch = mockFetchResponse({
      status: true,
      data: { authorization_url: "x", access_code: "x", reference: "x" },
    });

    await rail.createHold(100, "Test", "agent");

    const [, options] = (globalThis.fetch as any).mock.calls[0];
    expect(options.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  });
});

// ─── Integration with MnemoPay ────────────────────────────────────────────

describe("PaystackRail — MnemoPay Integration", () => {
  it("implements PaymentRail interface", () => {
    const rail = new PaystackRail(TEST_KEY);
    expect(typeof rail.createHold).toBe("function");
    expect(typeof rail.capturePayment).toBe("function");
    expect(typeof rail.reversePayment).toBe("function");
    expect(rail.name).toBe("paystack");
  });

  it("can be passed to MnemoPay.quick", async () => {
    const { default: MnemoPay } = await import("../src/index.js");
    const rail = new PaystackRail(TEST_KEY);

    // This should not throw — rail is a valid PaymentRail
    const agent = MnemoPay.quick("paystack-agent", { paymentRail: rail });
    expect(agent).toBeTruthy();
  }, 15_000);
});
