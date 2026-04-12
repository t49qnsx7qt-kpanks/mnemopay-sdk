"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpatialProver = void 0;
const sha256_1 = require("@noble/hashes/sha256");
const crypto_1 = require("../security/crypto");
const permissions_1 = require("../security/permissions");
// H3-like resolution 9 → ~174m hex cells
// Simplified: encode lat/lng to precision-9 tile string
function toH3Tile(lat, lng, precision = 9) {
    const factor = Math.pow(10, precision - 3); // 6 decimal places
    const latQ = Math.round(lat * factor);
    const lngQ = Math.round(lng * factor);
    return `h3:${precision}:${latQ}:${lngQ}`;
}
// Scene hash from sensor readings (camera, lidar, wifi, bluetooth fingerprints)
function sceneHash(readings) {
    const canonical = JSON.stringify(readings, Object.keys(readings).sort());
    return Buffer.from((0, sha256_1.sha256)(Buffer.from(canonical, 'utf8'))).toString('hex');
}
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spatial_proofs (
    id            TEXT    PRIMARY KEY,
    agent_id      TEXT    NOT NULL,
    h3_tile       TEXT    NOT NULL,
    lat           REAL    NOT NULL,
    lng           REAL    NOT NULL,
    accuracy      REAL    NOT NULL,
    scene_hash    TEXT    NOT NULL,
    confidence    REAL    NOT NULL,
    timestamp     INTEGER NOT NULL,
    signature     BLOB    NOT NULL,
    device_id     TEXT    NOT NULL,
    attestation   TEXT,
    verified      INTEGER NOT NULL DEFAULT 0
  );
`;
class SpatialProver {
    db;
    crypto;
    guard;
    rateLimiter;
    fraud;
    config;
    constructor(db, crypto, guard, rateLimiter, fraud, config) {
        this.db = db;
        this.crypto = crypto;
        this.guard = guard;
        this.rateLimiter = rateLimiter;
        this.fraud = fraud;
        this.config = config;
    }
    static initSchema(db) {
        db.exec(SCHEMA);
    }
    // ── prove ─────────────────────────────────────────────────────────────────
    // Generate a signed spatial proof for the current location.
    // sensorReadings: whatever the device can provide (wifi BSSIDs, BT beacons, camera hash, etc.)
    async prove(lat, lng, accuracy, // meters — must be ≤ 100m
    confidence, // 0-1 scene recognition confidence
    sensorReadings, deviceId, attestationToken, // iOS App Attest / Android Play Integrity JWT
    isRooted = false) {
        this.guard.enforce('spatial:prove');
        const { allowed } = this.rateLimiter.check(this.config.agentId, 'spatial');
        if (!allowed)
            throw new permissions_1.SecurityError('RATE_LIMITED', 'Spatial proof rate limit exceeded');
        const now = Date.now();
        // Anti-spoofing checks
        const spoofSig = this.fraud.checkSpatialSpoofing(this.config.agentId, accuracy, now, confidence, isRooted);
        if (spoofSig)
            throw new permissions_1.SecurityError('SPATIAL_SPOOFING', spoofSig.details.reason);
        const velocitySig = this.fraud.checkVelocity(this.config.agentId, lat, lng, now);
        if (velocitySig)
            throw new permissions_1.SecurityError('IMPOSSIBLE_VELOCITY', 'Location velocity exceeds physical limits');
        const h3Tile = toH3Tile(lat, lng);
        const sHash = sceneHash(sensorReadings);
        const proofId = (0, crypto_1.generateId)('sp');
        // Sign proof payload (deterministic, hardware-backed in production)
        const payload = Buffer.from(JSON.stringify({
            id: proofId,
            agentId: this.config.agentId,
            h3Tile,
            lat, lng, accuracy,
            sceneHash: sHash,
            confidence,
            timestamp: now,
            deviceId,
        }), 'utf8');
        const signature = await this.crypto.sign(payload);
        const proof = {
            id: proofId,
            agentId: this.config.agentId,
            h3Tile,
            lat, lng,
            accuracy,
            sceneHash: sHash,
            confidence,
            timestamp: now,
            signature: Buffer.from(signature).toString('hex'),
            deviceId,
            attestation: attestationToken,
            verified: false,
        };
        this.db.prepare(`
      INSERT INTO spatial_proofs
        (id, agent_id, h3_tile, lat, lng, accuracy, scene_hash, confidence,
         timestamp, signature, device_id, attestation, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(proof.id, proof.agentId, proof.h3Tile, proof.lat, proof.lng, proof.accuracy, proof.sceneHash, proof.confidence, proof.timestamp, signature, proof.deviceId, proof.attestation ?? null);
        this.fraud.recordAction(this.config.agentId, `spatial_proof:${h3Tile}`);
        return { proof, passed: true, score: confidence };
    }
    // ── verify ────────────────────────────────────────────────────────────────
    // Verify a spatial proof from another agent (e.g. driver proving pickup).
    // Returns score ∈ [0, 1]. Threshold for payment release: 0.75 (per GridStamp spec).
    async verify(proofId, expectedH3Tile) {
        this.guard.enforce('spatial:verify');
        const row = this.db.prepare(`SELECT * FROM spatial_proofs WHERE id = ?`).get(proofId);
        if (!row)
            throw new permissions_1.SecurityError('NOT_FOUND', `Spatial proof ${proofId} not found`);
        const ageMs = Date.now() - row.timestamp;
        if (ageMs > 5 * 60_000) { // 5 minute staleness limit
            throw new permissions_1.SecurityError('PROOF_STALE', `Proof is ${Math.round(ageMs / 1000)}s old`);
        }
        // Re-verify signature
        const payload = Buffer.from(JSON.stringify({
            id: row.id,
            agentId: row.agent_id,
            h3Tile: row.h3_tile,
            lat: row.lat, lng: row.lng, accuracy: row.accuracy,
            sceneHash: row.scene_hash,
            confidence: row.confidence,
            timestamp: row.timestamp,
            deviceId: row.device_id,
        }), 'utf8');
        const sigBuf = Buffer.from(row.signature);
        const valid = await this.crypto.verify(payload, sigBuf, this.crypto.getPublicKey());
        if (!valid)
            throw new permissions_1.SecurityError('INVALID_SIGNATURE', 'Spatial proof signature invalid');
        // Optional: check expected tile (e.g. scheduled pickup location)
        if (expectedH3Tile && row.h3_tile !== expectedH3Tile) {
            return {
                proof: this._rowToProof(row),
                passed: false,
                score: 0,
                reason: `Expected tile ${expectedH3Tile}, got ${row.h3_tile}`,
            };
        }
        // Score: confidence * accuracy_factor (GPS < 10m = 1.0, degrades linearly to 0 at 100m)
        const accuracyFactor = Math.max(0, 1 - (row.accuracy - 10) / 90);
        const score = row.confidence * (0.6 + 0.4 * accuracyFactor);
        const passed = score >= 0.75;
        if (passed) {
            this.db.prepare(`UPDATE spatial_proofs SET verified = 1 WHERE id = ?`).run(proofId);
        }
        return { proof: this._rowToProof(row, passed), passed, score };
    }
    // ── proofForEscrow ────────────────────────────────────────────────────────
    // Convenience: prove location AND mark an escrow condition as met if score passes.
    // Used by Dele driver flow: driver calls this at pickup → escrow unlocks.
    async proveAndMarkEscrow(escrowId, conditionType, markConditionFn, lat, lng, accuracy, confidence, sensorReadings, deviceId, expectedH3Tile) {
        const result = await this.prove(lat, lng, accuracy, confidence, sensorReadings, deviceId);
        if (expectedH3Tile) {
            // Re-verify against expected location
            const verifyResult = await this.verify(result.proof.id, expectedH3Tile);
            if (!verifyResult.passed)
                return verifyResult;
        }
        if (result.passed) {
            markConditionFn(escrowId, conditionType);
        }
        return result;
    }
    getProof(proofId) {
        const row = this.db.prepare(`SELECT * FROM spatial_proofs WHERE id = ?`).get(proofId);
        return row ? this._rowToProof(row) : null;
    }
    getProofHistory(limit = 20) {
        const rows = this.db.prepare(`
      SELECT * FROM spatial_proofs WHERE agent_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(this.config.agentId, limit);
        return rows.map(r => this._rowToProof(r));
    }
    _rowToProof(row, verified) {
        return {
            id: row.id,
            agentId: row.agent_id,
            h3Tile: row.h3_tile,
            lat: row.lat, lng: row.lng,
            accuracy: row.accuracy,
            sceneHash: row.scene_hash,
            confidence: row.confidence,
            timestamp: row.timestamp,
            signature: Buffer.from(row.signature).toString('hex'),
            deviceId: row.device_id,
            attestation: row.attestation ?? undefined,
            verified: verified ?? row.verified === 1,
        };
    }
}
exports.SpatialProver = SpatialProver;
//# sourceMappingURL=spatial-prover.js.map