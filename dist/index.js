"use strict";
// @mnemopay/mobile-sdk — on-device Memory + AgentPay + GridStamp
// USD_CENTS only. Ed25519 + AES-256-GCM. SQLite + sqlite-vec.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IOSBridge = exports.AndroidBridge = exports.NodeBridge = exports.SEMANTIC_EMBEDDING_DIM = exports.createAsyncEmbedder = exports.embed = exports.embedHash = exports.EncryptedSync = exports.SpatialProver = exports.WalletEngine = exports.MemoryStore = exports.FraudDetector = exports.RateLimiter = exports.buildContext = exports.SecurityError = exports.PermissionGuard = exports.generateId = exports.NodeCrypto = exports.MnemoPay = void 0;
var sdk_1 = require("./core/sdk");
Object.defineProperty(exports, "MnemoPay", { enumerable: true, get: function () { return sdk_1.MnemoPay; } });
// Security primitives
var crypto_1 = require("./security/crypto");
Object.defineProperty(exports, "NodeCrypto", { enumerable: true, get: function () { return crypto_1.NodeCrypto; } });
Object.defineProperty(exports, "generateId", { enumerable: true, get: function () { return crypto_1.generateId; } });
var permissions_1 = require("./security/permissions");
Object.defineProperty(exports, "PermissionGuard", { enumerable: true, get: function () { return permissions_1.PermissionGuard; } });
Object.defineProperty(exports, "SecurityError", { enumerable: true, get: function () { return permissions_1.SecurityError; } });
Object.defineProperty(exports, "buildContext", { enumerable: true, get: function () { return permissions_1.buildContext; } });
var rate_limiter_1 = require("./security/rate-limiter");
Object.defineProperty(exports, "RateLimiter", { enumerable: true, get: function () { return rate_limiter_1.RateLimiter; } });
var fraud_detector_1 = require("./security/fraud-detector");
Object.defineProperty(exports, "FraudDetector", { enumerable: true, get: function () { return fraud_detector_1.FraudDetector; } });
// Subsystems (for advanced use / testing)
var store_1 = require("./memory/store");
Object.defineProperty(exports, "MemoryStore", { enumerable: true, get: function () { return store_1.MemoryStore; } });
var wallet_1 = require("./payments/wallet");
Object.defineProperty(exports, "WalletEngine", { enumerable: true, get: function () { return wallet_1.WalletEngine; } });
var spatial_prover_1 = require("./gridstamp/spatial-prover");
Object.defineProperty(exports, "SpatialProver", { enumerable: true, get: function () { return spatial_prover_1.SpatialProver; } });
var encrypted_sync_1 = require("./sync/encrypted-sync");
Object.defineProperty(exports, "EncryptedSync", { enumerable: true, get: function () { return encrypted_sync_1.EncryptedSync; } });
// Platform bridges
var embeddings_1 = require("./memory/embeddings");
Object.defineProperty(exports, "embedHash", { enumerable: true, get: function () { return embeddings_1.embedHash; } });
Object.defineProperty(exports, "embed", { enumerable: true, get: function () { return embeddings_1.embed; } });
Object.defineProperty(exports, "createAsyncEmbedder", { enumerable: true, get: function () { return embeddings_1.createAsyncEmbedder; } });
Object.defineProperty(exports, "SEMANTIC_EMBEDDING_DIM", { enumerable: true, get: function () { return embeddings_1.SEMANTIC_EMBEDDING_DIM; } });
var index_1 = require("./platform/index");
Object.defineProperty(exports, "NodeBridge", { enumerable: true, get: function () { return index_1.NodeBridge; } });
Object.defineProperty(exports, "AndroidBridge", { enumerable: true, get: function () { return index_1.AndroidBridge; } });
Object.defineProperty(exports, "IOSBridge", { enumerable: true, get: function () { return index_1.IOSBridge; } });
//# sourceMappingURL=index.js.map