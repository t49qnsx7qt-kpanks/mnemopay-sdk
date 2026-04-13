/**
 * StripeRail — customer + saved payment method path
 *
 * These tests never hit real Stripe. A mock client is injected via
 * `StripeRail.fromClient()` so we can assert the exact shape of params
 * we send to Stripe's PaymentIntents API.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StripeRail } from "../src/rails/index.js";

interface Call {
  method: string;
  args: any[];
}

function makeMockStripe(): { client: any; calls: Call[] } {
  const calls: Call[] = [];

  const client = {
    paymentIntents: {
      create: async (params: any) => {
        calls.push({ method: "paymentIntents.create", args: [params] });
        return {
          id: "pi_test_123",
          status: params.confirm ? "requires_capture" : "requires_payment_method",
        };
      },
      capture: async (id: string, params: any) => {
        calls.push({ method: "paymentIntents.capture", args: [id, params] });
        return { id, status: "succeeded", latest_charge: "ch_test_456" };
      },
      cancel: async (id: string) => {
        calls.push({ method: "paymentIntents.cancel", args: [id] });
        return { id, status: "canceled" };
      },
    },
    customers: {
      create: async (params: any) => {
        calls.push({ method: "customers.create", args: [params] });
        return { id: "cus_test_789" };
      },
    },
    setupIntents: {
      create: async (params: any) => {
        calls.push({ method: "setupIntents.create", args: [params] });
        return { id: "seti_test_abc", client_secret: "seti_test_abc_secret_xyz" };
      },
    },
  };

  return { client, calls };
}

describe("StripeRail — no options (legacy path)", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeRail.fromClient(mock.client);
  });

  it("createHold without options creates a manual-capture intent only", async () => {
    const res = await rail.createHold(25, "Monthly access", "agent-1");

    expect(res.externalId).toBe("pi_test_123");
    expect(mock.calls).toHaveLength(1);

    const params = mock.calls[0].args[0];
    expect(params.amount).toBe(2500); // cents
    expect(params.currency).toBe("usd");
    expect(params.capture_method).toBe("manual");
    expect(params.metadata.agentId).toBe("agent-1");
    expect(params.metadata.reason).toBe("Monthly access");
    expect(params.metadata.source).toBe("mnemopay");
    // No customer, no confirm — legacy handoff flow.
    expect(params.customer).toBeUndefined();
    expect(params.payment_method).toBeUndefined();
    expect(params.confirm).toBeUndefined();
    expect(params.off_session).toBeUndefined();
  });
});

describe("StripeRail — customer + saved payment method", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeRail.fromClient(mock.client, "eur");
  });

  it("honors currency override from fromClient", async () => {
    await rail.createHold(10, "test", "agent-1");
    expect(mock.calls[0].args[0].currency).toBe("eur");
  });

  it("createHold with customerId + paymentMethodId confirms on-session", async () => {
    const res = await rail.createHold(42.5, "paid task", "agent-9", {
      customerId: "cus_real",
      paymentMethodId: "pm_real",
    });

    expect(res.externalId).toBe("pi_test_123");
    expect(res.status).toBe("requires_capture");

    const params = mock.calls[0].args[0];
    expect(params.amount).toBe(4250);
    expect(params.customer).toBe("cus_real");
    expect(params.payment_method).toBe("pm_real");
    expect(params.confirm).toBe(true);
    // off_session defaults to undefined — caller didn't ask for it.
    expect(params.off_session).toBeUndefined();
  });

  it("off_session: true when caller requests it alongside a saved PM", async () => {
    await rail.createHold(12, "reason", "agent-1", {
      customerId: "cus_x",
      paymentMethodId: "pm_x",
      offSession: true,
    });
    const params = mock.calls[0].args[0];
    expect(params.off_session).toBe(true);
  });

  it("does NOT set confirm when only customerId is provided (no PM)", async () => {
    await rail.createHold(5, "r", "agent-1", { customerId: "cus_x" });
    const params = mock.calls[0].args[0];
    expect(params.customer).toBe("cus_x");
    expect(params.payment_method).toBeUndefined();
    expect(params.confirm).toBeUndefined();
  });

  it("merges caller metadata without clobbering the reserved fields", async () => {
    await rail.createHold(1, "r", "agent-1", {
      metadata: { orderId: "ord_42", tenant: "acme" },
    });
    const meta = mock.calls[0].args[0].metadata;
    expect(meta.agentId).toBe("agent-1");
    expect(meta.source).toBe("mnemopay");
    expect(meta.reason).toBe("r");
    expect(meta.orderId).toBe("ord_42");
    expect(meta.tenant).toBe("acme");
  });

  it("truncates absurd reasons to 500 chars in metadata", async () => {
    const huge = "x".repeat(2000);
    await rail.createHold(1, huge, "agent-1");
    const meta = mock.calls[0].args[0].metadata;
    expect(meta.reason.length).toBe(500);
  });
});

describe("StripeRail — capture + reverse", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeRail.fromClient(mock.client);
  });

  it("capturePayment passes amount_to_capture in cents", async () => {
    const res = await rail.capturePayment("pi_abc", 7.33);
    expect(res.status).toBe("succeeded");
    expect(res.receiptId).toBe("ch_test_456");
    expect(mock.calls[0].args[0]).toBe("pi_abc");
    expect(mock.calls[0].args[1].amount_to_capture).toBe(733);
  });

  it("reversePayment normalizes canceled → reversed", async () => {
    const res = await rail.reversePayment("pi_abc", 10);
    expect(res.status).toBe("reversed");
    expect(mock.calls[0].method).toBe("paymentIntents.cancel");
  });
});

describe("StripeRail — onboarding helpers", () => {
  let mock: ReturnType<typeof makeMockStripe>;
  let rail: StripeRail;

  beforeEach(() => {
    mock = makeMockStripe();
    rail = StripeRail.fromClient(mock.client);
  });

  it("createCustomer returns cus_ id and forwards email + name", async () => {
    const res = await rail.createCustomer("jerry@example.com", "Jerry O");
    expect(res.customerId).toBe("cus_test_789");
    const params = mock.calls[0].args[0];
    expect(params.email).toBe("jerry@example.com");
    expect(params.name).toBe("Jerry O");
  });

  it("createCustomer rejects empty email", async () => {
    await expect(rail.createCustomer("")).rejects.toThrow(/email is required/);
  });

  it("createSetupIntent returns off_session setup for a customer", async () => {
    const res = await rail.createSetupIntent("cus_real");
    expect(res.setupIntentId).toBe("seti_test_abc");
    expect(res.clientSecret).toBe("seti_test_abc_secret_xyz");
    expect(mock.calls[0].args[0]).toEqual({
      customer: "cus_real",
      usage: "off_session",
    });
  });

  it("createSetupIntent rejects empty customerId", async () => {
    await expect(rail.createSetupIntent("")).rejects.toThrow(/customerId is required/);
  });
});

describe("MnemoPayLite.charge → StripeRail payOptions plumbing", () => {
  it("passes payOptions through to the rail", async () => {
    const mock = makeMockStripe();
    const rail = StripeRail.fromClient(mock.client);

    const { MnemoPay } = await import("../src/index.js");
    const agent = MnemoPay.quick("plumbing-test", { paymentRail: rail });

    await agent.charge(15, "paid task", undefined, {
      customerId: "cus_plumb",
      paymentMethodId: "pm_plumb",
      offSession: true,
    });

    const createCall = mock.calls.find(c => c.method === "paymentIntents.create");
    expect(createCall).toBeDefined();
    expect(createCall!.args[0].customer).toBe("cus_plumb");
    expect(createCall!.args[0].payment_method).toBe("pm_plumb");
    expect(createCall!.args[0].off_session).toBe(true);
    expect(createCall!.args[0].metadata.agentId).toBe("plumbing-test");
  }, 20_000);
});
