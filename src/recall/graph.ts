/**
 * EntityGraph — in-memory knowledge graph for spreading-activation retrieval.
 *
 * Nodes are canonicalized entities. Edges are co-occurrence: whenever two
 * entities appear in the same memory, we add an undirected edge between them.
 * Each node also tracks the set of memory IDs it was mentioned in.
 *
 * At query time we:
 *   1. Extract entities from the query
 *   2. Look them up in the graph (via canonicalize)
 *   3. BFS 2-hop from those seed nodes, collecting every entity we can reach
 *   4. Union the mention-sets of those reachable entities → candidate memories
 *   5. Assign each candidate a spread score = 1 / (1 + min_hop_distance)
 *
 * The spread score is fed into the recall fuser as a 6th signal (alongside
 * importance, recency, frequency, BM25/FTS, vector cosine). It's the
 * cheapest mechanism we have for cross-session reasoning — it doesn't need
 * the target memory to be lexically or semantically close to the query, only
 * to share an entity neighborhood.
 *
 * Bitemporal support: edges optionally carry (tValid, tInvalid) timestamps.
 * At query time callers can filter edges by the question's reference date.
 * This is the Graphiti/Memento pattern (arxiv 2501.13956, n1n.ai/memento).
 */

import { canonicalize, normalizeEntityKey } from "./entities.js";
import type { CanonicalEntry } from "./entities.js";

export interface GraphNode {
  id: string;
  canonicalName: string;
  type: string;
  aliases: string[];
}

export interface GraphEdge {
  subjectId: string;
  predicate: string;
  objectId: string;
  memoryIds: string[];
  /** Optional — unix ms. Null means "always valid from creation". */
  tValid?: number;
  /** Optional — unix ms. Null means "still valid as of now". */
  tInvalid?: number;
}

export interface SpreadResult {
  /** memoryId → spread score in [0, 1]. Higher = closer to a query entity. */
  memoryScores: Map<string, number>;
  /** Entity IDs the query resolved to. Empty if the query had no entities. */
  seedIds: string[];
  /** All entity IDs reached within maxHops, with their hop distance. */
  reached: Map<string, number>;
}

export class EntityGraph {
  private nodes = new Map<string, GraphNode>();
  private nodesByKey = new Map<string, string>(); // normalizedKey → nodeId
  private adjacency = new Map<string, Set<string>>(); // nodeId → connected nodeIds
  private edges: GraphEdge[] = [];
  private mentions = new Map<string, Set<string>>(); // entityId → memoryIds

  private nextNodeId = 1;

  /** Deterministic node IDs so graphs can be serialized/compared. */
  private mintNodeId(): string {
    const id = `ent-${this.nextNodeId}`;
    this.nextNodeId++;
    return id;
  }

  /** Snapshot of canonical entries for external canonicalization calls. */
  private canonicalEntries(): CanonicalEntry[] {
    return Array.from(this.nodes.values()).map((n) => ({
      canonicalName: n.canonicalName,
      aliases: n.aliases,
    }));
  }

  /**
   * Find an existing node for a surface-form name, or create a new one.
   * Uses the full tiered canonicalization (exact → alias → fuzzy).
   * Returns the node ID.
   */
  upsertEntity(name: string, type = "other"): string {
    const canon = canonicalize(name, this.canonicalEntries());
    if (canon.matched) {
      const key = normalizeEntityKey(canon.canonicalName);
      const existingId = this.nodesByKey.get(key);
      if (existingId) {
        // Record this surface form as an alias if new
        const node = this.nodes.get(existingId);
        if (node) {
          const norm = normalizeEntityKey(name);
          const alreadyKnown =
            normalizeEntityKey(node.canonicalName) === norm ||
            node.aliases.some((a) => normalizeEntityKey(a) === norm);
          if (!alreadyKnown) node.aliases.push(name);
        }
        return existingId;
      }
    }

    // New node
    const id = this.mintNodeId();
    const node: GraphNode = {
      id,
      canonicalName: name,
      type,
      aliases: [],
    };
    this.nodes.set(id, node);
    this.nodesByKey.set(normalizeEntityKey(name), id);
    this.adjacency.set(id, new Set());
    return id;
  }

  /** Record that `entityId` was mentioned in `memoryId`. */
  addMention(entityId: string, memoryId: string): void {
    if (!this.nodes.has(entityId)) return;
    let set = this.mentions.get(entityId);
    if (!set) {
      set = new Set();
      this.mentions.set(entityId, set);
    }
    set.add(memoryId);
  }

  /**
   * Add a co-occurrence edge between two entities. Undirected. Idempotent:
   * re-adding with the same memoryId is a no-op; re-adding with a new
   * memoryId appends to the existing edge's memoryIds list.
   */
  addEdge(
    subjectId: string,
    objectId: string,
    memoryId: string,
    predicate = "co_occurs_with",
    tValid?: number,
    tInvalid?: number,
  ): void {
    if (subjectId === objectId) return;
    if (!this.nodes.has(subjectId) || !this.nodes.has(objectId)) return;

    const existing = this.edges.find(
      (e) =>
        e.predicate === predicate &&
        ((e.subjectId === subjectId && e.objectId === objectId) ||
          (e.subjectId === objectId && e.objectId === subjectId)),
    );
    if (existing) {
      if (!existing.memoryIds.includes(memoryId)) existing.memoryIds.push(memoryId);
      if (tValid !== undefined && existing.tValid === undefined) existing.tValid = tValid;
      if (tInvalid !== undefined) existing.tInvalid = tInvalid;
    } else {
      this.edges.push({
        subjectId,
        predicate,
        objectId,
        memoryIds: [memoryId],
        tValid,
        tInvalid,
      });
    }

    this.adjacency.get(subjectId)!.add(objectId);
    this.adjacency.get(objectId)!.add(subjectId);
  }

  /**
   * Helper: ingest a set of entities extracted from a single memory.
   * Upserts each, records all mentions, and adds pairwise co-occurrence edges.
   */
  ingestMemoryEntities(params: {
    memoryId: string;
    entities: Array<{ name: string; type?: string }>;
    timestamp?: number;
  }): string[] {
    const ids: string[] = [];
    for (const e of params.entities) {
      const id = this.upsertEntity(e.name, e.type ?? "other");
      this.addMention(id, params.memoryId);
      ids.push(id);
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        this.addEdge(ids[i], ids[j], params.memoryId, "co_occurs_with", params.timestamp);
      }
    }
    return ids;
  }

  /**
   * Look up a surface-form name in the graph. Uses canonicalization so that
   * "that sushi place" resolves to "Kura Sushi" if it was registered as a
   * fuzzy-match alias.
   */
  findByName(name: string): string | null {
    // Direct key hit
    const direct = this.nodesByKey.get(normalizeEntityKey(name));
    if (direct) return direct;
    // Canonicalize through the tier chain
    const canon = canonicalize(name, this.canonicalEntries());
    if (canon.matched) {
      return this.nodesByKey.get(normalizeEntityKey(canon.canonicalName)) ?? null;
    }
    return null;
  }

  /**
   * BFS up to `maxHops` from `seedIds`. Returns:
   *   - reached: entity ID → hop distance
   *   - memoryScores: memory ID → best (smallest-hop) spread score
   *
   * Spread score per hop distance h: `1 / (1 + h)`. So direct-mention
   * memories (hop 0) score 1.0, 1-hop neighbors score 0.5, 2-hop score 0.33.
   */
  spread(seedIds: string[], maxHops = 2, referenceTime?: number): SpreadResult {
    const reached = new Map<string, number>();
    if (seedIds.length === 0) {
      return { memoryScores: new Map(), seedIds: [], reached };
    }

    const queue: Array<[string, number]> = [];
    for (const id of seedIds) {
      if (this.nodes.has(id) && !reached.has(id)) {
        reached.set(id, 0);
        queue.push([id, 0]);
      }
    }

    while (queue.length > 0) {
      const [id, hop] = queue.shift()!;
      if (hop >= maxHops) continue;
      for (const next of this.adjacency.get(id) ?? []) {
        if (reached.has(next)) continue;
        // Bitemporal filter: if caller supplied a reference time, skip edges
        // that were invalidated before it. We approximate this by checking
        // the edge list for subject=id/object=next.
        if (referenceTime !== undefined) {
          const edge = this.edges.find(
            (e) =>
              (e.subjectId === id && e.objectId === next) ||
              (e.subjectId === next && e.objectId === id),
          );
          if (edge?.tInvalid !== undefined && edge.tInvalid < referenceTime) continue;
          if (edge?.tValid !== undefined && edge.tValid > referenceTime) continue;
        }
        reached.set(next, hop + 1);
        queue.push([next, hop + 1]);
      }
    }

    const memoryScores = new Map<string, number>();
    for (const [entityId, hop] of reached) {
      const weight = 1 / (1 + hop);
      for (const memId of this.mentions.get(entityId) ?? []) {
        const prev = memoryScores.get(memId) ?? 0;
        if (weight > prev) memoryScores.set(memId, weight);
      }
    }

    return { memoryScores, seedIds, reached };
  }

  /** Mark an edge as invalidated at `atTime`. Used for knowledge updates. */
  invalidateEdge(subjectId: string, objectId: string, atTime: number, predicate = "co_occurs_with"): void {
    for (const edge of this.edges) {
      if (edge.predicate !== predicate) continue;
      if (
        (edge.subjectId === subjectId && edge.objectId === objectId) ||
        (edge.subjectId === objectId && edge.objectId === subjectId)
      ) {
        edge.tInvalid = atTime;
      }
    }
  }

  size(): { entities: number; edges: number; mentions: number } {
    let mentionCount = 0;
    for (const s of this.mentions.values()) mentionCount += s.size;
    return {
      entities: this.nodes.size,
      edges: this.edges.length,
      mentions: mentionCount,
    };
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Serialize to a JSON-friendly snapshot (for persistence / debugging). */
  toJSON(): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    mentions: Array<[string, string[]]>;
  } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
      mentions: Array.from(this.mentions.entries()).map(([id, set]) => [id, [...set]]),
    };
  }
}
