/**
 * Merkle Tree Memory Integrity — Tamper-Evident Agent Memory
 *
 * Protects against MemoryGraft attacks (injecting false memories into agent
 * context) by maintaining a Merkle hash tree over all memory writes.
 *
 * How it works:
 *   1. Every memory write produces a leaf hash: SHA-256(id + content + timestamp)
 *   2. Leaf hashes build a binary Merkle tree
 *   3. The root hash represents the entire memory state
 *   4. Any modification to any memory changes the root
 *   5. Merkle proofs verify individual memories without full tree traversal
 *
 * Attack vectors defended:
 *   - MemoryGraft: Injecting fabricated memories → root changes, detected
 *   - Memory tampering: Modifying existing memory content → leaf hash changes
 *   - Memory deletion: Removing memories silently → tree structure changes
 *   - Replay attacks: Re-inserting old memories → duplicate leaf detection
 *   - Reordering attacks: Changing memory chronology → position-dependent hashing
 *
 * References:
 *   - Merkle, R. (1987). "A Digital Signature Based on a Conventional Encryption Function"
 *   - OWASP Agentic AI Top 10 2026: A03 — Memory Poisoning
 *   - MnemoPay Master Strategy, Part 2.1 — Merkle tree memory integrity
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MerkleLeaf {
  /** SHA-256 hash of the memory content */
  hash: string;
  /** Memory ID this leaf represents */
  memoryId: string;
  /** Position index in the tree (insertion order) */
  index: number;
}

export interface MerkleProof {
  /** The leaf hash being proven */
  leafHash: string;
  /** Memory ID */
  memoryId: string;
  /** Sibling hashes from leaf to root, with direction */
  path: Array<{ hash: string; direction: "left" | "right" }>;
  /** Root hash at time of proof generation */
  rootHash: string;
}

export interface IntegritySnapshot {
  /** Merkle root hash */
  rootHash: string;
  /** Number of leaves (memories) in the tree */
  leafCount: number;
  /** ISO timestamp of snapshot */
  timestamp: string;
  /** SHA-256 of the snapshot itself (for snapshot integrity) */
  snapshotHash: string;
}

export interface TamperResult {
  /** Whether tampering was detected */
  tampered: boolean;
  /** Specific memories that failed verification */
  failedMemories: string[];
  /** Current root vs expected root */
  currentRoot: string;
  expectedRoot: string;
  /** Human-readable summary */
  summary: string;
}

export interface IntegrityAuditEntry {
  /** Event type */
  event: "leaf_added" | "leaf_removed" | "verification_pass" | "verification_fail" | "tamper_detected" | "snapshot_created";
  /** Related memory ID */
  memoryId?: string;
  /** Root hash at event time */
  rootHash: string;
  /** ISO timestamp */
  timestamp: string;
}

// ─── SHA-256 Hashing ────────────────────────────────────────────────────────

let _crypto: any;

function getHash(data: string): string {
  if (!_crypto) {
    try {
      _crypto = require("crypto");
    } catch {
      // Browser fallback: use SubtleCrypto synchronously is not possible,
      // so we use a simple non-cryptographic hash for environments without Node crypto.
      // This should never happen in production (Node.js always has crypto).
      throw new Error("MerkleTree requires Node.js crypto module");
    }
  }
  return _crypto.createHash("sha256").update(data).digest("hex");
}

// ─── Merkle Tree ────────────────────────────────────────────────────────────

export class MerkleTree {
  private leaves: MerkleLeaf[] = [];
  private leafMap: Map<string, number> = new Map(); // memoryId → index
  private hashSet: Set<string> = new Set(); // duplicate detection
  private auditLog: IntegrityAuditEntry[] = [];
  /** Max audit log entries to prevent unbounded growth */
  private static readonly MAX_AUDIT_LOG = 1000;
  /** Max leaves before requiring compaction */
  static readonly MAX_LEAVES = 100_000;

  /**
   * Add a memory entry to the tree.
   * Returns the leaf hash.
   */
  /** Max content size per leaf (100KB, matching memory limit) */
  static readonly MAX_CONTENT_SIZE = 102_400;

  addLeaf(memoryId: string, content: string, timestamp?: string): string {
    if (!memoryId || typeof memoryId !== "string") throw new Error("memoryId is required");
    if (!content || typeof content !== "string") throw new Error("content is required");
    if (memoryId.length > 256) throw new Error("memoryId exceeds 256 characters");
    if (content.length > MerkleTree.MAX_CONTENT_SIZE) throw new Error(`Content exceeds ${MerkleTree.MAX_CONTENT_SIZE} bytes`);
    if (this.leaves.length >= MerkleTree.MAX_LEAVES) {
      throw new Error(`Merkle tree leaf limit reached (${MerkleTree.MAX_LEAVES}). Compact old memories first.`);
    }

    // Compute leaf hash: H(index || memoryId || content || timestamp)
    // Including index prevents reordering attacks
    const ts = timestamp ?? new Date().toISOString();
    const index = this.leaves.length;
    const leafData = `${index}:${memoryId}:${content}:${ts}`;
    const hash = getHash(leafData);

    // Duplicate detection: same hash means identical content at same position
    if (this.hashSet.has(hash)) {
      throw new Error(`Duplicate leaf detected for memory ${memoryId}`);
    }

    // If this memoryId was already added (memory update), remove the old leaf
    if (this.leafMap.has(memoryId)) {
      this._removeLeafByMemoryId(memoryId);
    }

    const leaf: MerkleLeaf = { hash, memoryId, index };
    this.leaves.push(leaf);
    this.leafMap.set(memoryId, this.leaves.length - 1);
    this.hashSet.add(hash);

    this._audit("leaf_added", memoryId);
    return hash;
  }

  /**
   * Remove a memory from the tree (when memory is forgotten).
   */
  removeLeaf(memoryId: string): boolean {
    if (!this.leafMap.has(memoryId)) return false;
    this._removeLeafByMemoryId(memoryId);
    this._audit("leaf_removed", memoryId);
    return true;
  }

  private _removeLeafByMemoryId(memoryId: string): void {
    const idx = this.leafMap.get(memoryId);
    if (idx === undefined) return;

    const leaf = this.leaves[idx];
    if (leaf) {
      this.hashSet.delete(leaf.hash);
    }

    // Mark as removed (null-ify) rather than splicing to preserve indices
    // This avoids O(n) shifts and keeps proofs stable
    (this.leaves as any)[idx] = null;
    this.leafMap.delete(memoryId);
  }

  /**
   * Compute the Merkle root from all current leaves.
   * Uses standard binary tree construction: H(left || right).
   */
  getRoot(): string {
    const activeLeaves = this.leaves.filter(l => l !== null) as MerkleLeaf[];
    if (activeLeaves.length === 0) return getHash("empty");

    let level = activeLeaves.map(l => l.hash);

    // Build tree bottom-up
    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : left; // Duplicate last if odd
        // Canonical ordering: always hash(smaller || larger) to prevent order-dependent roots
        // when reconstructing from unordered sets. But for Merkle trees, positional ordering
        // is correct (left child is always the lower index).
        nextLevel.push(getHash(left + right));
      }
      level = nextLevel;
    }

    return level[0];
  }

  /**
   * Generate a Merkle proof for a specific memory.
   * The proof allows verifying this memory is in the tree without the full tree.
   */
  getProof(memoryId: string): MerkleProof {
    const idx = this.leafMap.get(memoryId);
    if (idx === undefined) throw new Error(`Memory ${memoryId} not in tree`);

    const leaf = this.leaves[idx];
    if (!leaf) throw new Error(`Memory ${memoryId} has been removed`);

    const activeLeaves = this.leaves.filter(l => l !== null) as MerkleLeaf[];
    const activeIndex = activeLeaves.findIndex(l => l.memoryId === memoryId);
    if (activeIndex === -1) throw new Error(`Memory ${memoryId} not found in active leaves`);

    // Build proof path
    let level = activeLeaves.map(l => l.hash);
    const path: MerkleProof["path"] = [];
    let currentIdx = activeIndex;

    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : left;

        if (i === currentIdx || i + 1 === currentIdx) {
          // This pair contains our node
          if (currentIdx % 2 === 0) {
            // Our node is left child, sibling is right
            const siblingHash = i + 1 < level.length ? level[i + 1] : level[i];
            path.push({ hash: siblingHash, direction: "right" });
          } else {
            // Our node is right child, sibling is left
            path.push({ hash: level[i], direction: "left" });
          }
        }

        nextLevel.push(getHash(left + right));
      }
      currentIdx = Math.floor(currentIdx / 2);
      level = nextLevel;
    }

    return {
      leafHash: leaf.hash,
      memoryId,
      path,
      rootHash: this.getRoot(),
    };
  }

  /**
   * Verify a Merkle proof is valid.
   * Returns true if the proof correctly links the leaf to the root.
   */
  static verifyProof(proof: MerkleProof): boolean {
    if (!proof || !proof.leafHash || !proof.rootHash || !Array.isArray(proof.path)) {
      return false;
    }

    let currentHash = proof.leafHash;

    for (const step of proof.path) {
      if (step.direction === "left") {
        currentHash = getHash(step.hash + currentHash);
      } else {
        currentHash = getHash(currentHash + step.hash);
      }
    }

    return currentHash === proof.rootHash;
  }

  /**
   * Verify a specific memory's content against the tree.
   * Re-computes the leaf hash and checks it matches the stored hash.
   */
  verifyMemory(memoryId: string, content: string, timestamp: string): boolean {
    const idx = this.leafMap.get(memoryId);
    if (idx === undefined) return false;

    const leaf = this.leaves[idx];
    if (!leaf) return false;

    // Recompute the hash
    const leafData = `${leaf.index}:${memoryId}:${content}:${timestamp}`;
    const expectedHash = getHash(leafData);

    const match = expectedHash === leaf.hash;
    this._audit(match ? "verification_pass" : "verification_fail", memoryId);
    return match;
  }

  /**
   * Take a snapshot of current tree state.
   * Used for periodic checkpointing and tamper detection.
   */
  snapshot(): IntegritySnapshot {
    const rootHash = this.getRoot();
    const leafCount = this.leaves.filter(l => l !== null).length;
    const timestamp = new Date().toISOString();
    const snapshotData = `${rootHash}:${leafCount}:${timestamp}`;
    const snapshotHash = getHash(snapshotData);

    this._audit("snapshot_created");

    return { rootHash, leafCount, timestamp, snapshotHash };
  }

  /**
   * Detect tampering by comparing current root to a previous snapshot.
   * Also validates snapshot integrity (the snapshot itself wasn't tampered).
   */
  detectTampering(previousSnapshot: IntegritySnapshot): TamperResult {
    // First, verify the snapshot itself wasn't tampered
    const expectedSnapshotHash = getHash(
      `${previousSnapshot.rootHash}:${previousSnapshot.leafCount}:${previousSnapshot.timestamp}`
    );
    if (expectedSnapshotHash !== previousSnapshot.snapshotHash) {
      return {
        tampered: true,
        failedMemories: [],
        currentRoot: this.getRoot(),
        expectedRoot: previousSnapshot.rootHash,
        summary: "CRITICAL: The snapshot itself has been tampered with. Cannot trust any comparison.",
      };
    }

    const currentRoot = this.getRoot();
    const currentLeafCount = this.leaves.filter(l => l !== null).length;

    if (currentRoot === previousSnapshot.rootHash) {
      return {
        tampered: false,
        failedMemories: [],
        currentRoot,
        expectedRoot: previousSnapshot.rootHash,
        summary: `Integrity verified. ${currentLeafCount} memories, root matches snapshot.`,
      };
    }

    // Root changed — determine what changed
    const leafDiff = currentLeafCount - previousSnapshot.leafCount;
    let summary = `Root hash mismatch. Leaves: ${previousSnapshot.leafCount} → ${currentLeafCount} (${leafDiff >= 0 ? "+" : ""}${leafDiff}).`;

    if (leafDiff > 0) {
      summary += ` ${leafDiff} new memories added since snapshot.`;
    } else if (leafDiff < 0) {
      summary += ` ${Math.abs(leafDiff)} memories removed since snapshot.`;
    } else {
      summary += " Same leaf count but content changed — possible memory modification.";
      this._audit("tamper_detected");
    }

    return {
      tampered: true,
      failedMemories: [], // Would need per-memory tracking to identify specific changes
      currentRoot,
      expectedRoot: previousSnapshot.rootHash,
      summary,
    };
  }

  /**
   * Full tree verification: recompute root from all leaves and verify
   * internal consistency (no corrupted nodes).
   */
  verifyTreeIntegrity(): { valid: boolean; leafCount: number; rootHash: string } {
    const activeLeaves = this.leaves.filter(l => l !== null) as MerkleLeaf[];
    const computedRoot = this.getRoot();

    // Verify no hash collisions in leaf set
    const uniqueHashes = new Set(activeLeaves.map(l => l.hash));
    if (uniqueHashes.size !== activeLeaves.length) {
      return { valid: false, leafCount: activeLeaves.length, rootHash: computedRoot };
    }

    // Verify leaf map consistency
    for (const [memId, idx] of this.leafMap) {
      const leaf = this.leaves[idx];
      if (!leaf || leaf.memoryId !== memId) {
        return { valid: false, leafCount: activeLeaves.length, rootHash: computedRoot };
      }
    }

    return { valid: true, leafCount: activeLeaves.length, rootHash: computedRoot };
  }

  /** Number of active (non-removed) leaves */
  get size(): number {
    return this.leaves.filter(l => l !== null).length;
  }

  /** Get the audit log */
  getAuditLog(): IntegrityAuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Compact the tree by removing null entries and re-indexing.
   * This is a heavy operation — call during maintenance windows only.
   * WARNING: This invalidates all existing proofs.
   */
  compact(): { removed: number; remaining: number } {
    const before = this.leaves.length;
    const activeLeaves = this.leaves.filter(l => l !== null) as MerkleLeaf[];

    // Re-index
    this.leaves = [];
    this.leafMap.clear();
    this.hashSet.clear();

    for (let i = 0; i < activeLeaves.length; i++) {
      const leaf = { ...activeLeaves[i], index: i };
      this.leaves.push(leaf);
      this.leafMap.set(leaf.memoryId, i);
      this.hashSet.add(leaf.hash);
    }

    return { removed: before - activeLeaves.length, remaining: activeLeaves.length };
  }

  /**
   * Serialize tree state for persistence.
   */
  serialize(): { leaves: MerkleLeaf[]; rootHash: string } {
    const activeLeaves = this.leaves.filter(l => l !== null) as MerkleLeaf[];
    return {
      leaves: activeLeaves,
      rootHash: this.getRoot(),
    };
  }

  /**
   * Deserialize from persisted state with validation.
   */
  static deserialize(data: { leaves: MerkleLeaf[]; rootHash: string }): MerkleTree {
    if (!data || !Array.isArray(data.leaves)) {
      throw new Error("Invalid MerkleTree data");
    }

    const tree = new MerkleTree();
    const seenIds = new Set<string>();
    const seenHashes = new Set<string>();

    for (const leaf of data.leaves) {
      // Validate each leaf
      if (!leaf.hash || typeof leaf.hash !== "string" || leaf.hash.length !== 64) {
        throw new Error(`Invalid leaf hash for memory ${leaf.memoryId}`);
      }
      if (!leaf.memoryId || typeof leaf.memoryId !== "string") {
        throw new Error("Invalid leaf memoryId");
      }
      if (seenIds.has(leaf.memoryId)) {
        throw new Error(`Duplicate memoryId in tree: ${leaf.memoryId}`);
      }
      if (seenHashes.has(leaf.hash)) {
        throw new Error(`Duplicate hash in tree: ${leaf.hash}`);
      }

      seenIds.add(leaf.memoryId);
      seenHashes.add(leaf.hash);

      tree.leaves.push({ ...leaf, index: tree.leaves.length });
      tree.leafMap.set(leaf.memoryId, tree.leaves.length - 1);
      tree.hashSet.add(leaf.hash);
    }

    // Verify root matches if provided
    if (data.rootHash) {
      const computedRoot = tree.getRoot();
      if (computedRoot !== data.rootHash) {
        throw new Error(`Root hash mismatch on deserialize: computed ${computedRoot}, expected ${data.rootHash}. Tree may be corrupted.`);
      }
    }

    return tree;
  }

  private _audit(event: IntegrityAuditEntry["event"], memoryId?: string): void {
    // Root hash is computed lazily — only include it for verification/snapshot events
    // to avoid O(n) cost on every leaf add/remove
    const needsRoot = event === "verification_pass" || event === "verification_fail" || event === "tamper_detected" || event === "snapshot_created";
    this.auditLog.push({
      event,
      memoryId,
      rootHash: needsRoot ? this.getRoot() : "",
      timestamp: new Date().toISOString(),
    });
    if (this.auditLog.length > MerkleTree.MAX_AUDIT_LOG) {
      this.auditLog.splice(0, this.auditLog.length - (MerkleTree.MAX_AUDIT_LOG / 2));
    }
  }
}
