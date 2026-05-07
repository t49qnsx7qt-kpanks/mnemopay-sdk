/**
 * StripeMPPRail — Stripe Machine Payments Protocol (MPP) rail.
 *
 * Stripe MPP (announced 2026-03-18, co-developed with Tempo) routes
 * agent payments as crypto deposits on the Tempo network or as Stripe
 * Shared Payment Tokens (SPT) for fiat. Our adapter targets the crypto
 * deposit flow first — that's the path that matches MnemoPay's two-phase
 * hold/capture/reverse semantics for sub-cent and cross-border agent
 * micropayments.
 *
 * @experimental v1.6.x scope. Requires Stripe API version
 *   `2026-03-04.preview`. The preview API can change without semver
 *   guarantees from Stripe — pin `apiVersion` explicitly in production.
 *
 * Docs: https://docs.stripe.com/payments/machine/mpp
 *
 * Security:
 *   - Hold uses `capture_method: "manual"` so funds escrow until settle().
 *   - Idempotency keys forwarded from `opts.metadata.idempotencyKey`
 *     (or `requestId`) prevent duplicate holds on retry.
 *   - In-flight capture deduplication via `Map<intentId, Promise>`
 *     stops parallel settle() calls from double-charging.
 *   - PII redaction: `reason` is truncated to 500 chars before being
 *     attached as PaymentIntent metadata (Stripe's hard cap).
 *   - The Tempo network mode (`deposit`) places funds into a Stripe-managed
 *     deposit address — MnemoPay never sees private keys.
 */

import type { PaymentRail, PaymentRailResult, HoldOptions } from "./index.js";

/**
 * Construction options for StripeMPPRail. Distinct from the constructor
 * signature so we can grow the option surface without breaking callers.
 */
export interface StripeMPPOptions {
  /** Stripe secret key (sk_test_... or sk_live_...) */
  secretKey: string;
  /** ISO currency code for the fiat-equivalent value. Default: "usd". */
  currency?: string;
  /**
   * Stripe API version. Defaults to `2026-03-04.preview` (the version
   * MPP launched on). Pinning is recommended in production — the preview
   * API can change without notice.
   */
  apiVersion?: string;
  /**
   * Crypto networks accepted for the MPP deposit. Defaults to `["tempo"]`
   * (Stripe's L1 partner). When more networks reach GA you can add
   * additional values; the agent's wallet picks one supported network.
   */
  networks?: string[];
}

/**
 * Stripe MPP rail. Implements the same `PaymentRail` interface as
 * `StripeRail` so callers can swap rails without touching their charge()
 * code path. Differs in two specific ways:
 *
 *   1. Forces `payment_method_types: ["crypto"]` + crypto deposit options
 *      on `createHold` so the PaymentIntent runs through MPP rather than
 *      a regular card charge.
 *   2. Pins the Stripe SDK to the MPP-required API preview version.
 */
export class StripeMPPRail implements PaymentRail {
  readonly name = "stripe_mpp";
  private stripe: any;
  private currency: string;
  private networks: string[];
  private inFlightCaptures: Map<string, Promise<PaymentRailResult>> = new Map();

  constructor(opts: StripeMPPOptions) {
    if (!opts || typeof opts !== "object") {
      throw new Error("StripeMPPRail: options object is required");
    }
    if (!opts.secretKey || typeof opts.secretKey !== "string") {
      throw new Error("StripeMPPRail: opts.secretKey is required");
    }
    this.currency = opts.currency ?? "usd";
    this.networks = (opts.networks && opts.networks.length > 0) ? opts.networks : ["tempo"];
    try {
      // require() is intentional — peer dep, lazy-loaded so the SDK
      // doesn't pull in `stripe` for users on other rails.
      const Stripe = require("stripe");
      this.stripe = new Stripe(opts.secretKey, {
        apiVersion: opts.apiVersion ?? "2026-03-04.preview",
      });
    } catch {
      throw new Error(
        "Stripe package not installed. Run: npm install stripe (>=14.0.0)"
      );
    }
  }

  /**
   * Build a StripeMPPRail from an already-constructed Stripe client.
   *
   * Useful for tests (inject a mock) and for apps that want to share
   * a single Stripe client across multiple rails. The caller is
   * responsible for ensuring the client was created with the
   * `2026-03-04.preview` API version.
   */
  static fromClient(
    client: any,
    opts?: { currency?: string; networks?: string[] },
  ): StripeMPPRail {
    if (!client) throw new Error("StripeMPPRail.fromClient: client is required");
    const rail = Object.create(StripeMPPRail.prototype) as StripeMPPRail;
    (rail as any).name = "stripe_mpp";
    (rail as any).stripe = client;
    (rail as any).currency = opts?.currency ?? "usd";
    (rail as any).networks =
      (opts?.networks && opts.networks.length > 0) ? opts.networks : ["tempo"];
    (rail as any).inFlightCaptures = new Map();
    return rail;
  }

  async createHold(
    amount: number,
    reason: string,
    agentId: string,
    opts?: HoldOptions,
  ): Promise<PaymentRailResult> {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("StripeMPPRail.createHold: amount must be a positive number");
    }
    if (!agentId || typeof agentId !== "string") {
      throw new Error("StripeMPPRail.createHold: agentId is required");
    }

    const params: Record<string, unknown> = {
      amount: Math.round(amount * 100), // Stripe uses minor units
      currency: this.currency,
      capture_method: "manual", // Escrow until settle()
      payment_method_types: ["crypto"],
      payment_method_data: { type: "crypto" },
      payment_method_options: {
        crypto: {
          mode: "deposit",
          deposit_options: { networks: this.networks },
        },
      },
      metadata: {
        agentId,
        reason: (reason ?? "").slice(0, 500),
        source: "mnemopay",
        rail: "stripe_mpp",
        ...(opts?.metadata ?? {}),
      },
    };

    // Customer attachment is optional under MPP — the deposit address
    // is the funds source. We pass it through when present so receipts
    // tie back to a Stripe customer record.
    if (opts?.customerId) params.customer = opts.customerId;

    const idempotencyKey =
      (opts?.metadata?.idempotencyKey as string) ||
      (opts?.metadata?.requestId as string);

    const intent = await this.stripe.paymentIntents.create(
      params,
      idempotencyKey ? { idempotencyKey } : {},
    );

    return {
      externalId: intent.id,
      status: intent.status,
    };
  }

  async capturePayment(
    externalId: string,
    amount: number,
  ): Promise<PaymentRailResult> {
    if (!externalId) throw new Error("StripeMPPRail.capturePayment: externalId is required");
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error("StripeMPPRail.capturePayment: amount must be a non-negative number");
    }

    // Race-protection: a parallel settle() on the same hold returns the
    // same in-flight promise rather than firing a second capture.
    const existing = this.inFlightCaptures.get(externalId);
    if (existing) return existing;

    const promise = (async () => {
      const intent = await this.stripe.paymentIntents.capture(
        externalId,
        { amount_to_capture: Math.round(amount * 100) },
        { idempotencyKey: `cap_${externalId}` },
      );
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

  async reversePayment(
    externalId: string,
    _amount: number,
  ): Promise<PaymentRailResult> {
    if (!externalId) throw new Error("StripeMPPRail.reversePayment: externalId is required");
    const intent = await this.stripe.paymentIntents.cancel(externalId);
    return {
      externalId: intent.id,
      status: intent.status === "canceled" ? "reversed" : intent.status,
    };
  }
}
