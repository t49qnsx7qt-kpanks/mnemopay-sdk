/**
 * Payment Rail Abstraction
 *
 * Pluggable payment backends for MnemoPay. The default MockRail keeps
 * the existing in-memory ledger behavior. Real rails (Stripe, Lightning)
 * connect to actual payment processors.
 *
 * Usage:
 *   const agent = MnemoPay.quick("id", { paymentRail: new StripeRail("sk_test_...") });
 */

// ─── Interface ──────────────────────────────────────────────────────────────

export interface PaymentRailResult {
  externalId: string;
  status: string;
  receiptId?: string;
}

/**
 * Optional rail-specific options for createHold.
 *
 * Rails ignore fields they don't support. Existing callers that pass no
 * options keep the pre-v1.0 behavior (rail charges its own default source).
 */
export interface HoldOptions {
  /** Stripe customer id (cus_...) — source of funds for the hold */
  customerId?: string;
  /** Stripe payment method id (pm_...) — the saved card/bank to charge */
  paymentMethodId?: string;
  /** Paystack: end-user email for checkout receipts */
  email?: string;
  /** Paystack: saved-card authorization code for one-click charges */
  authorizationCode?: string;
  /**
   * Stripe: confirm immediately using a saved payment method without user
   * interaction. Requires customerId + paymentMethodId. Defaults to false.
   */
  offSession?: boolean;
  /** Arbitrary rail-specific metadata merged into the underlying call */
  metadata?: Record<string, unknown>;
}

export interface PaymentRail {
  /** Human-readable rail name (e.g. "stripe", "lightning", "mock") */
  readonly name: string;

  /**
   * Create a hold/escrow on the external payment system.
   * Called during charge(). The hold should NOT capture funds yet.
   *
   * The optional `opts` bag lets callers target a specific customer /
   * saved payment method. Rails that don't support a given field ignore it.
   */
  createHold(
    amount: number,
    reason: string,
    agentId: string,
    opts?: HoldOptions,
  ): Promise<PaymentRailResult>;

  /**
   * Capture/finalize the payment.
   * Called during settle(). Moves real money.
   */
  capturePayment(
    externalId: string,
    amount: number,
  ): Promise<PaymentRailResult>;

  /**
   * Reverse/cancel the payment.
   * Called during refund(). Returns money to payer.
   */
  reversePayment(
    externalId: string,
    amount: number,
  ): Promise<PaymentRailResult>;
}

// ─── Mock Rail (default — existing in-memory behavior) ──────────────────────

export class MockRail implements PaymentRail {
  readonly name = "mock";
  private counter = 0;

  async createHold(amount: number, reason: string, agentId: string, _opts?: HoldOptions): Promise<PaymentRailResult> {
    return {
      externalId: `mock_hold_${++this.counter}`,
      status: "held",
    };
  }

  async capturePayment(externalId: string, amount: number): Promise<PaymentRailResult> {
    return {
      externalId,
      status: "captured",
      receiptId: `mock_receipt_${this.counter}`,
    };
  }

  async reversePayment(externalId: string, amount: number): Promise<PaymentRailResult> {
    return {
      externalId,
      status: "reversed",
    };
  }
}

// ─── Stripe Rail ────────────────────────────────────────────────────────────
// Requires: npm install stripe (peer dependency)
// Uses PaymentIntents with manual capture for true escrow.

export class StripeRail implements PaymentRail {
  readonly name = "stripe";
  private stripe: any;
  private currency: string;
  private inFlightCaptures: Map<string, Promise<PaymentRailResult>> = new Map();

  /**
   * @param secretKey — Stripe secret key (sk_test_... or sk_live_...)
   * @param currency — ISO currency code (default: "usd")
   */
  constructor(secretKey: string, currency = "usd") {
    this.currency = currency;
    try {
      const Stripe = require("stripe");
      this.stripe = new Stripe(secretKey);
    } catch {
      throw new Error(
        "Stripe package not installed. Run: npm install stripe"
      );
    }
  }

  /**
   * Build a StripeRail from an already-constructed Stripe client.
   *
   * Useful for tests (inject a mock) and for apps that want to share a
   * single Stripe client instance across multiple rails / services.
   */
  static fromClient(client: any, currency = "usd"): StripeRail {
    // Bypass the require() path by stamping the field on a bare instance.
    const rail = Object.create(StripeRail.prototype) as StripeRail;
    (rail as any).name = "stripe";
    (rail as any).stripe = client;
    (rail as any).currency = currency;
    (rail as any).inFlightCaptures = new Map();
    return rail;
  }

  async createHold(
    amount: number,
    reason: string,
    agentId: string,
    opts?: HoldOptions,
  ): Promise<PaymentRailResult> {
    const params: Record<string, unknown> = {
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: this.currency,
      capture_method: "manual", // Hold funds, don't capture yet
      metadata: {
        agentId,
        reason: reason.slice(0, 500),
        source: "mnemopay",
        ...(opts?.metadata ?? {}),
      },
    };

    // Target a specific customer + saved payment method when provided.
    // This is the path that actually moves money without a browser handoff.
    if (opts?.customerId) params.customer = opts.customerId;
    if (opts?.paymentMethodId) {
      params.payment_method = opts.paymentMethodId;
      // Only confirm automatically when we have a PM to confirm with.
      // Omitting confirm lets the caller attach a PM client-side (Stripe.js)
      // and confirm from the browser — the pre-v1.0 flow.
      params.confirm = true;
      if (opts.offSession) params.off_session = true;
    }

    const idempotencyKey = (opts?.metadata?.idempotencyKey as string) || 
                          (opts?.metadata?.requestId as string);

    const intent = await this.stripe.paymentIntents.create(
      params, 
      idempotencyKey ? { idempotencyKey } : {}
    );

    return {
      externalId: intent.id,
      status: intent.status,
    };
  }

  async capturePayment(externalId: string, amount: number): Promise<PaymentRailResult> {
    const existing = this.inFlightCaptures.get(externalId);
    if (existing) return existing;

    const promise = (async () => {
      const intent = await this.stripe.paymentIntents.capture(externalId, {
        amount_to_capture: Math.round(amount * 100),
      }, {
        idempotencyKey: `cap_${externalId}`,
      });

      return {
        externalId: intent.id,
        status: intent.status,
        receiptId: intent.latest_charge,
      };
    })();

    this.inFlightCaptures.set(externalId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightCaptures.delete(externalId);
    }
  }

  async reversePayment(externalId: string, _amount: number): Promise<PaymentRailResult> {
    const intent = await this.stripe.paymentIntents.cancel(externalId);

    return {
      externalId: intent.id,
      status: intent.status === "canceled" ? "reversed" : intent.status,
    };
  }

  // ── Customer onboarding helpers ─────────────────────────────────────────
  // Thin wrappers around Stripe's customer + SetupIntent APIs. These let
  // apps collect and save a card without pulling in the full Stripe SDK
  // from every service that only needs MnemoPay.

  /**
   * Create a Stripe customer. Returns the customer id (cus_...).
   * Persist this against your internal user/agent record.
   */
  async createCustomer(
    email: string,
    name?: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ customerId: string }> {
    if (!email || typeof email !== "string") {
      throw new Error("email is required");
    }
    const customer = await this.stripe.customers.create({
      email,
      ...(name ? { name } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return { customerId: customer.id };
  }

  /**
   * Create a SetupIntent for collecting a card via Stripe.js (off-session
   * charges later). Return the client_secret to the frontend and confirm
   * it with Stripe.js — no card data ever touches your servers.
   */
  async createSetupIntent(
    customerId: string,
  ): Promise<{ setupIntentId: string; clientSecret: string }> {
    if (!customerId || typeof customerId !== "string") {
      throw new Error("customerId is required");
    }
    const si = await this.stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
    });
    return { setupIntentId: si.id, clientSecret: si.client_secret };
  }
}

// Re-export Paystack rail
export { PaystackRail, NIGERIAN_BANKS } from "./paystack.js";
export type {
  PaystackConfig, PaystackCurrency, PaystackHoldResult,
  PaystackVerifyResult, PaystackTransferRecipient,
  PaystackTransferResult, PaystackWebhookEvent,
} from "./paystack.js";

// Re-export Stripe MPP rail (experimental, v1.6.x)
export { StripeMPPRail } from "./stripe-mpp.js";
export type { StripeMPPOptions } from "./stripe-mpp.js";

// ─── Lightning Rail (L402) ──────────────────────────────────────────────────
// Requires a running LND node. Uses HODL invoices for escrow.

export class LightningRail implements PaymentRail {
  readonly name = "lightning";
  private baseUrl: string;
  private macaroon: string;
  private btcPriceUsd: number;

  /**
   * Check whether a hostname resolves to a private, reserved, or otherwise
   * dangerous network address. Covers IPv6-mapped IPv4, numeric/hex/octal
   * IP bypass tricks, cloud metadata endpoints, and RFC1918 ranges.
   */
  static isPrivateOrReserved(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\[|\]/g, "");

    // Direct matches
    const blocked = [
      "localhost", "0.0.0.0", "[::]", "::1", "::ffff:127.0.0.1",
      "metadata.google.internal", "169.254.169.254",
    ];
    if (blocked.some(b => h === b || h.includes(b))) return true;

    // IPv4 numeric/hex/octal bypass
    // Parse as number — if it resolves to a private range, block it
    const asNum = Number(h);
    if (!isNaN(asNum) && asNum >= 0) return true; // Block ALL numeric IPs

    // Hex IPs
    if (/^0x[0-9a-f]+$/i.test(h)) return true;

    // Octal IPs (starts with 0)
    if (/^0\d+(\.\d+){0,3}$/.test(h)) return true;

    // IPv6-mapped IPv4
    if (/::ffff:/i.test(h)) return true;

    // IPv6 loopback
    if (h === "::1" || h === "[::1]") return true;

    // Suffix-based blocks
    if (h.endsWith(".internal") || h.endsWith(".local")) return true;

    // RFC1918 ranges and other reserved IPv4
    const parts = h.split(".").map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
      if (parts[0] === 127) return true;
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 0) return true;
    }

    return false;
  }

  /**
   * @param lndRestUrl — LND REST API URL (e.g. "https://localhost:8080")
   * @param macaroon — Admin macaroon hex string
   * @param btcPriceUsd — BTC price in USD for conversion (updated externally)
   */
  constructor(lndRestUrl: string, macaroon: string, btcPriceUsd = 60000) {
    // Validate URL to prevent SSRF
    let parsed: URL;
    try {
      parsed = new URL(lndRestUrl);
    } catch {
      throw new Error("Invalid LND REST URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("LND URL must use http or https protocol");
    }
    // SSRF protection: block private/internal network targets
    if (LightningRail.isPrivateOrReserved(parsed.hostname)) {
      throw new Error("LND URL must not target private/internal network addresses");
    }
    this.baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
    this.macaroon = macaroon;
    this.btcPriceUsd = btcPriceUsd;
  }

  /** Update BTC price for USD→sats conversion */
  setBtcPrice(usd: number): void {
    this.btcPriceUsd = usd;
  }

  private usdToSats(usd: number): number {
    return Math.round((usd / this.btcPriceUsd) * 100_000_000);
  }

  private async lndRequest(path: string, method: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Grpc-Metadata-macaroon": this.macaroon,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // Sanitize error — don't leak raw LND response body
      throw new Error(`LND API error (${res.status})`);
    }
    return res.json();
  }

  async createHold(amount: number, reason: string, agentId: string, _opts?: HoldOptions): Promise<PaymentRailResult> {
    const sats = this.usdToSats(amount);

    // Create a standard invoice (HODL invoices need invoicesrpc)
    const invoice = await this.lndRequest("/v1/invoices", "POST", {
      value: sats.toString(),
      memo: `mnemopay:${agentId}:${reason.slice(0, 100)}`,
      expiry: "3600", // 1 hour
    });

    return {
      externalId: invoice.r_hash, // Base64 payment hash
      status: "invoice_created",
      receiptId: invoice.payment_request, // Lightning invoice string
    };
  }

  async capturePayment(externalId: string, _amount: number): Promise<PaymentRailResult> {
    // externalId is the r_hash (base64 payment hash) from createHold.
    // LND REST requires the r_hash as URL-safe base64 in the path.
    const rHashUrlSafe = externalId
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const invoice = await this.lndRequest(
      `/v1/invoice/${rHashUrlSafe}`,
      "GET"
    );

    return {
      externalId,
      status: invoice.settled ? "captured" : "pending",
      receiptId: invoice.payment_request,
    };
  }

  async reversePayment(externalId: string, _amount: number): Promise<PaymentRailResult> {
    // Lightning invoices can't be reversed once paid
    // Cancel unpaid invoice by letting it expire
    return {
      externalId,
      status: "expired",
    };
  }
}
