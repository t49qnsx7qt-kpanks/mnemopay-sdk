/**
 * Per-Subagent Cost Attribution — MnemoPay Ledger Extension
 *
 * The Agent SDK pattern has a main Opus agent spawning Sonnet/Haiku subagents,
 * each with its own token cost. This module records those costs in MnemoPay's
 * double-entry ledger so you get a clean per-subagent breakdown for billing,
 * chargeback, or debugging — something no other framework provides today.
 *
 * Double-entry: every attribution debits the parent agent's "subagent_compute"
 * account and credits the subagent's "compute_earned" account.
 *
 * Pricing table (2026 Anthropic list rates — hardcoded here; update when rates
 * change. All values are USD per 1M tokens):
 *
 *   Model          | Input   | Output  | Cache read (0.1×)  | Cache write 1h (2×)
 *   ───────────────────────────────────────────────────────────────────────────
 *   claude-opus-4-7   $5.00    $25.00    $0.50                $10.00
 *   claude-sonnet-4-6 $3.00    $15.00    $0.30                $6.00
 *   claude-haiku-4-5  $1.00    $5.00     $0.10                $2.00
 *
 * Cache-write pricing: 1h window = 2× input price (per Anthropic extended-TTL
 * beta pricing). The standard 5-min window is 1.25× input price.
 *
 * @module subagent-cost
 */

import { Ledger } from "./ledger.js";
import type { Currency } from "./ledger.js";

// ─── Pricing Table ────────────────────────────────────────────────────────────
// USD per 1M tokens. Source: Anthropic 2026 list pricing.
// TODO: update if Anthropic changes rates; do not use these for customer billing
// without verifying against the current Anthropic pricing page.

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cache read price = fraction of input price. Anthropic: 0.1 (10%) */
  cacheReadMultiplier: number;
  /** Cache write at 5-min TTL = fraction of input price. Anthropic: 1.25 (125%) */
  cacheWrite5mMultiplier: number;
  /** Cache write at 1-hour TTL = fraction of input price. Anthropic: 2.0 (200%) */
  cacheWrite1hMultiplier: number;
}

/** 2026 Anthropic list rates. Update this table when rates change. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": {
    inputPerMillion: 5.00,
    outputPerMillion: 25.00,
    cacheReadMultiplier: 0.1,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2.0,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cacheReadMultiplier: 0.1,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2.0,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1.00,
    outputPerMillion: 5.00,
    cacheReadMultiplier: 0.1,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2.0,
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AttributeSubagentCostParams {
  /** ID of the orchestrating (parent) agent */
  parentAgentId: string;
  /** ID of the subagent that ran the inference */
  subagentId: string;
  /**
   * Human-readable role label, e.g. "lead-researcher", "formatter", "summarizer".
   * Stored in the ledger description for debugging; not used in cost math.
   */
  subagentRole: string;
  /**
   * Anthropic model ID. Must be a key in MODEL_PRICING, or the method throws.
   * If you need a model not in the table, add it to MODEL_PRICING above.
   */
  modelId: string;
  /** Regular (non-cached) input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Tokens read from the prompt cache (billed at 0.1× input rate) */
  cacheReadTokens?: number;
  /**
   * Tokens written to the prompt cache.
   * @param cacheWriteTtl - "5m" | "1h". Default "5m". Use "1h" for MnemoPay
   *   recall blocks formatted with `formatForClaudeCache(..., { ttlSeconds: 3600 })`.
   */
  cacheWriteTokens?: number;
  /** "5m" (default) or "1h". Determines which cache-write multiplier is applied. */
  cacheWriteTtl?: "5m" | "1h";
  /** ISO timestamp. Defaults to now. Used for time-range queries. */
  timestamp?: string;
}

export interface SubagentCostRecord extends AttributeSubagentCostParams {
  /** Computed total cost in USD for this attribution event */
  totalCostUsd: number;
  /**
   * USD saved versus paying full input price for cache-read tokens.
   * savingsUsd = cacheReadTokens × inputPrice × (1 - cacheReadMultiplier)
   */
  cacheSavingsUsd: number;
  /** Ledger txRef for the double-entry pair */
  txRef: string;
  /** ISO timestamp (echoed back from input or generated) */
  timestamp: string;
}

export interface SubagentCostBreakdownEntry {
  subagentId: string;
  subagentRole: string;
  modelId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Total USD saved due to cache reads across all attribution events */
  cacheSavingsUsd: number;
  /** Number of attribution events for this subagent */
  eventCount: number;
}

// ─── Cost computation ─────────────────────────────────────────────────────────

/**
 * Compute the USD cost for one inference event.
 * Returns `{ totalCostUsd, cacheSavingsUsd }`.
 */
export function computeSubagentCost(params: {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTtl?: "5m" | "1h";
}): { totalCostUsd: number; cacheSavingsUsd: number } {
  const pricing = MODEL_PRICING[params.modelId];
  if (!pricing) {
    throw new Error(
      `Unknown modelId "${params.modelId}". Add it to MODEL_PRICING in subagent-cost.ts.`,
    );
  }

  const {
    inputTokens,
    outputTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    cacheWriteTtl = "5m",
  } = params;

  // Validate
  if (!Number.isFinite(inputTokens) || inputTokens < 0) throw new Error("inputTokens must be >= 0");
  if (!Number.isFinite(outputTokens) || outputTokens < 0) throw new Error("outputTokens must be >= 0");
  if (!Number.isFinite(cacheReadTokens) || cacheReadTokens < 0) throw new Error("cacheReadTokens must be >= 0");
  if (!Number.isFinite(cacheWriteTokens) || cacheWriteTokens < 0) throw new Error("cacheWriteTokens must be >= 0");

  const M = 1_000_000; // per-million divisor

  const inputCost = (inputTokens / M) * pricing.inputPerMillion;
  const outputCost = (outputTokens / M) * pricing.outputPerMillion;
  const cacheReadCost = (cacheReadTokens / M) * pricing.inputPerMillion * pricing.cacheReadMultiplier;
  const cacheWriteMultiplier = cacheWriteTtl === "1h"
    ? pricing.cacheWrite1hMultiplier
    : pricing.cacheWrite5mMultiplier;
  const cacheWriteCost = (cacheWriteTokens / M) * pricing.inputPerMillion * cacheWriteMultiplier;

  // Savings: what you would have paid at full input rate vs what you actually paid
  const cacheReadFullCost = (cacheReadTokens / M) * pricing.inputPerMillion;
  const cacheSavingsUsd = Math.max(0, cacheReadFullCost - cacheReadCost);

  const totalCostUsd = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000, // micro-dollar precision
    cacheSavingsUsd: Math.round(cacheSavingsUsd * 1_000_000) / 1_000_000,
  };
}

// ─── SubagentCostTracker ──────────────────────────────────────────────────────

/**
 * Per-subagent cost attribution for multi-agent pipelines.
 *
 * Wraps a `Ledger` instance to add cost-aware double-entry records and
 * query methods. Can be used standalone or accessed via `MnemoPayLite` /
 * `MnemoPay` (exposed as `agent.subagentCosts`).
 *
 * @example
 * ```ts
 * import MnemoPay, { SubagentCostTracker } from "@mnemopay/sdk";
 *
 * const agent = MnemoPay.quick("orchestrator");
 * const tracker = new SubagentCostTracker(agent.ledger);
 *
 * // After a Claude API call by a subagent:
 * tracker.attributeSubagentCost({
 *   parentAgentId: "orchestrator",
 *   subagentId: "researcher-1",
 *   subagentRole: "researcher",
 *   modelId: "claude-sonnet-4-6",
 *   inputTokens: 2000,
 *   outputTokens: 800,
 *   cacheReadTokens: 8500,   // from MnemoPay recall block
 *   cacheWriteTokens: 500,
 *   cacheWriteTtl: "1h",
 * });
 *
 * const breakdown = tracker.subagentCostBreakdown("orchestrator");
 * // → [{ subagentId: "researcher-1", totalCostUsd: 0.000945, cacheSavingsUsd: 0.002295, ... }]
 * ```
 */
export class SubagentCostTracker {
  private ledger: Ledger;
  /** In-memory store for structured cost records (ledger holds the financial entries) */
  private records: SubagentCostRecord[] = [];

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /**
   * Record a subagent inference cost as a double-entry ledger pair.
   *
   * Debit : `subagent_compute:{parentAgentId}` — the parent bears the cost
   * Credit: `compute_earned:{subagentId}`      — the subagent "earned" the work
   *
   * @returns The full `SubagentCostRecord` including computed cost and txRef
   */
  attributeSubagentCost(params: AttributeSubagentCostParams): SubagentCostRecord {
    const { totalCostUsd, cacheSavingsUsd } = computeSubagentCost({
      modelId: params.modelId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      cacheWriteTtl: params.cacheWriteTtl,
    });

    const timestamp = params.timestamp ?? new Date().toISOString();
    const currency: Currency = "USD";

    // Minimum ledger amount guard: skip zero-cost events (e.g. tiny token counts)
    // but record the structured record for query purposes with a sentinel amount.
    const ledgerAmount = Math.max(totalCostUsd, 0.000001);

    const { txRef } = this.ledger.transfer(
      `subagent_compute:${params.parentAgentId}`,
      `compute_earned:${params.subagentId}`,
      ledgerAmount,
      currency,
      `Subagent cost: ${params.subagentRole} (${params.modelId}) — ` +
        `in=${params.inputTokens} out=${params.outputTokens} ` +
        `cacheRead=${params.cacheReadTokens ?? 0} cacheWrite=${params.cacheWriteTokens ?? 0}`,
    );

    const record: SubagentCostRecord = {
      ...params,
      totalCostUsd,
      cacheSavingsUsd,
      txRef,
      timestamp,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Return a cost breakdown per subagent for a given parent agent, ordered by
   * total cost descending (most expensive subagent first).
   *
   * @param parentAgentId - The orchestrating agent's ID
   * @param opts.sinceTs  - ISO timestamp lower bound (inclusive)
   * @param opts.untilTs  - ISO timestamp upper bound (inclusive)
   */
  subagentCostBreakdown(
    parentAgentId: string,
    opts: { sinceTs?: string; untilTs?: string } = {},
  ): SubagentCostBreakdownEntry[] {
    const filtered = this.records.filter((r) => {
      if (r.parentAgentId !== parentAgentId) return false;
      if (opts.sinceTs && r.timestamp < opts.sinceTs) return false;
      if (opts.untilTs && r.timestamp > opts.untilTs) return false;
      return true;
    });

    const map = new Map<string, SubagentCostBreakdownEntry>();

    for (const r of filtered) {
      const existing = map.get(r.subagentId);
      if (existing) {
        existing.totalCostUsd += r.totalCostUsd;
        existing.totalInputTokens += r.inputTokens;
        existing.totalOutputTokens += r.outputTokens;
        existing.cacheSavingsUsd += r.cacheSavingsUsd;
        existing.eventCount += 1;
      } else {
        map.set(r.subagentId, {
          subagentId: r.subagentId,
          subagentRole: r.subagentRole,
          modelId: r.modelId,
          totalCostUsd: r.totalCostUsd,
          totalInputTokens: r.inputTokens,
          totalOutputTokens: r.outputTokens,
          cacheSavingsUsd: r.cacheSavingsUsd,
          eventCount: 1,
        });
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  /**
   * All raw attribution records for a parent agent, newest first.
   * Useful for per-call inspection and audit trails.
   */
  getRecords(parentAgentId: string): SubagentCostRecord[] {
    return this.records
      .filter((r) => r.parentAgentId === parentAgentId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Total accumulated cost across all subagents for a parent */
  totalCost(parentAgentId: string): number {
    return this.records
      .filter((r) => r.parentAgentId === parentAgentId)
      .reduce((sum, r) => sum + r.totalCostUsd, 0);
  }

  /** Total cache savings across all subagents for a parent */
  totalCacheSavings(parentAgentId: string): number {
    return this.records
      .filter((r) => r.parentAgentId === parentAgentId)
      .reduce((sum, r) => sum + r.cacheSavingsUsd, 0);
  }
}
