/**
 * Pluggable Recall Engine — adds semantic search to MnemoPay.
 *
 * Strategies:
 *   "score"   — Current: importance × recency × frequency (default, zero deps)
 *   "vector"  — Embeddings-based cosine similarity (requires OpenAI or local provider)
 *   "hybrid"  — Score + Vector combined (best quality, higher latency)
 *
 * All strategies are compatible with the feedback loop — settle() still reinforces results.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type RecallStrategy = "score" | "vector" | "hybrid";

export type EmbeddingProvider = "openai" | "local";

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
  if (a.length !== b.length) throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) return 0; // epsilon-based check for denormalized floats
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
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "and", "but", "or", "nor",
  "not", "so", "yet", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "only", "own", "same", "than", "too", "very",
  "just", "because", "about", "up", "it", "its", "this", "that", "these",
  "those", "i", "me", "my", "we", "our", "you", "your", "he", "him",
  "his", "she", "her", "they", "them", "their", "what", "which", "who",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Local embedding: TF-IDF-style hashing into a fixed-dimension vector.
 * No external API needed. Good enough for semantic similarity in small corpora.
 */
export function localEmbed(text: string, dimensions = 384): Float32Array {
  const tokens = tokenize(text);
  const vec = new Float32Array(dimensions);

  // Hash each token into multiple dimensions (simulated IDF weighting)
  for (const token of tokens) {
    // FNV-1a hash for distribution
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    // Map to 3 dimensions per token for better coverage
    const idx1 = Math.abs(hash) % dimensions;
    const idx2 = Math.abs(hash * 31) % dimensions;
    const idx3 = Math.abs(hash * 97) % dimensions;

    // Weight by inverse token length (longer = more specific = higher weight)
    const weight = 1 + Math.log(token.length);
    vec[idx1] += weight;
    vec[idx2] += weight * 0.5;
    vec[idx3] += weight * 0.3;

    // Prefix hash for fuzzy stem matching (e.g. "deploy" ≈ "deployment")
    if (token.length > 4) {
      const prefix = token.slice(0, 4);
      let ph = 2166136261;
      for (let i = 0; i < prefix.length; i++) {
        ph ^= prefix.charCodeAt(i);
        ph = Math.imul(ph, 16777619);
      }
      const pi1 = Math.abs(ph) % dimensions;
      const pi2 = Math.abs(ph * 31) % dimensions;
      vec[pi1] += weight * 0.3;
      vec[pi2] += weight * 0.15;
    }
  }

  return l2Normalize(vec);
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

export class RecallEngine {
  private config: Required<RecallEngineConfig>;
  private vectors: Map<string, Float32Array> = new Map();

  constructor(config: Partial<RecallEngineConfig> = {}) {
    this.config = {
      strategy: config.strategy ?? "score",
      embeddingProvider: config.embeddingProvider ?? "local",
      openaiApiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "",
      embeddingModel: config.embeddingModel ?? "text-embedding-3-small",
      dimensions: config.dimensions ?? (config.embeddingProvider === "openai" ? 1536 : 384),
      scoreWeight: config.scoreWeight ?? 0.4,
      vectorWeight: config.vectorWeight ?? 0.6,
    };

    // Validate hybrid weights sum to ~1.0
    const weightSum = this.config.scoreWeight + this.config.vectorWeight;
    if (Math.abs(weightSum - 1.0) > 0.01) {
      throw new Error(`Hybrid weights must sum to ~1.0 (got ${weightSum.toFixed(2)})`);
    }

    // Validate OpenAI API key is present when needed
    if (this.config.strategy !== "score" && this.config.embeddingProvider === "openai" && !this.config.openaiApiKey) {
      throw new Error("OpenAI API key required for vector/hybrid recall strategy with OpenAI provider");
    }
  }

  get strategy(): RecallStrategy {
    return this.config.strategy;
  }

  /**
   * Generate embedding for content and cache it.
   */
  async embed(id: string, content: string): Promise<Float32Array> {
    let vec: Float32Array;

    if (this.config.embeddingProvider === "openai" && this.config.openaiApiKey) {
      try {
        vec = await openaiEmbed(content, this.config.openaiApiKey, this.config.embeddingModel);
      } catch (e: any) {
        console.warn(`[mnemopay:recall] OpenAI embedding failed, falling back to local provider: ${e.message}`);
        vec = localEmbed(content, this.config.dimensions);
      }
    } else {
      vec = localEmbed(content, this.config.dimensions);
    }

    this.vectors.set(id, vec);
    return vec;
  }

  /**
   * Get cached embedding or generate new one.
   */
  async getOrEmbed(id: string, content: string): Promise<Float32Array> {
    const cached = this.vectors.get(id);
    if (cached) return cached;
    return this.embed(id, content);
  }

  /**
   * Remove embedding from cache.
   */
  remove(id: string): void {
    this.vectors.delete(id);
  }

  /**
   * Remove multiple embeddings from cache.
   */
  removeBatch(ids: string[]): void {
    for (const id of ids) this.vectors.delete(id);
  }

  /**
   * Sync cache against a list of valid IDs.
   * Removes any cached vectors that are not in the validIds set.
   * Returns the count of purged vectors.
   */
  purgeStaleVectors(validIds: Set<string>): number {
    let purged = 0;
    for (const id of this.vectors.keys()) {
      if (!validIds.has(id)) {
        this.vectors.delete(id);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Clear all cached embeddings.
   */
  clear(): void {
    this.vectors.clear();
  }

  /**
   * Semantic search: find memories similar to a query.
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

    // Pure score mode — same as current behavior
    if (strategy === "score") {
      return memories
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((m) => ({
          ...m,
          combinedScore: m.score,
        }));
    }

    // Vector or hybrid — need embeddings
    const queryVec = await this.embedQuery(query);

    // Ensure all memories have embeddings
    await Promise.all(
      memories.map((m) => this.getOrEmbed(m.id, m.content))
    );

    const scored = memories.map((m) => {
      const memVec = this.vectors.get(m.id);
      const vectorScore = memVec ? cosineSimilarity(queryVec, memVec) : 0;

      let combinedScore: number;
      if (strategy === "vector") {
        // Pure vector: similarity * importance (importance still matters)
        combinedScore = vectorScore * (0.5 + 0.5 * m.importance);
      } else {
        // Hybrid: weighted combination
        const normalizedScore = m.score / Math.max(m.score, 1);
        combinedScore =
          this.config.scoreWeight * normalizedScore +
          this.config.vectorWeight * vectorScore;
      }

      return {
        ...m,
        vectorScore,
        combinedScore,
      };
    });

    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    return scored.slice(0, limit);
  }

  /**
   * Embed a query string.
   */
  private async embedQuery(query: string): Promise<Float32Array> {
    if (this.config.embeddingProvider === "openai" && this.config.openaiApiKey) {
      try {
        return await openaiEmbed(query, this.config.openaiApiKey, this.config.embeddingModel);
      } catch (e: any) {
        console.warn(`[mnemopay:recall] OpenAI query embedding failed, falling back to local provider: ${e.message}`);
        return localEmbed(query, this.config.dimensions);
      }
    }
    return localEmbed(query, this.config.dimensions);
  }

  /**
   * Get engine stats.
   */
  stats(): { strategy: string; cachedEmbeddings: number; dimensions: number; provider: string } {
    return {
      strategy: this.config.strategy,
      cachedEmbeddings: this.vectors.size,
      dimensions: this.config.dimensions,
      provider: this.config.embeddingProvider,
    };
  }
}
