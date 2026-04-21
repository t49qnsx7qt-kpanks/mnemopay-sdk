/**
 * PersistenceAdapter — pluggable storage for RecallEngine vectors.
 *
 * The adapter owns (agent_id, id) → { content, embedding, metadata } rows.
 * It is orthogonal to the embedding provider (openai | local | bge).
 *
 * Implementations:
 *   - MemoryAdapter: in-process Map (default, zero infra)
 *   - NeonAdapter:   Neon / Postgres with pgvector HNSW
 */

export interface PersistedRow {
  content: string;
  embedding: Float32Array;
  metadata?: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface PersistenceAdapter {
  /**
   * Upsert a memory row. Overwrites any existing row with the same (agentId, id).
   * Implementations MUST be idempotent and safe under concurrent calls for
   * distinct (agentId, id) keys.
   */
  set(
    agentId: string,
    id: string,
    content: string,
    embedding: Float32Array,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /** Fetch a single row by key, or null if missing. */
  get(agentId: string, id: string): Promise<PersistedRow | null>;

  /** Remove a single row. No-op if missing. */
  delete(agentId: string, id: string): Promise<void>;

  /**
   * Semantic top-K search by cosine similarity against stored embeddings,
   * scoped to agentId. Score is cosine similarity in [-1, 1] (higher is better).
   */
  search(
    agentId: string,
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<SearchHit[]>;

  /** Close underlying connections/pools. Safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Discriminated union for configuring persistence from public entry points
 * (e.g. MnemoPay.quick). `type: "memory"` is the default and requires no infra.
 */
export type PersistenceOptions =
  | { type: "memory" }
  | {
      type: "neon";
      /** Postgres connection string, e.g. process.env.NEON_URL */
      url: string;
      /** Override the table name (default: "mnemopay_memories"). */
      table?: string;
      /** Skip CREATE EXTENSION + CREATE TABLE bootstrap (default: false). */
      skipBootstrap?: boolean;
    }
  | { type: "custom"; adapter: PersistenceAdapter };
