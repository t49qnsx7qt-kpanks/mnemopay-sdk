/**
 * Observations — per-entity consolidated summaries.
 *
 * Derived from vectorize-io/hindsight (https://github.com/vectorize-io/hindsight),
 * MIT License, Copyright (c) 2025 Vectorize AI, Inc. The above copyright
 * notice and the MIT permission notice (see NOTICE file at repo root) are
 * included here in accordance with the MIT license terms.
 *
 * Ported from the vectorize-io/hindsight write-path pattern. For every entity
 * an agent has ever mentioned we keep a dense factual digest that rolls up
 * every fact tied to that entity. Three problems this solves on
 * LongMemEval-style benchmarks:
 *
 *   1. Knowledge-update — when a fact about entity E is replaced, the entity
 *      observation is regenerated so the answerer sees the current state
 *      instead of two contradictory raw memories.
 *   2. Preference — opinion/preference statements scattered across many
 *      sessions get collapsed into a single "User prefers … about E" block
 *      that retrieval can fetch with one hit.
 *   3. Multi-session — entity-keyed observations survive across sessions;
 *      the raw turns that produced them can be pruned by the consolidation
 *      sweep without losing the bottom-line conclusions.
 *
 * Regeneration is debounced: the hash of the sorted fact-IDs feeding the
 * entity is stored alongside the summary, and we skip regeneration when the
 * hash is unchanged AND the last regeneration was less than
 * `MIN_REGEN_INTERVAL_MS` ago. This prevents thrash when many facts about
 * the same entity land in quick succession (e.g. a session ingest loop).
 *
 * LLM provider is reused from `./summarizer.ts` — same groq/anthropic switch,
 * same API-key resolution. Never hard-codes a specific provider.
 */

import type { Memory, FactType } from "../index.js";
import {
  summarizeSession,
  type SummarizerOptions,
  type SessionTurn,
} from "./summarizer.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ObservationRow {
  /** Canonical entity id (graph node id or caller-provided string). */
  entityId: string;
  /** Dense factual digest produced by the summarizer. */
  summary: string;
  /** Hash of the sorted fact-IDs that fed the summary. Drives debounce. */
  factsHash: string;
  /** Unix ms of last regeneration. */
  updatedAt: number;
}

export interface RegenerateOptions {
  /** Unix ms of "now"; defaults to Date.now(). Overridable for tests. */
  now?: number;
  /** Summarizer options (provider, model, apiKey). Reused from summarizer.ts. */
  summarizer?: SummarizerOptions;
  /**
   * Skip LLM and return the joined facts directly. Used when no API key is
   * available — we still produce an observation so retrieval has something
   * entity-keyed to hoist, but it will not be as compact. Default true when
   * no API key env var is set.
   */
  offline?: boolean;
  /**
   * Minimum ms between regenerations. Defaults to 30_000. Lower in tests.
   */
  minIntervalMs?: number;
}

export interface EnqueueObservationRegenParams {
  /** Agent id — scopes the observation store so multi-tenant agents never collide. */
  agentId: string;
  entityId: string;
  /** Full memory map of the agent (id → Memory). We filter by entityId here. */
  memories: Map<string, Memory>;
  options?: RegenerateOptions;
}

// ─── In-process stores ──────────────────────────────────────────────────────
// Keyed by `${agentId}::${entityId}`. Kept in-module so all agents share one
// Map without importing an adapter. A future adapter hook (below) makes it
// trivial to swap in SQLite-backed persistence.

const observationStore = new Map<string, ObservationRow>();

/** Optional persistence adapter hook. Set by the SQLite layer if available. */
export interface ObservationAdapter {
  upsert: (agentId: string, row: ObservationRow) => void;
  get: (agentId: string, entityId: string) => ObservationRow | null;
}
let adapter: ObservationAdapter | null = null;

/** Install a persistence adapter. Subsequent upserts will also hit it. */
export function registerObservationAdapter(a: ObservationAdapter | null): void {
  adapter = a;
}

const MIN_REGEN_INTERVAL_MS = 30_000;

// ─── Hashing ────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit, good enough for debounce keying. */
function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Canonical hash of a set of fact IDs. Sort first so insertion order doesn't
 * cause a spurious regeneration.
 */
export function hashFactIds(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return fnv1a(sorted.join("|"));
}

// ─── Fact selection ─────────────────────────────────────────────────────────

/**
 * Pick the facts that should feed the observation for `entityId`.
 *
 * Inclusion rule: memory.entityIds includes entityId. Observation memories are
 * excluded (they're the output, not the input). Facts are ordered by
 * createdAt asc so the summary reads chronologically.
 */
export function selectFactsForEntity(
  entityId: string,
  memories: Map<string, Memory>,
): Memory[] {
  const out: Memory[] = [];
  for (const m of memories.values()) {
    if ((m.factType as FactType | undefined) === "observation") continue;
    if (Array.isArray(m.entityIds) && m.entityIds.includes(entityId)) {
      out.push(m);
    }
  }
  out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return out;
}

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Regenerate the observation for `entityId` from the supplied facts.
 *
 * Debounced: if the fact-IDs hash matches the stored observation AND the
 * last regeneration was within `minIntervalMs`, the call is a no-op and
 * returns the existing row.
 */
export async function regenerateObservation(
  entityId: string,
  facts: Memory[],
  agentId = "default",
  options: RegenerateOptions = {},
): Promise<ObservationRow | null> {
  if (!entityId || facts.length === 0) return null;
  const key = storeKey(agentId, entityId);
  const now = options.now ?? Date.now();
  const minInterval = options.minIntervalMs ?? MIN_REGEN_INTERVAL_MS;

  const hash = hashFactIds(facts.map((f) => f.id));
  const existing = observationStore.get(key) ?? adapter?.get(agentId, entityId) ?? null;

  if (existing && existing.factsHash === hash && now - existing.updatedAt < minInterval) {
    // Debounced — nothing changed + fresh enough.
    return existing;
  }

  let summary: string;
  try {
    summary = await runSummarizer(facts, entityId, options);
  } catch {
    // LLM failure → keep any existing summary rather than overwrite with garbage.
    if (existing) return existing;
    summary = offlineSummary(facts, entityId);
  }

  const row: ObservationRow = {
    entityId,
    summary,
    factsHash: hash,
    updatedAt: now,
  };
  observationStore.set(key, row);
  if (adapter) {
    try {
      adapter.upsert(agentId, row);
    } catch {
      /* best-effort */
    }
  }
  return row;
}

/**
 * Read a cached observation. Prefers the in-process store; falls back to the
 * registered adapter. Returns null if the entity has never been summarized.
 */
export function getObservation(entityId: string, agentId = "default"): ObservationRow | null {
  const key = storeKey(agentId, entityId);
  const hit = observationStore.get(key);
  if (hit) return hit;
  if (adapter) {
    const row = adapter.get(agentId, entityId);
    if (row) {
      observationStore.set(key, row);
      return row;
    }
  }
  return null;
}

/**
 * Write-path hook: enqueue a regeneration for the entity. Fire-and-forget.
 * Called from `MnemoPayLite.remember()` once per touched entity.
 */
export async function enqueueObservationRegen(
  params: EnqueueObservationRegenParams,
): Promise<ObservationRow | null> {
  const facts = selectFactsForEntity(params.entityId, params.memories);
  if (facts.length === 0) return null;
  return regenerateObservation(params.entityId, facts, params.agentId, params.options);
}

/** Reset the in-process store — test helper only. */
export function _resetObservationStoreForTests(): void {
  observationStore.clear();
}

// ─── Internals ──────────────────────────────────────────────────────────────

function storeKey(agentId: string, entityId: string): string {
  return `${agentId}::${entityId}`;
}

/**
 * Shape the facts into a synthetic transcript and call the existing
 * summarizer. Reusing `summarizeSession` keeps the LLM-provider choice in
 * one place (summarizer.ts). When no API key is configured for either
 * provider, fall back to offline mode so tests + zero-infra setups still
 * produce an observation.
 */
async function runSummarizer(
  facts: Memory[],
  entityId: string,
  options: RegenerateOptions,
): Promise<string> {
  const offlineRequested = options.offline === true;
  const hasApiKey =
    options.summarizer?.apiKey ||
    process.env.GROQ_API_KEY ||
    process.env.ANTHROPIC_API_KEY;
  if (offlineRequested || !hasApiKey) {
    return offlineSummary(facts, entityId);
  }

  const turns: SessionTurn[] = facts.map((f) => ({
    role: "user",
    content: f.content,
  }));
  const summary = await summarizeSession(turns, {
    ...(options.summarizer ?? {}),
    // Override the date label with the entity identifier so the LLM knows
    // what the summary is "about".
    date: `Entity: ${entityId}`,
  });
  return summary || offlineSummary(facts, entityId);
}

/**
 * Offline fallback summary — pragmatic, deterministic, no LLM required.
 * Used when no API key is configured (e.g. unit tests, zero-infra setups).
 * Format: one line per fact, most recent last, capped at 2KB.
 */
function offlineSummary(facts: Memory[], entityId: string): string {
  const lines = facts.map((f) => `- ${f.content}`);
  const body = lines.join("\n");
  const capped = body.length > 2048 ? body.slice(0, 2045) + "..." : body;
  return `[Observation of ${entityId}]\n${capped}`;
}
