"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeCrypto = void 0;
exports.constantTimeEqual = constantTimeEqual;
exports.hashBytes = hashBytes;
exports.hashString = hashString;
exports.generateId = generateId;
const ed25519_1 = require("@noble/curves/ed25519");
const aes_1 = require("@noble/ciphers/aes");
const hmac_1 = require("@noble/hashes/hmac");
const sha256_1 = require("@noble/hashes/sha256");
const webcrypto_1 = require("@noble/ciphers/webcrypto");
// ─── Node.js Implementation (testing / server-side) ───────────────────────────
class NodeCrypto {
    signingKey;
    encKey;
    macKey;
    pubKey;
    constructor(encKey, macKey, signingKey) {
        this.signingKey = signingKey ?? (0, webcrypto_1.randomBytes)(32);
        this.encKey = encKey ?? (0, webcrypto_1.randomBytes)(32);
        this.macKey = macKey ?? (0, webcrypto_1.randomBytes)(32);
        this.pubKey = ed25519_1.ed25519.getPublicKey(this.signingKey);
    }
    getPublicKey() {
        return this.pubKey;
    }
    async sign(data) {
        return ed25519_1.ed25519.sign(data, this.signingKey);
    }
    async verify(data, sig, pubKey) {
        try {
            return ed25519_1.ed25519.verify(sig, data, pubKey);
        }
        catch {
            return false;
        }
    }
    // Output: nonce(12B) || ciphertext+tag
    async encrypt(plaintext) {
        const nonce = (0, webcrypto_1.randomBytes)(12);
        const cipher = (0, aes_1.gcm)(this.encKey, nonce);
        const ciphertext = cipher.encrypt(plaintext);
        const result = new Uint8Array(12 + ciphertext.length);
        result.set(nonce, 0);
        result.set(ciphertext, 12);
        return result;
    }
    async decrypt(encrypted) {
        const nonce = encrypted.slice(0, 12);
        const ciphertext = encrypted.slice(12);
        const cipher = (0, aes_1.gcm)(this.encKey, nonce);
        return cipher.decrypt(ciphertext);
    }
    async hmac(data) {
        return (0, hmac_1.hmac)(sha256_1.sha256, this.macKey, data);
    }
    async verifyHmac(data, mac) {
        const expected = (0, hmac_1.hmac)(sha256_1.sha256, this.macKey, data);
        return constantTimeEqual(expected, mac);
    }
}
exports.NodeCrypto = NodeCrypto;
// ─── Utilities ─────────────────────────────────────────────────────────────────
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}
function hashBytes(data) {
    return Buffer.from((0, sha256_1.sha256)(data)).toString('hex');
}
function hashString(str) {
    return hashBytes(Buffer.from(str, 'utf8'));
}
function generateId(prefix) {
    const rand = (0, webcrypto_1.randomBytes)(6);
    const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}_${Date.now()}_${hex}`;
}
//# sourceMappingURL=crypto.js.map