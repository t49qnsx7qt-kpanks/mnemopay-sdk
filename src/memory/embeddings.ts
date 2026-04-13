import { sha256 } from '@noble/hashes/sha256';
import type { MnemoPayConfig } from '../types/index';

/** Vector size for `Xenova/all-MiniLM-L6-v2` and the default `memory_vectors` schema. */
export const SEMANTIC_EMBEDDING_DIM = 384;

/** Deterministic hash → L2-normalized vector (default backend). */
export function embedHash(text: string, embeddingDim: number = SEMANTIC_EMBEDDING_DIM): Float32Array {
  const hash = sha256(Buffer.from(text, 'utf8'));
  const vec = new Float32Array(embeddingDim);
  for (let i = 0; i < embeddingDim; i++) {
    vec[i] = (hash[i % 32] / 127.5) - 1.0;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** @deprecated Use `embedHash`; kept for backwards compatibility. */
export function embed(text: string, embeddingDim: number = SEMANTIC_EMBEDDING_DIM): Float32Array {
  return embedHash(text, embeddingDim);
}

function l2Normalize(vec: Float32Array): Float32Array {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm <= 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function toFloat32Length(v: Float32Array, dim: number): Float32Array {
  if (v.length === dim) return l2Normalize(v);
  const out = new Float32Array(dim);
  if (v.length >= dim) {
    out.set(v.subarray(0, dim));
  } else {
    out.set(v);
  }
  return l2Normalize(out);
}

function tensorDataToFloat32(raw: unknown): Float32Array {
  let cur: unknown = raw;
  for (let depth = 0; depth < 6; depth++) {
    if (cur instanceof Float32Array) return cur;
    if (Array.isArray(cur)) return Float32Array.from(cur);
    if (cur && typeof cur === 'object' && 'data' in cur) {
      const d = (cur as { data: unknown }).data;
      if (d instanceof Float32Array) return d;
      if (d instanceof ArrayBuffer) return new Float32Array(d);
      if (Array.isArray(d)) return Float32Array.from(d);
      cur = d;
      continue;
    }
    break;
  }
  throw new Error('Unexpected embedding tensor shape from feature extractor');
}

let semanticPipelinePromise: Promise<unknown> | null = null;

async function loadSemanticPipeline(): Promise<(text: string, opts: object) => Promise<unknown>> {
  if (!semanticPipelinePromise) {
    semanticPipelinePromise = (async () => {
      try {
        const { pipeline } = await import('@xenova/transformers');
        return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `semantic embeddings need optional dependency @xenova/transformers (${msg}). Install: npm install @xenova/transformers`,
        );
      }
    })();
  }
  return (await semanticPipelinePromise) as (text: string, opts: object) => Promise<unknown>;
}

/**
 * Builds the async embedder used by MemoryStore / EncryptedSync.
 * - `embed` custom fn wins over `embeddings`.
 * - `embeddings: 'semantic'` uses Xenova all-MiniLM-L6-v2 (384-dim, L2-normalized).
 * - Default: hash backend.
 */
export function createAsyncEmbedder(config: MnemoPayConfig): (text: string) => Promise<Float32Array> {
  const dim = config.embeddingDimensions ?? SEMANTIC_EMBEDDING_DIM;

  if (config.embed) {
    const fn = config.embed;
    return async (text: string) => {
      const v = await Promise.resolve(fn(text, dim));
      return toFloat32Length(v, dim);
    };
  }

  if (config.embeddings === 'semantic') {
    if (dim !== SEMANTIC_EMBEDDING_DIM) {
      throw new Error(
        `embeddings: "semantic" requires embeddingDimensions: ${SEMANTIC_EMBEDDING_DIM} (all-MiniLM-L6-v2).`,
      );
    }
    return async (text: string) => {
      const pipe = await loadSemanticPipeline();
      const raw = await pipe(text, { pooling: 'mean', normalize: true });
      const data = tensorDataToFloat32(raw);
      return toFloat32Length(data, SEMANTIC_EMBEDDING_DIM);
    };
  }

  return async (text: string) => embedHash(text, dim);
}
