"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryStore = void 0;
const sqliteVec = __importStar(require("sqlite-vec"));
const sha256_1 = require("@noble/hashes/sha256");
const crypto_1 = require("../security/crypto");
const permissions_1 = require("../security/permissions");
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
class MemoryStore {
    db;
    crypto;
    guard;
    rateLimiter;
    fraud;
    agentId;
    halfLifeMs;
    memoryCap;
    embeddingDim;
    constructor(db, crypto, guard, rateLimiter, fraud, config) {
        this.db = db;
        this.crypto = crypto;
        this.guard = guard;
        this.rateLimiter = rateLimiter;
        this.fraud = fraud;
        this.agentId = config.agentId;
        this.halfLifeMs = (config.memoryHalfLifeDays ?? 7) * 86_400_000;
        this.memoryCap = config.memoryCapacity ?? 10_000;
        this.embeddingDim = config.embeddingDimensions ?? 384;
    }
    static loadExtensions(db) {
        sqliteVec.load(db);
    }
    static initSchema(db) {
        db.exec(SCHEMA);
    }
    // Deterministic hash-based embedding (placeholder until ONNX MiniLM is integrated)
    embed(text) {
        const hash = (0, sha256_1.sha256)(Buffer.from(text, 'utf8'));
        const vec = new Float32Array(this.embeddingDim);
        for (let i = 0; i < this.embeddingDim; i++) {
            vec[i] = (hash[i % 32] / 127.5) - 1.0;
        }
        // L2 normalise
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        if (norm > 0)
            for (let i = 0; i < vec.length; i++)
                vec[i] /= norm;
        return vec;
    }
    // decay-adjusted score: s * 2^(-t/h) * (1 + 0.05 * log2(a+1)) * i
    decayedScore(createdAt, accessCount, importance) {
        const t = Date.now() - createdAt;
        const cosine = 1.0; // placeholder; real value supplied by caller
        return cosine * Math.pow(2, -t / this.halfLifeMs) * (1 + 0.05 * Math.log2(accessCount + 1)) * importance;
    }
    // ── retain ──────────────────────────────────────────────────────────────────
    async retain(content, metadata) {
        this.guard.enforce('memory:write');
        const { allowed, signal } = this.rateLimiter.check(this.agentId, 'memory_write');
        if (!allowed) {
            this.fraud.getLog(); // signal already logged
            throw new permissions_1.SecurityError('RATE_LIMITED', 'Memory write rate limit exceeded');
        }
        // Injection check
        const injSig = this.fraud.checkInjection(content, this.agentId);
        if (injSig)
            throw new permissions_1.SecurityError('FRAUD_DETECTED', `Prompt injection blocked: ${injSig.details.pattern ?? injSig.details.encoding}`);
        // Poisoning / importance clamp
        const { signal: poisonSig, clampedImportance } = this.fraud.checkPoisoning(content, this.agentId, metadata.importance);
        if (poisonSig?.autoAction === 'reject')
            throw new permissions_1.SecurityError('FRAUD_DETECTED', 'Memory poisoning detected');
        const fullMeta = { ...metadata, agentId: this.agentId, importance: clampedImportance };
        const id = (0, crypto_1.generateId)('mem');
        const now = Date.now();
        const embedding = this.embed(content);
        // Integrity HMAC over canonical representation
        const integrityInput = Buffer.from(JSON.stringify({ id, content, metadata: fullMeta }), 'utf8');
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
      `).run(id, encContent, encMeta, integrityMac, clampedImportance, now, now, fullMeta.ttl ? now + fullMeta.ttl : null, this.agentId, fullMeta.sessionId);
            this.db.prepare(`INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)`)
                .run(id, Buffer.from(embedding.buffer));
            // Track for sync
            this.db.prepare(`
        INSERT OR REPLACE INTO sync_log (id, table_name, record_id, synced, updated_at)
        VALUES (?, 'memories', ?, 0, ?)
      `).run((0, crypto_1.generateId)('sl'), id, now);
        })();
        this.evictIfNeeded();
        return {
            id, content, embedding, metadata: fullMeta,
            createdAt: now, updatedAt: now, accessCount: 0,
            decayScore: 1.0, integrity: Buffer.from(integrityMac).toString('hex'),
        };
    }
    // ── recall ──────────────────────────────────────────────────────────────────
    async recall(query) {
        this.guard.enforce('memory:read');
        this.rateLimiter.check(this.agentId, 'general');
        const queryVec = query.embedding ?? (query.text ? this.embed(query.text) : null);
        if (!queryVec)
            return [];
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
    `).all(Buffer.from(queryVec.buffer), limit * 3, // over-fetch, filter post-decrypt
        this.agentId, Date.now());
        const results = [];
        for (const row of rows) {
            try {
                // Decrypt
                const content = Buffer.from(await this.crypto.decrypt(Buffer.from(row.content_enc))).toString('utf8');
                const metadata = JSON.parse(Buffer.from(await this.crypto.decrypt(Buffer.from(row.metadata_enc))).toString('utf8'));
                // Verify integrity — skip tampered records
                const integrityInput = Buffer.from(JSON.stringify({ id: row.id, content, metadata }), 'utf8');
                const valid = await this.crypto.verifyHmac(integrityInput, Buffer.from(row.integrity_mac));
                if (!valid)
                    continue;
                // Post-filters
                if (query.sessionId && metadata.sessionId !== query.sessionId)
                    continue;
                if (query.agentId && metadata.agentId !== query.agentId)
                    continue;
                if (query.tags?.length && !query.tags.some(t => metadata.tags.includes(t)))
                    continue;
                if (query.minImportance != null && metadata.importance < query.minImportance)
                    continue;
                const cosineDistance = row.distance;
                const cosine = 1 - cosineDistance;
                if (query.threshold != null && cosine < query.threshold)
                    continue;
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
                    distance: cosineDistance,
                });
            }
            catch {
                continue; // Decrypt failure or parse error — skip silently
            }
        }
        return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }
    // ── forget ───────────────────────────────────────────────────────────────────
    async forget(memoryId) {
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
    async autoRecall(userMessage, tokenBudget = 1500) {
        const results = await this.recall({ text: userMessage, limit: 10, threshold: 0.3 });
        if (results.length === 0)
            return '';
        let ctx = '[Relevant memory context]\n';
        let tokenCount = 10;
        for (const r of results) {
            const ts = new Date(r.memory.createdAt).toISOString().slice(0, 16);
            const line = `[${ts}] (rel:${r.score.toFixed(2)}) ${r.memory.content}\n`;
            const est = Math.ceil(line.length / 4);
            if (tokenCount + est > tokenBudget)
                break;
            ctx += line;
            tokenCount += est;
        }
        return ctx;
    }
    // ── autoRetain — salient fact extraction from conversation ───────────────────
    async autoRetain(conversation, sessionId) {
        const sentences = conversation
            .split(/(?<=[.!])\s+/)
            .map(s => s.trim())
            .filter(s => {
            if (s.length < 20)
                return false;
            if (/^(hi|hello|hey|ok|okay|thanks|sure|yes|no)\b/i.test(s))
                return false;
            if (s.endsWith('?'))
                return false;
            return true;
        })
            .slice(0, 5); // max 5 facts per call — rate-limit protection
        const stored = [];
        for (const sentence of sentences) {
            try {
                // Novelty check at 0.92 threshold
                const existing = await this.recall({ text: sentence, limit: 1, threshold: 0.92 });
                if (existing.length > 0)
                    continue;
                const mem = await this.retain(sentence, {
                    source: 'conversation',
                    sessionId,
                    tags: ['auto'],
                    importance: 0.5,
                });
                stored.push(mem);
            }
            catch {
                break; // Rate limit or fraud block — stop processing
            }
        }
        return stored;
    }
    // ── Maintenance ──────────────────────────────────────────────────────────────
    purgeExpired() {
        const expired = this.db.prepare(`SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ? AND agent_id = ?`).all(Date.now(), this.agentId);
        for (const row of expired)
            this.forget(row.id);
    }
    evictIfNeeded() {
        const count = this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE agent_id = ?`).get(this.agentId).c;
        if (count > this.memoryCap) {
            const row = this.db.prepare(`
        SELECT id FROM memories WHERE agent_id = ?
        ORDER BY (importance * decay_score) ASC LIMIT 1
      `).get(this.agentId);
            if (row)
                this.forget(row.id);
        }
    }
    count() {
        return this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE agent_id = ?`).get(this.agentId).c;
    }
}
exports.MemoryStore = MemoryStore;
//# sourceMappingURL=store.js.map