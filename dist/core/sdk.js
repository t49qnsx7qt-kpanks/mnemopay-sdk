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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MnemoPay = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const sqliteVec = __importStar(require("sqlite-vec"));
const sha256_1 = require("@noble/hashes/sha256");
const crypto_1 = require("../security/crypto");
const permissions_1 = require("../security/permissions");
const rate_limiter_1 = require("../security/rate-limiter");
const fraud_detector_1 = require("../security/fraud-detector");
const store_1 = require("../memory/store");
const wallet_1 = require("../payments/wallet");
const spatial_prover_1 = require("../gridstamp/spatial-prover");
const encrypted_sync_1 = require("../sync/encrypted-sync");
const embeddings_1 = require("../memory/embeddings");
const index_1 = require("../platform/index");
class MnemoPay {
    config;
    db;
    crypto;
    guard;
    rateLimiter;
    fraud;
    memory;
    wallet;
    spatial;
    sync;
    static _bridge = new index_1.NodeBridge();
    constructor(config, ctx, dbPath) {
        this.config = config;
        this.db = new better_sqlite3_1.default(dbPath);
        sqliteVec.load(this.db);
        // WAL mode for concurrent reads
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        const encKey = config.encryptionKey ?? this._defaultKey(config.agentId);
        const hmacKey = config.hmacKey ?? this._defaultHmacKey(config.agentId);
        const signingKey = config.signingKey ?? this._defaultSigningKey(config.agentId);
        this.crypto = new crypto_1.NodeCrypto(encKey, hmacKey, signingKey);
        this.guard = new permissions_1.PermissionGuard(ctx);
        this.rateLimiter = new rate_limiter_1.RateLimiter();
        this.fraud = new fraud_detector_1.FraudDetector();
        const embedText = (0, embeddings_1.createAsyncEmbedder)(config);
        // Init schemas
        store_1.MemoryStore.initSchema(this.db);
        wallet_1.WalletEngine.initSchema(this.db);
        spatial_prover_1.SpatialProver.initSchema(this.db);
        this.memory = new store_1.MemoryStore(this.db, this.crypto, this.guard, this.rateLimiter, this.fraud, config, embedText);
        this.wallet = new wallet_1.WalletEngine(this.db, this.crypto, this.guard, this.rateLimiter, this.fraud, config.agentId, BigInt(config.dailyLimitCents ?? 100_000));
        this.spatial = new spatial_prover_1.SpatialProver(this.db, this.crypto, this.guard, this.rateLimiter, this.fraud, config);
        this.sync = new encrypted_sync_1.EncryptedSync(this.db, this.crypto, this.guard, config.agentId, config.deviceId ?? 'node-default', embedText);
    }
    // ── Factory ───────────────────────────────────────────────────────────────
    static create(config, permissions) {
        const perms = permissions ?? [
            'memory:read', 'memory:write', 'memory:delete',
            'wallet:read', 'wallet:send', 'wallet:escrow',
            'spatial:prove', 'spatial:verify',
            'sync:push', 'sync:pull',
        ];
        const ctx = (0, permissions_1.buildContext)(config.agentId, perms);
        const dbPath = MnemoPay._resolvePath(config);
        return new MnemoPay(config, ctx, dbPath);
    }
    // Register a hardware platform bridge (call before MnemoPay.create())
    static setPlatformBridge(bridge) {
        MnemoPay._bridge = bridge;
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    // Call at the start of a conversation to inject relevant context.
    async sessionStart(userMessage) {
        return this.memory.autoRecall(userMessage);
    }
    // Call at the end of a conversation to persist salient facts.
    async sessionEnd(conversation, sessionId) {
        await this.memory.autoRetain(conversation, sessionId);
        this.memory.purgeExpired();
    }
    close() {
        this.db.close();
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    _defaultKey(agentId) {
        // Derive a 32-byte key from agentId (deterministic, not cryptographically
        // secure — production should always supply a real encryptionKey)
        return (0, sha256_1.sha256)(Buffer.from(`mnemopay:${agentId}`, 'utf8'));
    }
    _defaultHmacKey(agentId) {
        return (0, sha256_1.sha256)(Buffer.from(`mnemopay:mac:${agentId}`, 'utf8'));
    }
    _defaultSigningKey(agentId) {
        return (0, sha256_1.sha256)(Buffer.from(`mnemopay:sign:${agentId}`, 'utf8'));
    }
    static _resolvePath(config) {
        const dir = config.persistDir ?? path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.mnemopay');
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, `${config.agentId}.db`);
    }
}
exports.MnemoPay = MnemoPay;
//# sourceMappingURL=sdk.js.map