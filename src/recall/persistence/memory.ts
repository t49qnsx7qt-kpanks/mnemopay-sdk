/**
 * MemoryAdapter — in-process PersistenceAdapter backed by a Map.
 *
 * This is the default adapter used by RecallEngine when no `persist` option
 * is supplied. It preserves the zero-dependency, zero-infra behavior of the
 * original `Map<id, Float32Array>` while adopting the adapter interface so
 * that alternate backends (Neon, etc.) are drop-in replacements.
 *
 * Memory is scoped by agentId: distinct agents never see each other's rows.
 */

import { cosineSimilarity } from "../engine.js";
import type { PersistedRow, PersistenceAdapter, SearchHit } from "./types.js";

export class MemoryAdapter implements PersistenceAdapter {
  // agentId → (id → row)
  private store: Map<string, Map<string, PersistedRow>> = new Map();

  private bucket(agentId: string): Map<string, PersistedRow> {
    let b = this.store.get(agentId);
    if (!b) {
      b = new Map();
      this.store.set(agentId, b);
    }
    return b;
  }

  async set(
    agentId: string,
    id: string,
    content: string,
    embedding: Float32Array,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Copy the Float32Array to decouple the stored row from caller mutation.
    const embCopy = new Float32Array(embedding.length);
    embCopy.set(embedding);
    this.bucket(agentId).set(id, {
      content,
      embedding: embCopy,
      metadata: metadata ? { ...metadata } : undefined,
    });
  }

  async get(agentId: string, id: string): Promise<PersistedRow | null> {
    const row = this.store.get(agentId)?.get(id);
    return row ?? null;
  }

  async delete(agentId: string, id: string): Promise<void> {
    const b = this.store.get(agentId);
    if (!b) return;
    b.delete(id);
    if (b.size === 0) this.store.delete(agentId);
  }

  async search(
    agentId: string,
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<SearchHit[]> {
    const b = this.store.get(agentId);
    if (!b || b.size === 0) return [];
    const k = Math.max(1, Math.floor(topK || 10));

    const scored: SearchHit[] = [];
    for (const [id, row] of b) {
      let score = 0;
      try {
        score = cosineSimilarity(queryEmbedding, row.embedding);
      } catch {
        // Dimension mismatch — skip this row rather than abort the whole search.
        continue;
      }
      scored.push({
        id,
        content: row.content,
        score,
        metadata: row.metadata,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async close(): Promise<void> {
    // No resources to release. Leave data intact so a re-opened engine can
    // rebind to the same adapter instance if desired.
  }

  // ─── Non-interface helpers used internally by RecallEngine ──────────────
  // These mirror the old Map-based bookkeeping (size, clear, bulk delete,
  // purge-by-valid-set) without leaking Map internals outside this file.

  /** Total number of rows across all agents. */
  size(): number {
    let n = 0;
    for (const b of this.store.values()) n += b.size;
    return n;
  }

  /** Count rows for a specific agent. */
  sizeFor(agentId: string): number {
    return this.store.get(agentId)?.size ?? 0;
  }

  /** Remove every row for the given agent. */
  clearAgent(agentId: string): void {
    this.store.delete(agentId);
  }

  /** Remove every row for every agent. */
  clearAll(): void {
    this.store.clear();
  }
}
