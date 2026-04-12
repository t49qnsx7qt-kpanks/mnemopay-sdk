/**
 * Paystack Payment Rail for MnemoPay
 *
 * Production-grade integration with Paystack's payment infrastructure.
 * Supports NGN, GHS, ZAR, KES, USD. Uses the same battle-tested patterns
 * from the Dele backend: idempotency guards, webhook HMAC-SHA512 verification,
 * failure reversals, and reference-based deduplication.
 *
 * Usage:
 *   const rail = new PaystackRail("sk_live_...", { currency: "NGN" });
 *   const agent = MnemoPay.quick("agent-1", { paymentRail: rail });
 *
 * Flows:
 *   1. Checkout:  createHold → user pays at authorization_url → capturePayment (verify)
 *   2. Saved card: createHold with authorizationCode → auto-charged → capturePayment (verify)
 *   3. Payout:    createTransferRecipient → initiateTransfer
 *   4. Webhook:   verifyWebhook → process event
 */

import type { PaymentRail, PaymentRailResult, HoldOptions } from "./index.js";
import { createHmac, timingSafeEqual } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PaystackCurrency = "NGN" | "GHS" | "ZAR" | "KES" | "USD";

export interface PaystackConfig {
  /** ISO currency code. Default: "NGN" */
  currency?: PaystackCurrency;
  /** Callback URL after checkout payment. Optional. */
  callbackUrl?: string;
  /** Base URL override (for testing). Default: "https://api.paystack.co" */
  baseUrl?: string;
  /** Request timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Channels to enable (card, bank, ussd, mobile_money, etc). Default: all */
  channels?: string[];
}

export interface PaystackHoldResult extends PaymentRailResult {
  /** Paystack authorization URL — redirect user here to pay */
  authorizationUrl?: string;
  /** Paystack access code */
  accessCode?: string;
  /** Unique reference for this transaction */
  reference: string;
}

export interface PaystackVerifyResult extends PaymentRailResult {
  /** Amount in major currency units (e.g., Naira, not kobo) */
  amount: number;
  /** Currency code */
  currency: PaystackCurrency;
  /** Customer email */
  customerEmail?: string;
  /** Reusable authorization for future charges */
  authorization?: {
    authorizationCode: string;
    cardType: string;
    last4: string;
    bank: string;
    reusable: boolean;
  };
  /** Transaction metadata */
  metadata?: Record<string, unknown>;
  /** Paystack gateway response */
  gatewayResponse?: string;
  /** Paid at timestamp */
  paidAt?: string;
}

export interface PaystackTransferRecipient {
  recipientCode: string;
  name: string;
  bankCode: string;
  accountNumber: string;
  currency: PaystackCurrency;
}

export interface PaystackTransferResult extends PaymentRailResult {
  /** Transfer reference */
  reference: string;
  /** Amount in major units */
  amount: number;
  /** Transfer status: pending, success, failed, reversed */
  transferStatus: string;
}

export interface PaystackWebhookEvent {
  event: string;
  data: Record<string, any>;
}

// ─── Paystack Rail ─────────────────────────────────────────────────────────

export class PaystackRail implements PaymentRail {
  readonly name = "paystack";
  private readonly secretKey: string;
  private readonly currency: PaystackCurrency;
  private readonly baseUrl: string;
  private readonly callbackUrl?: string;
  private readonly timeoutMs: number;
  private readonly channels?: string[];

  /** Reference-based idempotency guard with time-bounded eviction */
  private processedRefs: Map<string, number> = new Map(); // ref → timestamp
  /** In-flight captures to prevent concurrent verify races */
  private inFlightCaptures: Map<string, Promise<PaystackVerifyResult>> = new Map();
  private static readonly MAX_PROCESSED_REFS = 10_000;
  private static readonly REF_TTL_MS = 24 * 60 * 60_000; // 24h

  constructor(secretKey: string, config?: PaystackConfig) {
    if (!secretKey || typeof secretKey !== "string") {
      throw new Error("Paystack secret key is required");
    }
    if (!secretKey.startsWith("sk_")) {
      throw new Error("Invalid Paystack secret key format (must start with sk_)");
    }
    this.secretKey = secretKey;
    this.currency = config?.currency ?? "NGN";
    this.baseUrl = (config?.baseUrl ?? "https://api.paystack.co").replace(/\/$/, "");
    this.callbackUrl = config?.callbackUrl;
    this.timeoutMs = config?.timeoutMs ?? 30_000;
    this.channels = config?.channels;
  }

  // ── PaymentRail Interface ───────────────────────────────────────────────

  /**
   * Initialize a Paystack transaction (hold).
   *
   * If no authorizationCode is in metadata, returns an authorization_url
   * for checkout. If authorizationCode is present, charges the saved card
   * directly (no redirect needed).
   */
  async createHold(
    amount: number,
    reason: string,
    agentId: string,
    options?: HoldOptions,
  ): Promise<PaystackHoldResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Amount must be a positive finite number");
    }

    // Deterministic reference if provided, otherwise random
    const reference = (options?.metadata?.reference as string) || 
                     (options?.metadata?.idempotencyKey as string) ||
                     `mnemo_${agentId}_${Date.now()}_${require("crypto").randomBytes(4).toString("hex")}`;

    const amountInMinor = this.toMinorUnits(amount);
    const email = options?.email ?? `${agentId}@mnemopay.agent`;

    if (options?.authorizationCode) {
      // Charge saved card directly
      const response = await this.request("POST", "/transaction/charge_authorization", {
        authorization_code: options.authorizationCode,
        email,
        amount: amountInMinor,
        currency: this.currency,
        reference,
        metadata: {
          agentId,
          reason: reason.slice(0, 500),
          source: "mnemopay",
          ...options?.metadata,
        },
      });

      return {
        externalId: reference,
        status: response.data?.status ?? "pending",
        reference,
      };
    }

    // Initialize checkout transaction
    const payload: Record<string, unknown> = {
      email,
      amount: amountInMinor,
      currency: this.currency,
      reference,
      metadata: {
        agentId,
        reason: reason.slice(0, 500),
        source: "mnemopay",
        ...options?.metadata,
      },
    };

    if (this.callbackUrl) payload.callback_url = this.callbackUrl;
    if (this.channels) payload.channels = this.channels;

    const response = await this.request("POST", "/transaction/initialize", payload);

    return {
      externalId: reference,
      status: "initialized",
      authorizationUrl: response.data?.authorization_url,
      accessCode: response.data?.access_code,
      reference,
    };
  }

  /**
   * Verify/capture a Paystack transaction.
   * Call after user completes checkout or after charging saved card.
   */
  async capturePayment(externalId: string, _amount: number): Promise<PaystackVerifyResult> {
    if (!externalId || typeof externalId !== "string") {
      throw new Error("Transaction reference is required");
    }

    // Deduplicate concurrent captures for the same reference
    const inflight = this.inFlightCaptures.get(externalId);
    if (inflight) return inflight;

    const promise = this._doCapture(externalId);
    this.inFlightCaptures.set(externalId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightCaptures.delete(externalId);
    }
  }

  private async _doCapture(externalId: string): Promise<PaystackVerifyResult> {
    // Idempotency: check if already processed
    this._evictExpiredRefs();
    if (this.processedRefs.has(externalId)) {
      // Re-verify to return current state
      const response = await this.request("GET", `/transaction/verify/${encodeURIComponent(externalId)}`);
      return this.mapVerifyResponse(response, externalId);
    }

    const response = await this.request("GET", `/transaction/verify/${encodeURIComponent(externalId)}`);

    if (response.data?.status !== "success") {
      return {
        externalId,
        status: response.data?.status ?? "failed",
        amount: this.fromMinorUnits(response.data?.amount ?? 0),
        currency: response.data?.currency ?? this.currency,
        gatewayResponse: response.data?.gateway_response,
      };
    }

    // Mark as processed (idempotency guard)
    this.processedRefs.set(externalId, Date.now());

    return this.mapVerifyResponse(response, externalId);
  }

  /**
   * Refund a Paystack transaction.
   * Supports full and partial refunds.
   */
  async reversePayment(externalId: string, amount: number): Promise<PaymentRailResult> {
    if (!externalId || typeof externalId !== "string") {
      throw new Error("Transaction reference is required");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Refund amount must be a positive finite number");
    }

    // First verify the transaction exists and get Paystack's internal ID
    const verifyResponse = await this.request("GET", `/transaction/verify/${encodeURIComponent(externalId)}`);
    const txId = verifyResponse.data?.id;

    if (!txId) {
      throw new Error(`Transaction ${externalId} not found on Paystack`);
    }

    const response = await this.request("POST", "/refund", {
      transaction: txId,
      amount: this.toMinorUnits(amount),
    });

    // Remove from processed refs so it can be re-verified
    this.processedRefs.delete(externalId);

    return {
      externalId,
      status: response.data?.status ?? "pending",
      receiptId: response.data?.id?.toString(),
    };
  }

  // ── Paystack-Specific Methods ───────────────────────────────────────────

  /**
   * Create a transfer recipient (bank account for payouts).
   * Must be called before initiateTransfer.
   */
  async createTransferRecipient(
    name: string,
    accountNumber: string,
    bankCode: string,
    currency?: PaystackCurrency,
  ): Promise<PaystackTransferRecipient> {
    if (!name || !accountNumber || !bankCode) {
      throw new Error("Name, account number, and bank code are required");
    }

    // Resolve bank account first to verify it exists
    const resolveResponse = await this.request(
      "GET",
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );

    if (!resolveResponse.status) {
      throw new Error(`Could not resolve bank account: ${resolveResponse.message}`);
    }

    const cur = currency ?? this.currency;
    const response = await this.request("POST", "/transferrecipient", {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: cur,
    });

    return {
      recipientCode: response.data?.recipient_code,
      name: response.data?.details?.account_name ?? name,
      bankCode,
      accountNumber,
      currency: cur,
    };
  }

  /**
   * Initiate a bank transfer (payout).
   * The recipient must already be created via createTransferRecipient.
   */
  async initiateTransfer(
    recipientCode: string,
    amount: number,
    reason: string,
    agentId?: string,
    idempotencyKey?: string,
  ): Promise<PaystackTransferResult> {
    if (!recipientCode) throw new Error("Recipient code is required");
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Transfer amount must be a positive finite number");
    }

    const reference = idempotencyKey || 
                     `mnemo_xfer_${Date.now()}_${require("crypto").randomBytes(4).toString("hex")}`;

    const response = await this.request("POST", "/transfer", {
      source: "balance",
      amount: this.toMinorUnits(amount),
      recipient: recipientCode,
      reason: reason.slice(0, 500),
      reference,
      metadata: {
        agentId,
        source: "mnemopay",
      },
    });

    return {
      externalId: response.data?.transfer_code ?? reference,
      status: response.data?.status ?? "pending",
      reference,
      amount,
      transferStatus: response.data?.status ?? "pending",
    };
  }

  /**
   * Verify a webhook signature (HMAC-SHA512).
   * Returns the parsed event if valid, throws if signature mismatch.
   */
  verifyWebhook(rawBody: string | Buffer, signature: string): PaystackWebhookEvent {
    if (!signature) throw new Error("Webhook signature is required");
    if (!rawBody) throw new Error("Webhook body is required");

    const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");

    const expected = createHmac("sha512", this.secretKey)
      .update(bodyStr)
      .digest("hex");

    // Timing-safe comparison to prevent timing attacks
    const sigBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
      throw new Error("Invalid webhook signature");
    }

    const event = JSON.parse(bodyStr) as PaystackWebhookEvent;
    return event;
  }

  /**
   * Resolve a bank account — verify the account name matches.
   */
  async resolveBank(accountNumber: string, bankCode: string): Promise<{ accountName: string; accountNumber: string }> {
    const response = await this.request(
      "GET",
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );

    return {
      accountName: response.data?.account_name ?? "",
      accountNumber: response.data?.account_number ?? accountNumber,
    };
  }

  /**
   * List available banks for a given country/currency.
   */
  async listBanks(country = "nigeria", perPage = 100): Promise<Array<{ name: string; code: string }>> {
    const response = await this.request("GET", `/bank?country=${country}&perPage=${perPage}`);
    return (response.data ?? []).map((b: any) => ({
      name: b.name,
      code: b.code,
    }));
  }

  // ── Response Mapping ─────────────────────────────────────────────────────

  private mapVerifyResponse(response: any, externalId: string): PaystackVerifyResult {
    const data = response.data ?? {};
    const auth = data.authorization;

    return {
      externalId,
      status: data.status ?? "unknown",
      amount: this.fromMinorUnits(data.amount ?? 0),
      currency: data.currency ?? this.currency,
      customerEmail: data.customer?.email,
      authorization: auth ? {
        authorizationCode: auth.authorization_code,
        cardType: auth.card_type,
        last4: auth.last4,
        bank: auth.bank,
        reusable: auth.reusable ?? false,
      } : undefined,
      metadata: data.metadata,
      gatewayResponse: data.gateway_response,
      paidAt: data.paid_at,
      receiptId: data.id?.toString(),
    };
  }

  // ── Currency Conversion ─────────────────────────────────────────────────

  /**
   * Convert major currency units to minor units (e.g., Naira → kobo).
   * Paystack API expects amounts in minor units.
   */
  toMinorUnits(amount: number): number {
    return Math.round(amount * 100);
  }

  /**
   * Convert minor units back to major units (e.g., kobo → Naira).
   */
  fromMinorUnits(minorAmount: number): number {
    return Math.round(minorAmount) / 100;
  }

  // ── HTTP Client ─────────────────────────────────────────────────────────

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const json: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = json.message || json.error || "Request failed";
        throw new Error(`Paystack error: ${msg}`);
      }

      return json;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Paystack request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Evict expired refs to prevent unbounded memory growth */
  private _evictExpiredRefs(): void {
    if (this.processedRefs.size <= PaystackRail.MAX_PROCESSED_REFS / 2) return;
    const cutoff = Date.now() - PaystackRail.REF_TTL_MS;
    for (const [ref, ts] of this.processedRefs) {
      if (ts < cutoff) this.processedRefs.delete(ref);
    }
    // Hard cap: LRU eviction if still too many
    if (this.processedRefs.size > PaystackRail.MAX_PROCESSED_REFS) {
      const sorted = Array.from(this.processedRefs.entries()).sort((a, b) => a[1] - b[1]);
      for (const [ref] of sorted.slice(0, sorted.length - PaystackRail.MAX_PROCESSED_REFS)) {
        this.processedRefs.delete(ref);
      }
    }
  }
}

// ─── Nigerian Bank Codes (common) ──────────────────────────────────────────

export const NIGERIAN_BANKS: Record<string, string> = {
  "access":       "044",
  "citibank":     "023",
  "ecobank":      "050",
  "fidelity":     "070",
  "firstbank":    "011",
  "fcmb":         "214",
  "gtbank":       "058",
  "heritage":     "030",
  "keystone":     "082",
  "polaris":      "076",
  "providus":     "101",
  "stanbic":      "221",
  "standard":     "068",
  "sterling":     "232",
  "uba":          "033",
  "union":        "032",
  "unity":        "215",
  "wema":         "035",
  "zenith":       "057",
  "kuda":         "50211",
  "opay":         "999992",
  "palmpay":      "999991",
  "moniepoint":   "50515",
};
