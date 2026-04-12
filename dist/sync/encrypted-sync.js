"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptedSync = void 0;
const permissions_1 = require("../security/permissions");
// ── EncryptedSync ──────────────────────────────────────────────────────────
// Zero-knowledge cloud sync: client encrypts everything before upload.
// Server stores opaque blobs — it cannot read content or metadata.
// The sync protocol:
//   1. Pull: download blobs since cursor, decrypt locally, merge
//   2. Push: encrypt dirty records, upload, update cursor
//   3. Conflict: last-write-wins per record (updated_at comparison)
//
// This class handles the local side. The remote side is a simple REST API
// that stores (id, table, encrypted_blob, updated_at) — no decryption needed.
class EncryptedSync {
    db;
    crypto;
    guard;
    agentId;
    deviceId;
    constructor(db, crypto, guard, agentId, deviceId) {
        this.db = db;
        this.crypto = crypto;
        this.guard = guard;
        this.agentId = agentId;
        this.deviceId = deviceId;
    }
    // ── buildPushPacket ───────────────────────────────────────────────────────
    // Collect all unsynced records and encrypt them for upload.
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
            const row = this.db.prepare(`SELECT * FROM ${entry.table_name} WHERE id = ?`).get(entry.record_id);
            if (!row)
                continue; // Record was deleted since sync_log entry was created
            const plaintext = Buffer.from(JSON.stringify(row), 'utf8');
            const encBuf = await this.crypto.encrypt(plaintext);
            blobs.push({
                id: entry.record_id,
                table: entry.table_name,
                encryptedPayload: Buffer.from(encBuf).toString('base64'),
            });
        }
        // HMAC checksum over all blob IDs (order-independent sort)
        const ids = blobs.map(b => b.id).sort().join(',');
        const checksumBuf = await this.crypto.hmac(Buffer.from(ids, 'utf8'));
        const checksum = Buffer.from(checksumBuf).toString('hex');
        // Sign the manifest
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
    // ── applyPullPacket ───────────────────────────────────────────────────────
    // Merge an incoming encrypted packet from the server.
    // Only memories table is merged (other tables are device-local).
    async applyPullPacket(packet) {
        this.guard.enforce('sync:pull');
        if (packet.manifest.agentId !== this.agentId) {
            throw new permissions_1.SecurityError('AGENT_MISMATCH', 'Sync packet belongs to a different agent');
        }
        let merged = 0;
        let skipped = 0;
        for (const blob of packet.blobs) {
            try {
                const encBuf = Buffer.from(blob.encryptedPayload, 'base64');
                const decBuf = Buffer.from(await this.crypto.decrypt(encBuf));
                const remote = JSON.parse(decBuf.toString('utf8'));
                if (blob.table === 'memories') {
                    const local = this.db.prepare(`SELECT updated_at FROM memories WHERE id = ?`).get(blob.id);
                    if (!local || remote.updated_at > local.updated_at) {
                        // Upsert: remote wins (last-write-wins)
                        this.db.prepare(`
              INSERT OR REPLACE INTO memories
                (id, content_enc, metadata_enc, integrity_mac, importance, access_count,
                 decay_score, created_at, updated_at, expires_at, agent_id, session_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(remote.id, Buffer.from(remote.content_enc), Buffer.from(remote.metadata_enc), Buffer.from(remote.integrity_mac), remote.importance, remote.access_count, remote.decay_score, remote.created_at, remote.updated_at, remote.expires_at ?? null, remote.agent_id, remote.session_id);
                        merged++;
                    }
                    else {
                        skipped++;
                    }
                }
            }
            catch {
                skipped++;
            }
        }
        return { merged, skipped };
    }
    // ── markSynced ────────────────────────────────────────────────────────────
    // Call after a successful push to clear dirty flags.
    markSynced(recordIds) {
        if (recordIds.length === 0)
            return;
        const placeholders = recordIds.map(() => '?').join(',');
        this.db.prepare(`UPDATE sync_log SET synced = 1 WHERE record_id IN (${placeholders})`)
            .run(...recordIds);
    }
    // ── getSyncStatus ─────────────────────────────────────────────────────────
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