/**
 * Claude Prompt Cache Integration — MnemoPay
 *
 * When recall results are fed into a Claude API system prompt, this module
 * emits them as a Claude-API-ready content block with a 1-hour ephemeral
 * cache_control hint. Callers who pass this block to the Anthropic Messages
 * API get the ~90% cache-read discount automatically on subsequent turns
 * within the 1-hour window.
 *
 * Key design invariant: the serialised text is *stable* — memories are sorted
 * by id before serialisation. Identical recall results → byte-identical text →
 * the cache prefix actually hits. (Anthropic's cache key is based on the
 * prefix bytes of the content array.)
 *
 * Pricing note (2026 Anthropic list rates, subject to change):
 *   Cache write (1h): 2× input price
 *   Cache read       : 0.1× input price  (≈ 90% saving)
 *
 * @module claude-cache
 */

import type { Memory } from "./index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A Claude Messages API content block with `cache_control` attached.
 * Pass this as an element inside the `content` array of a `system` message
 * (or user/assistant turn) to enable prompt caching.
 *
 * @example
 * ```ts
 * const anthropic = new Anthropic();
 * const block = MnemoPay.formatForClaudeCache(memories);
 *
 * const response = await anthropic.messages.create({
 *   model: "claude-opus-4-7",
 *   max_tokens: 1024,
 *   system: [
 *     {
 *       type: "text",
 *       text: "You are a helpful assistant.",
 *       cache_control: { type: "ephemeral" },
 *     },
 *     block,   // ← MnemoPay recall injected here; cached for 1 hour
 *   ],
 *   messages: [{ role: "user", content: userMessage }],
 * });
 * ```
 */
export interface ClaudeCacheBlock {
  type: "text";
  /**
   * Serialised recall payload. Memories sorted by id for prefix stability.
   * Format: `[Memory Cache]\n<id>: <content> (importance=<n>)\n...`
   */
  text: string;
  /**
   * Claude prompt cache control. `type: "ephemeral"` instructs Anthropic to
   * cache this prefix. The `ttl` field targets a 1-hour window (default when
   * omitted is ~5 minutes; passing "3600" extends this to 1 hour per the
   * Anthropic 2026 extended-TTL beta).
   */
  cache_control: {
    type: "ephemeral";
    /** Target TTL in seconds. 3600 = 1 hour. Requires Anthropic extended-TTL beta. */
    ttl: number;
  };
}

export interface FormatForClaudeCacheOptions {
  /**
   * Prefix written before the memory lines. Default: "[Memory Cache]"
   */
  prefix?: string;
  /**
   * Whether to include the memory score in the serialised text.
   * Default: false (score changes on every recall, breaking cache stability).
   */
  includeScore?: boolean;
  /**
   * Target cache TTL in seconds. Default: 3600 (1 hour).
   * Set to 300 for the standard 5-minute window (does not require beta access).
   */
  ttlSeconds?: number;
}

// ─── Serialisation ───────────────────────────────────────────────────────────

/**
 * Serialise an array of Memory objects into a stable string suitable for use
 * as a Claude prompt-cache prefix. Memories are sorted by id so that two
 * calls with the same memory set produce byte-identical output, regardless of
 * the order returned by `recall()`.
 *
 * The format is intentionally plain text (not JSON) to keep token count low.
 */
export function serializeMemoriesForCache(
  memories: Memory[],
  opts: FormatForClaudeCacheOptions = {},
): string {
  const prefix = opts.prefix ?? "[Memory Cache]";
  const includeScore = opts.includeScore ?? false;

  // Sort by id for prefix stability
  const sorted = [...memories].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const lines = sorted.map((m) => {
    let line = `${m.id}: ${m.content} (importance=${m.importance.toFixed(3)}`;
    if (includeScore) line += `, score=${m.score.toFixed(4)}`;
    if (m.tags && m.tags.length > 0) line += `, tags=${m.tags.join(",")}`;
    line += ")";
    return line;
  });

  return `${prefix}\n${lines.join("\n")}`;
}

/**
 * Convert an array of Memory objects into a Claude Messages API content block
 * with a `cache_control` hint for 1-hour ephemeral caching.
 *
 * The `text` field is stable across calls with the same memories (sorted by id),
 * so the Anthropic cache prefix will hit on subsequent turns within the TTL window.
 *
 * @param memories - Array of Memory objects from `agent.recall()`
 * @param opts     - Optional serialisation / TTL overrides
 * @returns        A `ClaudeCacheBlock` ready to pass to `anthropic.messages.create`
 */
export function formatForClaudeCache(
  memories: Memory[],
  opts: FormatForClaudeCacheOptions = {},
): ClaudeCacheBlock {
  const ttl = opts.ttlSeconds ?? 3600;
  return {
    type: "text",
    text: serializeMemoriesForCache(memories, opts),
    cache_control: {
      type: "ephemeral",
      ttl,
    },
  };
}
