import { ed25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/ciphers/webcrypto';

// ─── Platform Bridge Interface ─────────────────────────────────────────────────
// Production: Android uses StrongBox Keymaster, iOS uses Secure Enclave
// Testing:    NodeCrypto uses @noble pure-JS implementation

export interface PlatformCrypto {
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(data: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): Promise<boolean>;
  getPublicKey(): Uint8Array;
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
  hmac(data: Uint8Array): Promise<Uint8Array>;
  verifyHmac(data: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

// ─── Node.js Implementation (testing / server-side) ───────────────────────────

export class NodeCrypto implements PlatformCrypto {
  private signingKey: Uint8Array;
  private encKey: Uint8Array;
  private macKey: Uint8Array;
  private pubKey: Uint8Array;

  constructor(encKey?: Uint8Array, macKey?: Uint8Array, signingKey?: Uint8Array) {
    this.signingKey = signingKey ?? randomBytes(32);
    this.encKey = encKey ?? randomBytes(32);
    this.macKey = macKey ?? randomBytes(32);
    this.pubKey = ed25519.getPublicKey(this.signingKey);
  }

  getPublicKey(): Uint8Array {
    return this.pubKey;
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return ed25519.sign(data, this.signingKey);
  }

  async verify(data: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): Promise<boolean> {
    try {
      return ed25519.verify(sig, data, pubKey);
    } catch {
      return false;
    }
  }

  // Output: nonce(12B) || ciphertext+tag
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = randomBytes(12);
    const cipher = gcm(this.encKey, nonce);
    const ciphertext = cipher.encrypt(plaintext);
    const result = new Uint8Array(12 + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, 12);
    return result;
  }

  async decrypt(encrypted: Uint8Array): Promise<Uint8Array> {
    const nonce = encrypted.slice(0, 12);
    const ciphertext = encrypted.slice(12);
    const cipher = gcm(this.encKey, nonce);
    return cipher.decrypt(ciphertext);
  }

  async hmac(data: Uint8Array): Promise<Uint8Array> {
    return hmac(sha256, this.macKey, data);
  }

  async verifyHmac(data: Uint8Array, mac: Uint8Array): Promise<boolean> {
    const expected = hmac(sha256, this.macKey, data);
    return constantTimeEqual(expected, mac);
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export function hashBytes(data: Uint8Array): string {
  return Buffer.from(sha256(data)).toString('hex');
}

export function hashString(str: string): string {
  return hashBytes(Buffer.from(str, 'utf8'));
}

export function generateId(prefix: string): string {
  const rand = randomBytes(6);
  const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now()}_${hex}`;
}
