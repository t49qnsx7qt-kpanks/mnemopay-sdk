/**
 * Cross-Encoder Reranker — local ONNX via @xenova/transformers.
 *
 * After first-stage retrieval (FTS5 + vector fusion) we have top-N candidates
 * scored by lexical overlap + bi-encoder cosine. A cross-encoder scores each
 * (query, candidate) pair jointly, which captures fine-grained query-document
 * interaction that a bi-encoder cannot. Typical lift: +3-8 points on recall@5
 * for QA tasks.
 *
 * Uses Xenova/bge-reranker-base (110M params, ~450MB, runs on CPU, ~30-100ms
 * per pair depending on text length). No API key required.
 */

export interface RerankCandidate {
  id: string;
  content: string;
  /** Original first-stage score (preserved for fallback / ablation). */
  priorScore?: number;
  /**
   * Creation timestamp. Required only when rerank() is called with
   * `preserveRecency > 0` — otherwise ignored. Enables the reranker to reserve
   * topK slots for the most recent candidates, which is critical for
   * knowledge-update and temporal-reasoning questions where a pure relevance
   * signal drops the load-bearing second-evidence chunk.
   */
  timestamp?: Date;
}

export interface RerankedResult<T extends RerankCandidate = RerankCandidate> {
  item: T;
  rerankScore: number;
  /** Original order index from the input list (for ablation / debugging). */
  originalIndex: number;
}

export interface RerankerConfig {
  /** Hugging Face model id, loaded locally via @xenova/transformers. */
  model?: string;
  /** Max candidate pairs to score per call (hard cap to protect latency). */
  maxCandidates?: number;
  /** Truncate each candidate's content to this many chars before scoring. */
  maxContentChars?: number;
}

export interface RerankOptions {
  /**
   * Reserve this many of the topK slots for the most-recent candidates (by
   * `timestamp`) that would not otherwise have made the cut. Defaults to 0
   * (pure relevance). On benchmarks with multi-evidence questions (temporal,
   * knowledge-update), preserveRecency = ceil(topK * 0.4) recovers the breadth
   * that a unimodal cross-encoder otherwise culls. Candidates without a
   * `timestamp` are ignored by this logic.
   */
  preserveRecency?: number;
}

export const rerankerStats = {
  model: "",
  loadTimeMs: 0,
  totalRerankMs: 0,
  totalPairs: 0,
  calls: 0,
  loaded: false,
};

let cachedPipeline: ((input: { text: string; text_pair: string }) => Promise<{ score: number }>) | null = null;
let cachedModelId: string | null = null;

async function getPipeline(modelId: string): Promise<
  (input: { text: string; text_pair: string }) => Promise<{ score: number }>
> {
  if (cachedPipeline && cachedModelId === modelId) return cachedPipeline;

  const t0 = Date.now();
  const { pipeline, env } = await import("@xenova/transformers");
  const localPath = process.env.RERANKER_LOCAL_MODEL_PATH;
  if (localPath) {
    env.localModelPath = localPath;
    env.allowRemoteModels = false;
  }

  // bge-reranker models output a single relevance score per (query, doc) pair.
  // text-classification pipeline with `topk: 1` returns the score directly.
  const pipe = (await pipeline("text-classification", modelId)) as unknown as (
    input: { text: string; text_pair: string } | Array<{ text: string; text_pair: string }>,
    opts?: { topk?: number },
  ) => Promise<any>;

  const wrapped = async (input: { text: string; text_pair: string }) => {
    const out = await pipe(input, { topk: 1 });
    // transformers.js returns either [{label, score}] or {label, score} depending on version.
    const first = Array.isArray(out) ? (Array.isArray(out[0]) ? out[0][0] : out[0]) : out;
    const score = typeof first?.score === "number" ? first.score : 0;
    return { score };
  };

  cachedPipeline = wrapped;
  cachedModelId = modelId;
  rerankerStats.model = modelId;
  rerankerStats.loadTimeMs = Date.now() - t0;
  rerankerStats.loaded = true;
  return wrapped;
}

export class CrossEncoderReranker {
  private readonly config: Required<RerankerConfig>;

  constructor(config: RerankerConfig = {}) {
    this.config = {
      model: config.model ?? "Xenova/bge-reranker-base",
      maxCandidates: config.maxCandidates ?? 50,
      maxContentChars: config.maxContentChars ?? 2000,
    };
  }

  /**
   * Score (query, candidate) pairs with the cross-encoder and return them
   * reordered by rerank score descending. If the model fails to load or score,
   * returns candidates in their original order (graceful degradation).
   */
  async rerank<T extends RerankCandidate>(
    query: string,
    candidates: T[],
    topK?: number,
    options: RerankOptions = {},
  ): Promise<RerankedResult<T>[]> {
    if (candidates.length === 0) return [];

    const capped = candidates.slice(0, this.config.maxCandidates);
    const t0 = Date.now();

    let pipe: Awaited<ReturnType<typeof getPipeline>>;
    try {
      pipe = await getPipeline(this.config.model);
    } catch (e) {
      // Fallback: preserve prior order with neutral rerank scores. Still
      // honour topK so callers don't get a flood of unranked items on failure.
      const fallback = capped.map((item, originalIndex) => ({
        item,
        rerankScore: item.priorScore ?? 0,
        originalIndex,
      }));
      return typeof topK === "number" && topK > 0 ? fallback.slice(0, topK) : fallback;
    }

    const scored: RerankedResult<T>[] = [];
    for (let i = 0; i < capped.length; i++) {
      const item = capped[i];
      const truncated = item.content.slice(0, this.config.maxContentChars);
      try {
        const { score } = await pipe({ text: query, text_pair: truncated });
        scored.push({ item, rerankScore: score, originalIndex: i });
      } catch {
        scored.push({ item, rerankScore: item.priorScore ?? 0, originalIndex: i });
      }
    }

    rerankerStats.totalRerankMs += Date.now() - t0;
    rerankerStats.totalPairs += capped.length;
    rerankerStats.calls++;

    scored.sort((a, b) => b.rerankScore - a.rerankScore);

    const k = typeof topK === "number" && topK > 0 ? topK : scored.length;
    const reserve = Math.max(0, Math.min(options.preserveRecency ?? 0, k));

    if (reserve === 0) return scored.slice(0, k);

    const relevanceSlots = Math.max(0, k - reserve);
    const relevantPart = scored.slice(0, relevanceSlots);
    const takenIds = new Set(relevantPart.map((r) => r.item.id));

    // Most-recent slots: sort the remainder by timestamp DESC, take `reserve`.
    // Candidates missing a timestamp sink to the bottom (they cannot claim a
    // recency slot, so the feature degrades gracefully when callers forget to
    // pass createdAt).
    const remainder = scored.filter((r) => !takenIds.has(r.item.id));
    const byRecency = remainder.slice().sort((a, b) => {
      const ta = a.item.timestamp instanceof Date ? a.item.timestamp.getTime() : -Infinity;
      const tb = b.item.timestamp instanceof Date ? b.item.timestamp.getTime() : -Infinity;
      return tb - ta;
    });
    const recencyPart = byRecency.slice(0, reserve);

    return [...relevantPart, ...recencyPart];
  }
}
