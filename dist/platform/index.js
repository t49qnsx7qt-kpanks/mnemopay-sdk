"use strict";
// Platform bridge interface — implemented by NodeBridge (testing/server),
// AndroidBridge (React Native Android), and IOSBridge (React Native iOS).
// The mobile-sdk ships the NodeBridge by default; native bridges are
// registered via MnemoPay.setPlatformBridge() before first use.
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
exports.IOSBridge = exports.AndroidBridge = exports.NodeBridge = exports.NodeCrypto = void 0;
var crypto_1 = require("../security/crypto");
Object.defineProperty(exports, "NodeCrypto", { enumerable: true, get: function () { return crypto_1.NodeCrypto; } });
// ── NodeBridge ─────────────────────────────────────────────────────────────
// Used in Node.js (server-side agents, CLI tools, testing).
// No hardware security — falls back to software crypto.
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const webcrypto_1 = require("@noble/ciphers/webcrypto");
class NodeBridge {
    _deviceId;
    constructor(deviceId) {
        // Stable device ID: derive from hostname + username, or accept explicit
        this._deviceId = deviceId ?? Buffer.from(`${os.hostname()}:${os.userInfo().username}`).toString('hex').slice(0, 32);
    }
    async getDeviceInfo() {
        return {
            deviceId: this._deviceId,
            platform: 'node',
            isRooted: false,
            osVersion: `${os.type()} ${os.release()}`,
            sdkVersion: '0.1.0',
        };
    }
    async getAttestation(_challenge) {
        // No hardware attestation in Node.js — return soft attestation
        return {
            token: Buffer.from((0, webcrypto_1.randomBytes)(32)).toString('hex'),
            provider: 'none',
            timestamp: Date.now(),
        };
    }
    getDatabasePath(filename) {
        // Store in ~/.mnemopay/ on Node.js
        return path.join(os.homedir(), '.mnemopay', filename);
    }
}
exports.NodeBridge = NodeBridge;
// ── AndroidBridge stub ─────────────────────────────────────────────────────
// Real implementation lives in the React Native native module.
// This stub satisfies TypeScript at build time.
class AndroidBridge {
    async getDeviceInfo() {
        throw new Error('AndroidBridge requires React Native native module. Install @mnemopay/react-native.');
    }
    async getAttestation(_challenge) {
        throw new Error('AndroidBridge requires React Native native module.');
    }
    getDatabasePath(filename) {
        // Android: app-private files dir (encrypted by FileVault on Android 10+)
        return `/data/data/com.mnemopay/${filename}`;
    }
}
exports.AndroidBridge = AndroidBridge;
// ── IOSBridge stub ─────────────────────────────────────────────────────────
class IOSBridge {
    async getDeviceInfo() {
        throw new Error('IOSBridge requires React Native native module. Install @mnemopay/react-native.');
    }
    async getAttestation(_challenge) {
        throw new Error('IOSBridge requires React Native native module.');
    }
    getDatabasePath(filename) {
        // iOS: Documents directory (excluded from iCloud backup by default)
        return `~/Documents/MnemoPay/${filename}`;
    }
}
exports.IOSBridge = IOSBridge;
//# sourceMappingURL=index.js.map