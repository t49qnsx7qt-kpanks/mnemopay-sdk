import type { MnemoPayConfig } from '../types/index';
/** Vector size for `Xenova/all-MiniLM-L6-v2` and the default `memory_vectors` schema. */
export declare const SEMANTIC_EMBEDDING_DIM = 384;
/** Deterministic hash → L2-normalized vector (default backend). */
export declare function embedHash(text: string, embeddingDim?: number): Float32Array;
/** @deprecated Use `embedHash`; kept for backwards compatibility. */
export declare function embed(text: string, embeddingDim?: number): Float32Array;
/**
 * Builds the async embedder used by MemoryStore / EncryptedSync.
 * - `embed` custom fn wins over `embeddings`.
 * - `embeddings: 'semantic'` uses Xenova all-MiniLM-L6-v2 (384-dim, L2-normalized).
 * - Default: hash backend.
 */
export declare function createAsyncEmbedder(config: MnemoPayConfig): (text: string) => Promise<Float32Array>;
//# sourceMappingURL=embeddings.d.ts.map