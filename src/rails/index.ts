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

export interface PaymentRail {
  /** Human-readable rail name (e.g. "stripe", "lightning", "mock") */
  readonly name: string;

  /**
   * Create a hold/escrow on the external payment system.
   * Called during charge(). The hold should NOT capture funds yet.
   */
  createHold(
    amount: number,
    reason: string,
    agentId: string,
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

  async createHold(amount: number, reason: string, agentId: string): Promise<PaymentRailResult> {
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

  async createHold(amount: number, reason: string, agentId: string): Promise<PaymentRailResult> {
    const intent = await this.stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: this.currency,
      capture_method: "manual", // Hold funds, don't capture yet
      metadata: {
        agentId,
        reason: reason.slice(0, 500),
        source: "mnemopay",
      },
    });

    return {
      externalId: intent.id,
      status: intent.status,
    };
  }

  async capturePayment(externalId: string, amount: number): Promise<PaymentRailResult> {
    const intent = await this.stripe.paymentIntents.capture(externalId, {
      amount_to_capture: Math.round(amount * 100),
    });

    return {
      externalId: intent.id,
      status: intent.status,
      receiptId: intent.latest_charge,
    };
  }

  async reversePayment(externalId: string, _amount: number): Promise<PaymentRailResult> {
    const intent = await this.stripe.paymentIntents.cancel(externalId);

    return {
      externalId: intent.id,
      status: intent.status === "canceled" ? "reversed" : intent.status,
    };
  }
}

// Re-export Paystack rail
export { PaystackRail, NIGERIAN_BANKS } from "./paystack.js";
export type {
  PaystackConfig, PaystackCurrency, PaystackHoldResult,
  PaystackVerifyResult, PaystackTransferRecipient,
  PaystackTransferResult, PaystackWebhookEvent,
} from "./paystack.js";

// ─── Lightning Rail (L402) ──────────────────────────────────────────────────
// Requires a running LND node. Uses HODL invoices for escrow.

export class LightningRail implements PaymentRail {
  readonly name = "lightning";
  private baseUrl: string;
  private macaroon: string;
  private btcPriceUsd: number;

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
    const host = parsed.hostname.toLowerCase();
    const ssrfBlocked = [
      "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::0]",
      "169.254.169.254", // Cloud metadata (AWS/GCP/Azure)
      "metadata.google.internal",
    ];
    if (ssrfBlocked.includes(host) ||
        host.endsWith(".internal") ||
        host.endsWith(".local") ||
        /^10\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^192\.168\./.test(host)) {
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

  async createHold(amount: number, reason: string, agentId: string): Promise<PaymentRailResult> {
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
    // Check if invoice is settled
    const invoice = await this.lndRequest(
      `/v1/invoice/${encodeURIComponent(externalId)}`,
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
