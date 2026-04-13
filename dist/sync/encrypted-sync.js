"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptedSync = void 0;
const permissions_1 = require("../security/permissions");
/** Allowed sync targets — keyed by sync_log.table_name; values are static SQL (no string interpolation). */
const SYNC_ROW_SELECT = {
    memories: 'SELECT * FROM memories WHERE id = ?',
};
class EncryptedSync {
    db;
    crypto;
    guard;
    agentId;
    deviceId;
    embedText;
    constructor(db, crypto, guard, agentId, deviceId, embedText) {
        this.db = db;
        this.crypto = crypto;
        this.guard = guard;
        this.agentId = agentId;
        this.deviceId = deviceId;
        this.embedText = embedText;
    }
    async buildPushPacket(tables = ['memories']) {
        this.guard.enforce('sync:push');
        const dirty = this.db.prepare(`
      SELECT * FROM sync_log
      WHERE synced = 0 AND table_name IN (${tables.map(() => '?').join(',')})
      ORDER BY updated_at ASC
      LIMIT 500
    `).all(...tables);
        const blobs = [];
        const cursor = dirty.length > 0 ? Math.max(...dirty.map(d => d.updated_at)) : Date.now();
        for (const entry of dirty) {
            const selectSql = SYNC_ROW_SELECT[entry.table_name];
            if (!selectSql)
                continue;
            const row = this.db.prepare(selectSql).get(entry.record_id);
            if (!row)
                continue;
            const plaintext = Buffer.from(JSON.stringify(row), 'utf8');
            const encBuf = await this.crypto.encrypt(plaintext);
            blobs.push({
                id: entry.record_id,
                table: entry.table_name,
                encryptedPayload: Buffer.from(encBuf).toString('base64'),
            });
        }
        const ids = blobs.map(b => b.id).sort().join(',');
        const checksumBuf = await this.crypto.hmac(Buffer.from(ids, 'utf8'));
        const checksum = Buffer.from(checksumBuf).toString('hex');
        const manifest = {
            agentId: this.agentId,
            deviceId: this.deviceId,
            tables,
            cursor,
            recordCount: blobs.length,
            checksum,
        };
        const sigBuf = await this.crypto.sign(Buffer.from(JSON.stringify(manifest), 'utf8'));
        return {
            manifest,
            blobs,
            signature: Buffer.from(sigBuf).toString('hex'),
        };
    }
    async applyPullPacket(packet) {
        this.guard.enforce('sync:pull');
        if (packet.manifest.agentId !== this.agentId) {
            throw new permissions_1.SecurityError('AGENT_MISMATCH', 'Sync packet belongs to a different agent');
        }
        const manifestBytes = Buffer.from(JSON.stringify(packet.manifest), 'utf8');
        const sigBuf = Buffer.from(packet.signature, 'hex');
        const ok = await this.crypto.verify(manifestBytes, sigBuf, this.crypto.getPublicKey());
        if (!ok) {
            throw new permissions_1.SecurityError('INVALID_SIGNATURE', 'Sync packet manifest signature invalid');
        }
        let merged = 0;
        let skipped = 0;
        for (const blob of packet.blobs) {
            try {
                const encBuf = Buffer.from(blob.encryptedPayload, 'base64');
                const decBuf = Buffer.from(await this.crypto.decrypt(encBuf));
                const remote = JSON.parse(decBuf.toString('utf8'));
                if (blob.table === 'memories') {
                    if (remote.agent_id !== this.agentId) {
                        skipped++;
                        continue;
                    }
                    const local = this.db.prepare(`SELECT updated_at FROM memories WHERE id = ?`).get(blob.id);
                    if (!local || remote.updated_at > local.updated_at) {
                        this.db.exec(`
              CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
                id        TEXT PRIMARY KEY,
                agent_id  TEXT PARTITION KEY,
                embedding FLOAT[384]
              );
            `);
                        const contentEncBuffer = Buffer.from(remote.content_enc.data);
                        const metadataEncBuffer = Buffer.from(remote.metadata_enc.data);
                        const integrityMacBuffer = Buffer.from(remote.integrity_mac.data);
                        const decryptedContent = Buffer.from(await this.crypto.decrypt(contentEncBuffer)).toString('utf8');
                        const embedding = await this.embedText(decryptedContent);
                        this.db.prepare(`
              INSERT OR REPLACE INTO memories
                (id, content_enc, metadata_enc, integrity_mac, importance, access_count,
                 decay_score, created_at, updated_at, expires_at, agent_id, session_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(remote.id, contentEncBuffer, metadataEncBuffer, integrityMacBuffer, remote.importance, remote.access_count, remote.decay_score, remote.created_at, remote.updated_at, remote.expires_at ?? null, remote.agent_id, remote.session_id);
                        this.db.prepare(`DELETE FROM memory_vectors WHERE id = ? AND agent_id = ?`).run(remote.id, remote.agent_id);
                        this.db.prepare(`INSERT INTO memory_vectors (id, agent_id, embedding) VALUES (?, ?, ?)`)
                            .run(remote.id, remote.agent_id, new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
                        merged++;
                    }
                    else {
                        skipped++;
                    }
                }
            }
            catch (e) {
                console.error(`Error merging sync blob ${blob.id}:`, e);
                skipped++;
            }
        }
        return { merged, skipped };
    }
    markSynced(recordIds) {
        if (recordIds.length === 0)
            return;
        const placeholders = recordIds.map(() => '?').join(',');
        this.db.prepare(`UPDATE sync_log SET synced = 1 WHERE record_id IN (${placeholders})`)
            .run(...recordIds);
    }
    getSyncStatus() {
        const pending = this.db.prepare(`SELECT COUNT(*) as c FROM sync_log WHERE synced = 0`).get().c;
        const lastSyncRow = this.db.prepare(`SELECT MAX(updated_at) as ts FROM sync_log WHERE synced = 1`).get();
        return {
            pendingPush: pending,
            lastSync: lastSyncRow?.ts ?? null,
        };
    }
}
exports.EncryptedSync = EncryptedSync;
//# sourceMappingURL=encrypted-sync.js.map