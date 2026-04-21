/**
 * Pluggable Recall Engine — adds semantic search to MnemoPay.
 *
 * Strategies:
 *   "score"   — Current: importance × recency × frequency (default, zero deps)
 *   "vector"  — Embeddings-based cosine similarity (requires OpenAI or local provider)
 *   "hybrid"  — Score + Vector combined (best quality, higher latency)
 *
 * This implementation enhances "hybrid" by combining:
 *   - SQLite FTS5 full-text search (candidate preselection)
 *   - Vector cosine similarity (semantic scoring)
 *   - Merge/deduplicate by memory ID and return top-k
 */

// ─── Types ──────────────────────────────────────────────────────────────────

import type { PersistenceAdapter, PersistenceOptions } from "./persistence/types.js";
import { MemoryAdapter } from "./persistence/memory.js";
import { NeonAdapter } from "./persistence/neon.js";

export type RecallStrategy = "score" | "vector" | "hybrid";

export type EmbeddingProvider = "openai" | "local" | "bge";

export type { PersistenceAdapter, PersistenceOptions } from "./persistence/types.js";

// BGE embedder timing + model info, populated lazily on first call
export const bgeStats = {
  model: "Xenova/bge-small-en-v1.5",
  dimensions: 384,
  loadTimeMs: 0,
  totalEmbedTimeMs: 0,
  embedCount: 0,
  loaded: false,
};

export interface RecallEngineConfig {
  strategy: RecallStrategy;
  /** Embedding provider for vector/hybrid modes */
  embeddingProvider?: EmbeddingProvider;
  /** OpenAI API key (required if provider is "openai") */
  openaiApiKey?: string;
  /** OpenAI embedding model (default: "text-embedding-3-small") */
  embeddingModel?: string;
  /** Embedding dimensions (default: 1536 for OpenAI, 384 for local) */
  dimensions?: number;

  /** Weight for score component in hybrid mode (0-1, default: 0.4) */
  scoreWeight?: number;
  /** Weight for vector component in hybrid mode (0-1, default: 0.6) */
  vectorWeight?: number;

  /**
   * SQLite FTS5 adapter (optional).
   * When provided and strategy is "hybrid", we preselect candidates with FTS5.
   */
  sqliteStorage?: {
    searchMemoriesFTS: (params: {
      agentId: string;
      query: string;
      limit: number;
    }) => Array<{
      id: string;
      content: string;
      importance: number;
      score: number;
      createdAt: Date;
      lastAccessed: Date;
      accessCount: number;
      tags: string[];
      ftsScore: number;
    }>;
  };

  /** Agent id used to scope the SQLite FTS5 search */
  sqliteAgentId?: string;

  /** Candidate cap pulled from FTS5 for vector re-ranking (default: 50) */
  ftsCandidateLimit?: number;

  /** Multiplier for vector candidate count (default: 3). Higher = wider net. */
  vectorKMultiplier?: number;

  /**
   * Weight for FTS signal when hybrid+FTS is used (default: 0.15).
   * FTS score is converted into a [0..1]-ish similarity-ish scalar.
   */
  ftsWeight?: number;

  /**
   * Persistence adapter for vector storage. Defaults to an in-process
   * MemoryAdapter (zero deps). Pass `{ type: "neon", url }` to persist in
   * Neon/Postgres via pgvector, or a pre-built adapter via
   * `{ type: "custom", adapter }`. Orthogonal to the embedding provider.
   */
  persist?: PersistenceOptions | PersistenceAdapter;

  /**
   * Agent id used to scope persisted rows. Required when `persist.type` is
   * "neon" so that rows from different agents never collide. Defaults to
   * "default" for the in-process MemoryAdapter so existing callers keep
   * working without changes.
   */
  agentId?: string;
}

export interface VectorMemory {
  id: string;
  content: string;
  importance: number;
  embedding: Float32Array;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
}

export interface RecallResult {
  id: string;
  content: string;
  importance: number;
  score: number;
  vectorScore?: number;
  combinedScore: number;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
}

// ─── Math: Cosine Similarity ────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length)
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) return 0;
  return dot / denom;
}

// ─── Math: L2 Normalize ────────────────────────────────────────────────────

export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) result[i] = vec[i] / norm;
  return result;
}

// ─── Local Embedding (TF-IDF bag-of-words, zero dependencies) ──────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "about",
  "up",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "what",
  "which",
  "who",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Preference synonyms — expand at embed time so "favorite" matches "love/prefer/enjoy"
const PREFERENCE_SYNONYMS: Record<string, string[]> = {
  favorite: ["prefer", "love", "enjoy", "like"],
  prefer: ["favorite", "love", "enjoy", "like"],
  love: ["favorite", "prefer", "enjoy", "like"],
  enjoy: ["favorite", "prefer", "love", "like"],
  like: ["favorite", "prefer", "love", "enjoy"],
  hate: ["dislike", "avoid", "detest"],
  dislike: ["hate", "avoid"],
  allergic: ["allergy", "intolerant", "avoid", "restrict"],
  restriction: ["restrict", "allergic", "avoid", "diet"],
};

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

export function localEmbed(text: string, dimensions = 384): Float32Array {
  const baseTokens = tokenize(text);

  // Expand with preference synonyms
  const expanded = new Set(baseTokens);
  for (const tok of baseTokens) {
    const syns = Object.hasOwn(PREFERENCE_SYNONYMS, tok) ? PREFERENCE_SYNONYMS[tok] : undefined;
    if (Array.isArray(syns)) for (const s of syns) expanded.add(s);
  }
  const tokens = Array.from(expanded);

  const vec = new Float32Array(dimensions);

  const addToken = (token: string, weightScale: number) => {
    const h = fnv1a(token);
    const idx1 = Math.abs(h) % dimensions;
    const idx2 = Math.abs(h * 31) % dimensions;
    const idx3 = Math.abs(h * 97) % dimensions;
    const w = weightScale * (1 + Math.log(token.length));
    vec[idx1] += w;
    vec[idx2] += w * 0.5;
    vec[idx3] += w * 0.3;
    if (token.length > 4) {
      const prefix = token.slice(0, 4);
      const ph = fnv1a(prefix);
      vec[Math.abs(ph) % dimensions] += w * 0.3;
      vec[Math.abs(ph * 31) % dimensions] += w * 0.15;
    }
  };

  // Unigrams
  for (const token of tokens) addToken(token, 1.0);

  // Bigrams (adjacent pairs from original tokens — captures phrases like "favorite food")
  for (let i = 0; i < baseTokens.length - 1; i++) {
    addToken(`${baseTokens[i]}_${baseTokens[i + 1]}`, 0.7);
  }

  // Trigrams for key phrases
  for (let i = 0; i < baseTokens.length - 2; i++) {
    addToken(`${baseTokens[i]}_${baseTokens[i + 1]}_${baseTokens[i + 2]}`, 0.4);
  }

  return l2Normalize(vec);
}

// ─── BGE Embedding (local ONNX via @xenova/transformers) ────────────────────

let bgeExtractor: ((text: string, opts: any) => Promise<{ data: Float32Array }>) | null = null;

async function bgeEmbed(text: string): Promise<Float32Array> {
  if (!bgeExtractor) {
    const t0 = Date.now();
    const { pipeline, env } = await import("@xenova/transformers");
    const localPath = process.env.BGE_LOCAL_MODEL_PATH;
    if (localPath) {
      env.localModelPath = localPath;
      env.allowRemoteModels = false;
    }
    bgeExtractor = (await pipeline(
      "feature-extraction",
      bgeStats.model,
    )) as unknown as (text: string, opts: any) => Promise<{ data: Float32Array }>;
    bgeStats.loadTimeMs = Date.now() - t0;
    bgeStats.loaded = true;
  }
  const t0 = Date.now();
  const output = await bgeExtractor(text, { pooling: "mean", normalize: true });
  bgeStats.totalEmbedTimeMs += Date.now() - t0;
  bgeStats.embedCount++;
  const vec = output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
  if (vec.length !== bgeStats.dimensions) {
    throw new Error(`BGE dimensions mismatch: got ${vec.length}, expected ${bgeStats.dimensions}`);
  }
  return vec;
}

// ─── OpenAI Embedding ───────────────────────────────────────────────────────

async function openaiEmbed(
  text: string,
  apiKey: string,
  model = "text-embedding-3-small"
): Promise<Float32Array> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: text, model }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OpenAI Embeddings ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) throw new Error("No embedding returned");
  return new Float32Array(embedding);
}

// ─── Recall Engine ──────────────────────────────────────────────────────────

const PREFERENCE_FTS_INJECTIONS = [
  "prefer",
  "favorite",
  "love",
  "like",
  "enjoy",
  "use",
];

function sanitizeFTS5Query(rawQuery: string, injectPreference = false): string {
  // Keep underscores to allow exact tokens like TOPIC_FACT_123 to survive sanitation.
  const cleaned = (rawQuery ?? "")
    .toString()
    .replace(/[^a-zA-Z0-9_\s]/g, " "); // keep alnum + underscore + spaces only

  const tokens = cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return "";

  // For preference-intent queries ("recommend resources for video editing"), the
  // query rarely shares a content word with memories like "I use Adobe Premiere".
  // Inject preference verbs so BM25 can reach those statements via OR matching.
  const finalTokens = injectPreference
    ? Array.from(new Set([...tokens, ...PREFERENCE_FTS_INJECTIONS]))
    : tokens;

  // FTS5: build a simple OR query: token1 OR token2 OR ...
  return finalTokens.join(" OR ");
}

function resolvePersistence(
  persist: PersistenceOptions | PersistenceAdapter | undefined,
): { adapter: PersistenceAdapter; ownsAdapter: boolean } {
  // Heuristic: a full adapter has all five required methods.
  if (
    persist &&
    typeof (persist as PersistenceAdapter).set === "function" &&
    typeof (persist as PersistenceAdapter).get === "function" &&
    typeof (persist as PersistenceAdapter).delete === "function" &&
    typeof (persist as PersistenceAdapter).search === "function" &&
    typeof (persist as PersistenceAdapter).close === "function"
  ) {
    return { adapter: persist as PersistenceAdapter, ownsAdapter: false };
  }

  const opts = (persist as PersistenceOptions | undefined) ?? { type: "memory" };
  switch (opts.type) {
    case "memory":
      return { adapter: new MemoryAdapter(), ownsAdapter: true };
    case "custom":
      return { adapter: opts.adapter, ownsAdapter: false };
    case "neon": {
      // NeonAdapter is safe to import eagerly: it only dynamic-imports `pg`
      // inside getPool(), so adapter construction is zero-cost and does not
      // require `pg` to be installed until the first set/get/search call.
      return {
        adapter: new NeonAdapter({
          url: opts.url,
          table: opts.table,
          skipBootstrap: opts.skipBootstrap,
        }),
        ownsAdapter: true,
      };
    }
    default: {
      const _exhaustive: never = opts;
      throw new Error(`RecallEngine: unknown persist option: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export class RecallEngine {
  private config: Required<Omit<RecallEngineConfig, "persist" | "agentId">> & {
    agentId: string;
  };
  private adapter: PersistenceAdapter;
  private ownsAdapter: boolean;
  /**
   * Write-through cache of embeddings keyed by memory id.
   *
   * Populated on every `embed()` / `getOrEmbed()` and consulted during
   * `search()` re-ranking so the hot path stays fast regardless of backend.
   * For the memory adapter this is effectively a no-op mirror; for Neon it
   * avoids N serial round-trips per recall.
   */
  private vectors: Map<string, Float32Array> = new Map();
  /**
   * Content cache — needed so we can write-through to the adapter on every
   * embed() call (the adapter stores content+embedding+metadata atomically).
   * Falls back to "" when we only have an id.
   */
  private contents: Map<string, string> = new Map();

  constructor(config: Partial<RecallEngineConfig> = {}) {
    const { adapter, ownsAdapter } = resolvePersistence(config.persist);
    this.adapter = adapter;
    this.ownsAdapter = ownsAdapter;

    this.config = {
      strategy: config.strategy ?? "score",
      embeddingProvider: config.embeddingProvider ?? "local",
      openaiApiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "",
      embeddingModel: config.embeddingModel ?? "text-embedding-3-small",
      dimensions:
        config.dimensions ??
        (config.embeddingProvider === "openai" ? 1536 : 384),
      scoreWeight: config.scoreWeight ?? 0.4,
      vectorWeight: config.vectorWeight ?? 0.6,
      sqliteStorage: (config.sqliteStorage as any) ?? undefined,
      sqliteAgentId: config.sqliteAgentId ?? "",
      ftsCandidateLimit: config.ftsCandidateLimit ?? 50,
      ftsWeight: config.ftsWeight ?? 0.15,
      vectorKMultiplier: config.vectorKMultiplier ?? 3,
      agentId: config.agentId ?? "default",
    } as Required<Omit<RecallEngineConfig, "persist" | "agentId">> & { agentId: string };

    const weightSum = this.config.scoreWeight + this.config.vectorWeight;
    if (Math.abs(weightSum - 1.0) > 0.01) {
      throw new Error(
        `Hybrid weights must sum to ~1.0 (got ${weightSum.toFixed(2)})`
      );
    }

    if (
      this.config.strategy !== "score" &&
      this.config.embeddingProvider === "openai" &&
      !this.config.openaiApiKey
    ) {
      throw new Error(
        "OpenAI API key required for vector/hybrid recall strategy with OpenAI provider"
      );
    }
  }

  get strategy(): RecallStrategy {
    return this.config.strategy;
  }

  async embed(
    id: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<Float32Array> {
    let vec: Float32Array;

    if (this.config.embeddingProvider === "openai" && this.config.openaiApiKey) {
      try {
        vec = await openaiEmbed(
          content,
          this.config.openaiApiKey,
          this.config.embeddingModel,
        );
      } catch (e: any) {
        console.warn(
          `[mnemopay:recall] OpenAI embedding failed, falling back to local provider: ${
            e?.message ?? String(e)
          }`,
        );
        vec = localEmbed(content, this.config.dimensions);
      }
    } else if (this.config.embeddingProvider === "bge") {
      vec = await bgeEmbed(content);
    } else {
      vec = localEmbed(content, this.config.dimensions);
    }

    this.vectors.set(id, vec);
    this.contents.set(id, content);
    // Write-through to the persistence adapter. For MemoryAdapter this is
    // effectively a local store mirror; for Neon it executes one INSERT.
    await this.adapter.set(this.config.agentId, id, content, vec, metadata);
    return vec;
  }

  async getOrEmbed(id: string, content: string): Promise<Float32Array> {
    const cached = this.vectors.get(id);
    if (cached) return cached;

    // Cache miss: try the persistence adapter before re-embedding.
    // This matters for Neon — a freshly constructed engine can reuse
    // embeddings that were written in a previous process.
    try {
      const row = await this.adapter.get(this.config.agentId, id);
      if (row && row.embedding.length > 0) {
        this.vectors.set(id, row.embedding);
        this.contents.set(id, row.content);
        return row.embedding;
      }
    } catch {
      // Fall through to re-embed on adapter failure. Errors on the write
      // path in embed() will surface the underlying problem clearly.
    }

    return this.embed(id, content);
  }

  remove(id: string): void {
    this.vectors.delete(id);
    this.contents.delete(id);
    // Fire-and-forget adapter delete. The MemoryAdapter resolves synchronously;
    // Neon resolves async but we do not await to keep the signature sync-compatible
    // with the original Map-based API (callers may chain `await` via `removeAsync`).
    const p = this.adapter.delete(this.config.agentId, id);
    void p.catch(() => {
      /* surface errors via next adapter call */
    });
  }

  /** Async variant of remove() that awaits the adapter delete. */
  async removeAsync(id: string): Promise<void> {
    this.vectors.delete(id);
    this.contents.delete(id);
    await this.adapter.delete(this.config.agentId, id);
  }

  removeBatch(ids: string[]): void {
    for (const id of ids) {
      this.vectors.delete(id);
      this.contents.delete(id);
      const p = this.adapter.delete(this.config.agentId, id);
      void p.catch(() => {
        /* surface errors via next adapter call */
      });
    }
  }

  purgeStaleVectors(validIds: Set<string>): number {
    let purged = 0;
    for (const id of this.vectors.keys()) {
      if (!validIds.has(id)) {
        this.vectors.delete(id);
        this.contents.delete(id);
        const p = this.adapter.delete(this.config.agentId, id);
        void p.catch(() => {
          /* surface errors via next adapter call */
        });
        purged++;
      }
    }
    return purged;
  }

  clear(): void {
    this.vectors.clear();
    this.contents.clear();
    // Adapter clear is not part of the PersistenceAdapter interface because
    // semantics vary (MemoryAdapter clears one agent; Neon would truncate).
    // For the built-in MemoryAdapter we clear the agent bucket explicitly.
    if (this.adapter instanceof MemoryAdapter) {
      this.adapter.clearAgent(this.config.agentId);
    }
  }

  /**
   * Release adapter resources (e.g. close the Neon pool).
   * Safe to call multiple times; callers should always invoke this when
   * shutting down a long-lived process.
   */
  async close(): Promise<void> {
    if (this.ownsAdapter) {
      await this.adapter.close();
    }
  }

  /** Expose the underlying adapter for advanced use cases and tests. */
  getAdapter(): PersistenceAdapter {
    return this.adapter;
  }

  private embedQuery(query: string): Promise<Float32Array> {
    if (this.config.embeddingProvider === "openai" && this.config.openaiApiKey) {
      return openaiEmbed(
        query,
        this.config.openaiApiKey,
        this.config.embeddingModel,
      ).catch((e: any) => {
        console.warn(
          `[mnemopay:recall] OpenAI query embedding failed, falling back to local provider: ${
            e?.message ?? String(e)
          }`,
        );
        return localEmbed(query, this.config.dimensions);
      });
    }
    if (this.config.embeddingProvider === "bge") {
      return bgeEmbed(query);
    }
    return Promise.resolve(localEmbed(query, this.config.dimensions));
  }

  /**
   * Semantic search: find memories similar to a query.
   * Hybrid: (FTS candidates + vector cosine similarity + optional importance/score blend)
   */
  async search(
    query: string,
    memories: Array<{
      id: string;
      content: string;
      importance: number;
      score: number;
      createdAt: Date;
      lastAccessed: Date;
      accessCount: number;
      tags: string[];
    }>,
    limit: number
  ): Promise<RecallResult[]> {
    const strategy = this.config.strategy;

    // Pure score mode
    if (strategy === "score") {
      return memories
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((m) => ({
          ...m,
          combinedScore: m.score,
        }));
    }

    const safeLimit = Math.max(1, Math.floor(limit || 10));
    const q = (query ?? "").toString();
    const queryVec = await this.embedQuery(q);

    // Preference queries need stronger FTS weight — lexical matching is more reliable
    // than hash embeddings for paraphrase matching. Cover both explicit ("favorite")
    // and implicit ("recommend a hotel") phrasings since LongMemEval preference
    // questions almost never use the explicit verbs.
    const EXPLICIT_PREFERENCE = /\b(favorite|prefer|like|enjoy|love|hate|dislike|allergic|restriction|diet)\b/i;
    const IMPLICIT_PREFERENCE = /\b(recommend|recommendation|suggest|suggestion|advice|advise|which|what.+should|can you (recommend|suggest))\b/i;
    const isPreferenceQuery = EXPLICIT_PREFERENCE.test(q) || IMPLICIT_PREFERENCE.test(q);
    const effectiveFtsWeight = isPreferenceQuery
      ? Math.max(this.config.ftsWeight ?? 0.15, 0.45)
      : (this.config.ftsWeight ?? 0.15);

    let candidateMems = memories;
    let ftsScoreById = new Map<string, number>();

    // Hybrid preselect candidates using FTS5 if sqliteStorage is present
    if (
      strategy === "hybrid" &&
      this.config.sqliteStorage &&
      this.config.sqliteAgentId &&
      typeof this.config.sqliteStorage.searchMemoriesFTS === "function"
    ) {
      try {
        const ftsQuery = sanitizeFTS5Query(q.slice(0, 500), isPreferenceQuery);
        if (!ftsQuery) {
          // If query has no usable tokens, skip FTS and use in-memory candidates.
          candidateMems = memories;
          ftsScoreById = new Map();
        } else {
          const rows = await this.config.sqliteStorage.searchMemoriesFTS({
            agentId: this.config.sqliteAgentId,
            query: ftsQuery,
            limit: (this.config.ftsCandidateLimit ?? 50) * (this.config.vectorKMultiplier ?? 3),
          });

          // If FTS returns nothing, don't continue with an empty candidate set.
          if (rows.length === 0) {
            candidateMems = memories;
            ftsScoreById = new Map();
          } else {
            candidateMems = rows.map((r) => ({
              id: r.id,
              content: r.content,
              importance: r.importance,
              score: r.score,
              createdAt: r.createdAt,
              lastAccessed: r.lastAccessed,
              accessCount: r.accessCount,
              tags: r.tags,
            }));

            ftsScoreById = new Map(rows.map((r) => [r.id, r.ftsScore ?? 0]));
          }
        }
      } catch (e: any) {
        console.warn(
          `[mnemopay:recall] FTS5 candidate selection failed, falling back to in-memory candidates: ${
            e?.message ?? String(e)
          }`
        );
        candidateMems = memories;
        ftsScoreById = new Map();
      }
    }

    // Ensure all candidates have embeddings
    if (candidateMems.length === 0) {
      // Final guard: return empty instead of crashing; should not happen in correct benchmark wiring.
      return [];
    }

    await Promise.all(candidateMems.map((m) => this.getOrEmbed(m.id, m.content)));

    // Score candidates
    const scored = candidateMems.map((m) => {
      const memVec = this.vectors.get(m.id);
      const vectorScore = memVec ? cosineSimilarity(queryVec, memVec) : 0;

      if (strategy === "vector") {
        const combinedScore = vectorScore * (0.5 + 0.5 * m.importance);
        return { ...m, vectorScore, combinedScore };
      }

      // Hybrid: combine score + vector + fts
      const normalizedScore = m.score / Math.max(m.score, 1);
      const base =
        this.config.scoreWeight * normalizedScore +
        this.config.vectorWeight * vectorScore;

      // BM25 scores from SQLite FTS5 are negative; more negative = better match.
      // Convert to [0,1] where 1 = best match using: |score| / (1 + |score|)
      const ftsScore = ftsScoreById.get(m.id) ?? 0;
      const ftsSim = Math.abs(ftsScore) / (1 + Math.abs(ftsScore));

      const combinedScore =
        base * (1 - effectiveFtsWeight) +
        effectiveFtsWeight * ftsSim;

      return { ...m, vectorScore, combinedScore };
    });

    // Merge/deduplicate by memory ID (keep highest combinedScore)
    const dedup = new Map<string, typeof scored[number]>();
    for (const s of scored) {
      const prev = dedup.get(s.id);
      if (!prev || s.combinedScore > prev.combinedScore) dedup.set(s.id, s);
    }

    const out = Array.from(dedup.values());
    out.sort((a, b) => b.combinedScore - a.combinedScore);
    return out.slice(0, safeLimit);
  }

  stats(): {
    strategy: string;
    cachedEmbeddings: number;
    dimensions: number;
    provider: string;
  } {
    return {
      strategy: this.config.strategy,
      cachedEmbeddings: this.vectors.size,
      dimensions: this.config.dimensions,
      provider: this.config.embeddingProvider,
    };
  }
}
