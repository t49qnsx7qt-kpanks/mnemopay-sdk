import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { sha256 } from '@noble/hashes/sha256'; // Keep sha256 for integrity check
import {
  Memory, MemoryMetadata, MemoryQuery, MemoryRecallResult, MnemoPayConfig,
} from '../types/index';
import { PlatformCrypto, generateId } from '../security/crypto';
import { PermissionGuard, SecurityError } from '../security/permissions';
import { RateLimiter } from '../security/rate-limiter';
import { FraudDetector } from '../security/fraud-detector';
import { embed } from './embeddings'; // Import the shared embed function

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id               TEXT    PRIMARY KEY,
    content_enc      BLOB    NOT NULL,
    metadata_enc     BLOB    NOT NULL,
    integrity_mac    BLOB    NOT NULL,
    importance       REAL    NOT NULL DEFAULT 0.5,
    access_count     INTEGER NOT NULL DEFAULT 0,
    decay_score      REAL    NOT NULL DEFAULT 1.0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    expires_at       INTEGER,
    agent_id         TEXT    NOT NULL,
    session_id       TEXT    NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
    id        TEXT PRIMARY KEY,
    embedding FLOAT[384]
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id         TEXT    PRIMARY KEY,
    table_name TEXT    NOT NULL,
    record_id  TEXT    NOT NULL,
    synced     INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`;

export class MemoryStore {
  private readonly agentId: string;
  private readonly halfLifeMs: number;
  private readonly memoryCap: number;
  private readonly embeddingDim: number;

  constructor(
    private readonly db: Database.Database,
    private readonly crypto: PlatformCrypto,
    private readonly guard: PermissionGuard,
    private readonly rateLimiter: RateLimiter,
    private readonly fraud: FraudDetector,
    config: MnemoPayConfig,
  ) {
    this.agentId = config.agentId;
    this.halfLifeMs = (config.memoryHalfLifeDays ?? 7) * 86_400_000;
    this.memoryCap = config.memoryCapacity ?? 10_000;
    this.embeddingDim = config.embeddingDimensions ?? 384;
  }

  static loadExtensions(db: Database.Database): void {
    sqliteVec.load(db);
  }

  static initSchema(db: Database.Database): void {
    db.exec(SCHEMA);
  }

  // decay-adjusted score: s * 2^(-t/h) * (1 + 0.05 * log2(a+1)) * i
  private decayedScore(createdAt: number, accessCount: number, importance: number): number {
    const t = Date.now() - createdAt;
    const cosine = 1.0; // placeholder; real value supplied by caller
    return cosine * Math.pow(2, -t / this.halfLifeMs) * (1 + 0.05 * Math.log2(accessCount + 1)) * importance;
  }

  // ── retain ──────────────────────────────────────────────────────────────────
  async retain(
    content: string,
    metadata: Omit<MemoryMetadata, 'agentId'>,
  ): Promise<Memory> {
    this.guard.enforce('memory:write');

    const { allowed, signal } = this.rateLimiter.check(this.agentId, 'memory_write');
    if (!allowed) {
      this.fraud.getLog(); // signal already logged
      throw new SecurityError('RATE_LIMITED', 'Memory write rate limit exceeded');
    }

    // Injection check
    const injSig = this.fraud.checkInjection(content, this.agentId);
    if (injSig) throw new SecurityError('FRAUD_DETECTED', `Prompt injection blocked: ${injSig.details.pattern ?? injSig.details.encoding}`);

    // Poisoning / importance clamp
    const { signal: poisonSig, clampedImportance } = this.fraud.checkPoisoning(content, this.agentId, metadata.importance);
    if (poisonSig?.autoAction === 'reject') throw new SecurityError('FRAUD_DETECTED', 'Memory poisoning detected');

    const fullMeta: MemoryMetadata = { ...metadata, agentId: this.agentId, importance: clampedImportance };
    const id = generateId('mem');
    const now = Date.now();
    const embedding = embed(content, this.embeddingDim); // Use the shared embed function

    // Integrity HMAC over canonical representation
    const integrityInput = Buffer.from(JSON.stringify({
      id,
      content,
      metadata: {
        source: fullMeta.source,
        sessionId: fullMeta.sessionId,
        agentId: fullMeta.agentId,
        tags: fullMeta.tags,
        importance: fullMeta.importance,
        ttl: fullMeta.ttl,
      }
    }), 'utf8');
    const integrityMac = await this.crypto.hmac(integrityInput);

    // Encrypt content and metadata separately
    const encContent = await this.crypto.encrypt(Buffer.from(content, 'utf8'));
    const encMeta = await this.crypto.encrypt(Buffer.from(JSON.stringify(fullMeta), 'utf8'));

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memories
          (id, content_enc, metadata_enc, integrity_mac, importance, access_count,
           decay_score, created_at, updated_at, expires_at, agent_id, session_id)
        VALUES (?, ?, ?, ?, ?, 0, 1.0, ?, ?, ?, ?, ?)
      `).run(
        id, encContent, encMeta, integrityMac,
        clampedImportance, now, now,
        fullMeta.ttl ? now + fullMeta.ttl : null,
        this.agentId, fullMeta.sessionId,
      );

      this.db.prepare(`INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)`)
        .run(id, new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
      
      const check = this.db.prepare('SELECT COUNT(*) as c FROM memory_vectors WHERE id = ?').get(id) as any;
      // console.log(`Stored vector for ${id}, exists in vtab: ${check.c}`);

      // Track for sync
      this.db.prepare(`
        INSERT OR REPLACE INTO sync_log (id, table_name, record_id, synced, updated_at)
        VALUES (?, 'memories', ?, 0, ?)
      `).run(generateId('sl'), id, now);
    })();

    this.evictIfNeeded();

    return {
      id, content, embedding, metadata: fullMeta,
      createdAt: now, updatedAt: now, accessCount: 0,
      decayScore: 1.0, integrity: Buffer.from(integrityMac).toString('hex'),
    };
  }

  // ── recall ──────────────────────────────────────────────────────────────────
  async recall(query: MemoryQuery): Promise<MemoryRecallResult[]> {
    this.guard.enforce('memory:read');
    this.rateLimiter.check(this.agentId, 'general');

    const queryVec = query.embedding ?? (query.text ? embed(query.text, this.embeddingDim) : null); // Use the shared embed function
    if (!queryVec) return [];

    const limit = query.limit ?? 10;

    const rows = this.db.prepare(`
      SELECT m.*, mv.distance
      FROM memory_vectors mv
      JOIN memories m ON m.id = mv.id
      WHERE mv.embedding MATCH ?
        AND k = ?
        AND m.agent_id = ?
        AND (m.expires_at IS NULL OR m.expires_at > ?)
      ORDER BY mv.distance
    `).all(
      new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
      limit * 3, // over-fetch, filter post-decrypt
      this.agentId,
      Date.now(),
    ) as any[];

    const results: MemoryRecallResult[] = [];

    for (const row of rows) {
      try {
        // Decrypt
        const content = Buffer.from(await this.crypto.decrypt(Buffer.from(row.content_enc))).toString('utf8');
        const metadata: MemoryMetadata = JSON.parse(
          Buffer.from(await this.crypto.decrypt(Buffer.from(row.metadata_enc))).toString('utf8'),
        );

        // Verify integrity — skip tampered records
        const integrityInput = Buffer.from(JSON.stringify({
          id: row.id,
          content,
          metadata: {
            source: metadata.source,
            sessionId: metadata.sessionId,
            agentId: metadata.agentId,
            tags: metadata.tags,
            importance: metadata.importance,
            ttl: metadata.ttl,
          }
        }), 'utf8');
        const valid = await this.crypto.verifyHmac(integrityInput, Buffer.from(row.integrity_mac));
        if (!valid) continue;

        // Post-filters
        if (query.sessionId && metadata.sessionId !== query.sessionId) continue;
        if (query.agentId && metadata.agentId !== query.agentId) continue;
        if (query.tags?.length && !query.tags.some(t => metadata.tags.includes(t))) continue;
        if (query.minImportance != null && metadata.importance < query.minImportance) continue;

        const l2Squared: number = row.distance;
        const cosine = 1 - (l2Squared / 2);
        // console.log(`ID: ${row.id}, dist: ${l2Squared}, sim: ${cosine}, threshold: ${query.threshold}`);
        
        if (query.threshold != null && cosine < query.threshold) continue;

        const score = cosine
          * Math.pow(2, -(Date.now() - row.created_at) / this.halfLifeMs)
          * (1 + 0.05 * Math.log2(row.access_count + 1))
          * metadata.importance;

        // Increment access count
        this.db.prepare(`UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?`)
          .run(Date.now(), row.id);

        results.push({
          memory: {
            id: row.id, content, embedding: queryVec, metadata,
            createdAt: row.created_at, updatedAt: row.updated_at,
            accessCount: row.access_count + 1, decayScore: score,
            integrity: Buffer.from(row.integrity_mac).toString('hex'),
          },
          score,
          distance: l2Squared,
        });
      } catch {
        continue; // Decrypt failure or parse error — skip silently
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ── forget ───────────────────────────────────────────────────────────────────
  async forget(memoryId: string): Promise<void> {
    this.guard.enforce('memory:delete');
    this.db.transaction(() => {
      // Zero-fill before delete to prevent forensic recovery
      this.db.prepare(`
        UPDATE memories
        SET content_enc = zeroblob(length(content_enc)),
            metadata_enc = zeroblob(length(metadata_enc))
        WHERE id = ? AND agent_id = ?
      `).run(memoryId, this.agentId);

      this.db.prepare(`DELETE FROM memories WHERE id = ? AND agent_id = ?`).run(memoryId, this.agentId);
      this.db.prepare(`DELETE FROM memory_vectors WHERE id = ?`).run(memoryId);
    })();
  }

  // ── autoRecall — LLM context injection ──────────────────────────────────────
  async autoRecall(userMessage: string, tokenBudget = 1500): Promise<string> {
    const results = await this.recall({ text: userMessage, limit: 10, threshold: 0.3 });
    if (results.length === 0) return '';

    let ctx = '[Relevant memory context]\n';
    let tokenCount = 10;

    for (const r of results) {
      const ts = new Date(r.memory.createdAt).toISOString().slice(0, 16);
      const line = `[${ts}] (rel:${r.score.toFixed(2)}) ${r.memory.content}\n`;
      const est = Math.ceil(line.length / 4);
      if (tokenCount + est > tokenBudget) break;
      ctx += line;
      tokenCount += est;
    }

    return ctx;
  }

  // ── autoRetain — salient fact extraction from conversation ───────────────────
  async autoRetain(conversation: string, sessionId: string): Promise<Memory[]> {
    const sentences = conversation
      .split(/(?<=[.!])\s+/)
      .map(s => s.trim())
      .filter(s => {
        if (s.length < 20) return false;
        if (/^(hi|hello|hey|ok|okay|thanks|sure|yes|no)\b/i.test(s)) return false;
        if (s.endsWith('?')) return false;
        return true;
      })
      .slice(0, 5); // max 5 facts per call — rate-limit protection

    const stored: Memory[] = [];

    for (const sentence of sentences) {
      try {
        // Novelty check at 0.92 threshold
        const existing = await this.recall({ text: sentence, limit: 1, threshold: 0.92 });
        if (existing.length > 0) continue;

        const mem = await this.retain(sentence, {
          source: 'conversation',
          sessionId,
          tags: ['auto'],
          importance: 0.5,
        });
        stored.push(mem);
      } catch {
        break; // Rate limit or fraud block — stop processing
      }
    }

    return stored;
  }

  // ── Maintenance ──────────────────────────────────────────────────────────────
  purgeExpired(): void {
    const expired = this.db.prepare(
      `SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ? AND agent_id = ?`,
    ).all(Date.now(), this.agentId) as { id: string }[];
    for (const row of expired) this.forget(row.id);
  }

  private evictIfNeeded(): void {
    const count = (this.db.prepare(
      `SELECT COUNT(*) as c FROM memories WHERE agent_id = ?`,
    ).get(this.agentId) as any).c;

    if (count > this.memoryCap) {
      const row = this.db.prepare(`
        SELECT id FROM memories WHERE agent_id = ?
        ORDER BY (importance * decay_score) ASC LIMIT 1
      `).get(this.agentId) as { id: string } | undefined;
      if (row) this.forget(row.id);
    }
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE agent_id = ?`).get(this.agentId) as any).c;
  }
}
