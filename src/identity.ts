/**
 * Agent Identity System for MnemoPay
 *
 * Inspired by the elephant's olfactory signature system — each elephant has
 * a unique chemical identity recognizable by kin after 12+ years of separation.
 * Similarly, each MnemoPay agent gets a unique cryptographic identity that
 * persists across sessions and enables trust verification.
 *
 * Components:
 *   - AgentIdentity: Cryptographic keypair + metadata for each agent
 *   - CapabilityToken: Scoped, time-limited permissions for agent actions
 *   - IdentityRegistry: Discovery and verification of agent identities
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentIdentity {
  /** Unique agent identifier */
  agentId: string;
  /** Public key (hex-encoded) for verification */
  publicKey: string;
  /** Private key (hex-encoded) — never expose to agent runtime */
  privateKey: string;
  /** Human/org owner of this agent */
  ownerId: string;
  /** Display name for the agent */
  displayName?: string;
  /** Agent's declared capabilities */
  capabilities: string[];
  /** ISO timestamp of identity creation */
  createdAt: string;
  /** ISO timestamp of last activity */
  lastActiveAt: string;
  /** Whether the identity has been verified by the owner */
  verified: boolean;
  /** Metadata for KYA (Know Your Agent) compliance */
  kya: KYARecord;
}

export interface KYARecord {
  /** Owner type: individual or organization */
  ownerType: "individual" | "organization";
  /** Owner's verified email (required) */
  ownerEmail: string;
  /** Owner's country code (ISO 3166-1 alpha-2) */
  ownerCountry?: string;
  /** Owner's KYC verification status */
  ownerKycStatus: "unverified" | "pending" | "verified";
  /** Timestamp of last KYC verification */
  kycVerifiedAt?: string;
  /** Whether the agent is authorized for financial transactions */
  financialAuthorized: boolean;
}

export interface CapabilityToken {
  /** Unique token ID */
  id: string;
  /** Agent this token authorizes */
  agentId: string;
  /** Scoped permissions */
  permissions: Permission[];
  /** Maximum transaction amount per action */
  maxAmount?: number;
  /** Maximum total spend during token lifetime */
  maxTotalSpend?: number;
  /** Total amount spent under this token so far */
  totalSpent: number;
  /** Allowed counterparty agent IDs (empty = any) */
  allowedCounterparties: string[];
  /** Allowed transaction categories (empty = any) */
  allowedCategories: string[];
  /** ISO timestamp when token was issued */
  issuedAt: string;
  /** ISO timestamp when token expires */
  expiresAt: string;
  /** Whether the token has been revoked */
  revoked: boolean;
  /** Who issued this token (owner or system) */
  issuedBy: string;
}

export type Permission =
  | "charge"          // Create payment holds
  | "settle"          // Complete settlements
  | "refund"          // Issue refunds
  | "remember"        // Store memories
  | "recall"          // Retrieve memories
  | "transfer"        // Agent-to-agent transfers
  | "subscribe"       // Create recurring payments
  | "credit"          // Access credit lines
  | "sign"            // Sign messages (inter-agent verification)
  | "admin";          // Full administrative access

export interface IdentityVerification {
  valid: boolean;
  agentId: string;
  reason?: string;
  identity?: AgentIdentity;
  activeToken?: CapabilityToken;
}

// ─── Crypto Utilities ───────────────────────────────────────────────────────

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

function generateKeyPair(): { publicKey: string; privateKey: string } {
  // 32 random bytes for private key
  const privateKeyBuf = randomBytes(32);
  const privateKey = privateKeyBuf.toString("hex");

  // Derive public key deterministically from private key via HMAC-SHA256
  const publicKey = createHmac("sha256", privateKeyBuf)
    .update("mnemopay-v1-public-key-derivation")
    .digest("hex");

  return { publicKey, privateKey };
}

function signMessage(message: string, privateKey: string): string {
  // HMAC-SHA256 signature using the agent's private key
  return createHmac("sha256", Buffer.from(privateKey, "hex"))
    .update(message)
    .digest("hex");
}

/**
 * Constant-time HMAC signature verification.
 * Prevents timing side-channel attacks where an attacker measures response
 * time to brute-force signatures byte by byte.
 */
function verifySignature(message: string, signature: string, publicKey: string): boolean {
  try {
    // Recompute expected signature from the public key (which is the HMAC of the private key)
    // For verification, we compare the provided signature against one we compute
    const expected = createHmac("sha256", Buffer.from(publicKey, "hex"))
      .update(message)
      .digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison for tokens/secrets.
 * Prevents timing attacks on Bearer token, API key, or token ID comparisons.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "utf-8");
    const bBuf = Buffer.from(b, "utf-8");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

// ─── Replay Protection ────────────────────────────────────────────────────

const NONCE_WINDOW_MS = 5 * 60_000; // 5-minute window for nonce validity
const MAX_NONCES = 10_000;          // Max nonces to track (prevents memory exhaustion)

// ─── Identity Registry ──────────────────────────────────────────────────────

export class IdentityRegistry {
  private identities: Map<string, AgentIdentity> = new Map();
  private tokens: Map<string, CapabilityToken> = new Map();
  /** Used nonces for replay protection — tracks {nonce → timestamp} */
  private usedNonces: Map<string, number> = new Map();
  private agentTokens: Map<string, Set<string>> = new Map(); // agentId → token IDs

  /**
   * Create a new agent identity with a cryptographic keypair.
   */
  createIdentity(
    agentId: string,
    ownerId: string,
    ownerEmail: string,
    options?: {
      displayName?: string;
      capabilities?: string[];
      ownerType?: "individual" | "organization";
      ownerCountry?: string;
    },
  ): AgentIdentity {
    if (this.identities.has(agentId)) {
      throw new Error(`Agent identity already exists: ${agentId}`);
    }

    const { publicKey, privateKey } = generateKeyPair();
    const now = new Date().toISOString();

    const identity: AgentIdentity = {
      agentId,
      publicKey,
      privateKey,
      ownerId,
      displayName: options?.displayName,
      capabilities: options?.capabilities ?? [],
      createdAt: now,
      lastActiveAt: now,
      verified: false,
      kya: {
        ownerType: options?.ownerType ?? "individual",
        ownerEmail,
        ownerCountry: options?.ownerCountry,
        ownerKycStatus: "unverified",
        financialAuthorized: false,
      },
    };

    this.identities.set(agentId, identity);
    return identity;
  }

  /**
   * Get an agent's identity (public info only — strips private key).
   */
  getIdentity(agentId: string): Omit<AgentIdentity, "privateKey"> | null {
    const identity = this.identities.get(agentId);
    if (!identity) return null;
    const { privateKey: _, ...publicIdentity } = identity;
    return publicIdentity;
  }

  /**
   * Verify an agent's KYC status (mark as verified after external check).
   */
  verifyKYC(agentId: string): void {
    const identity = this.identities.get(agentId);
    if (!identity) throw new Error(`Unknown agent: ${agentId}`);
    identity.kya.ownerKycStatus = "verified";
    identity.kya.kycVerifiedAt = new Date().toISOString();
    identity.kya.financialAuthorized = true;
    identity.verified = true;
  }

  /**
   * Issue a scoped capability token to an agent.
   */
  issueToken(
    agentId: string,
    permissions: Permission[],
    options?: {
      maxAmount?: number;
      maxTotalSpend?: number;
      allowedCounterparties?: string[];
      allowedCategories?: string[];
      expiresInMinutes?: number;
      issuedBy?: string;
    },
  ): CapabilityToken {
    const identity = this.identities.get(agentId);
    if (!identity) throw new Error(`Unknown agent: ${agentId}`);

    const now = new Date();
    const expiresInMs = (options?.expiresInMinutes ?? 60) * 60_000;

    const token: CapabilityToken = {
      id: crypto.randomUUID(),
      agentId,
      permissions,
      maxAmount: options?.maxAmount,
      maxTotalSpend: options?.maxTotalSpend,
      totalSpent: 0,
      allowedCounterparties: options?.allowedCounterparties ?? [],
      allowedCategories: options?.allowedCategories ?? [],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
      revoked: false,
      issuedBy: options?.issuedBy ?? identity.ownerId,
    };

    this.tokens.set(token.id, token);

    // Track tokens per agent
    if (!this.agentTokens.has(agentId)) {
      this.agentTokens.set(agentId, new Set());
    }
    this.agentTokens.get(agentId)!.add(token.id);

    return token;
  }

  /**
   * Validate a capability token for a specific action.
   */
  validateToken(
    tokenId: string,
    action: Permission,
    amount?: number,
    counterpartyId?: string,
  ): IdentityVerification {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return { valid: false, agentId: "", reason: "Token not found" };
    }
    if (token.revoked) {
      return { valid: false, agentId: token.agentId, reason: "Token has been revoked" };
    }

    // Check expiry
    if (new Date() > new Date(token.expiresAt)) {
      return { valid: false, agentId: token.agentId, reason: "Token has expired" };
    }

    // Check permission
    if (!token.permissions.includes(action) && !token.permissions.includes("admin")) {
      return { valid: false, agentId: token.agentId, reason: `Token does not grant '${action}' permission` };
    }

    // Check per-transaction amount limit
    if (amount !== undefined && token.maxAmount !== undefined && amount > token.maxAmount) {
      return {
        valid: false,
        agentId: token.agentId,
        reason: `Amount $${amount} exceeds token limit $${token.maxAmount}`,
      };
    }

    // Check total spend limit
    if (amount !== undefined && token.maxTotalSpend !== undefined) {
      if (token.totalSpent + amount > token.maxTotalSpend) {
        return {
          valid: false,
          agentId: token.agentId,
          reason: `Total spend would exceed limit ($${token.totalSpent + amount} > $${token.maxTotalSpend})`,
        };
      }
    }

    // Check counterparty whitelist
    if (counterpartyId && token.allowedCounterparties.length > 0) {
      if (!token.allowedCounterparties.includes(counterpartyId)) {
        return {
          valid: false,
          agentId: token.agentId,
          reason: `Counterparty '${counterpartyId}' not in allowed list`,
        };
      }
    }

    const identity = this.identities.get(token.agentId);

    return {
      valid: true,
      agentId: token.agentId,
      identity: identity ? { ...identity, privateKey: "[redacted]" } : undefined,
      activeToken: token,
    };
  }

  /**
   * Record spending against a token's total spend limit.
   */
  recordSpend(tokenId: string, amount: number): void {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error(`Token not found: ${tokenId}`);
    token.totalSpent += amount;
  }

  /**
   * Revoke a capability token immediately.
   */
  revokeToken(tokenId: string): void {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error(`Token not found: ${tokenId}`);
    token.revoked = true;
  }

  /**
   * Revoke ALL tokens for an agent (kill switch).
   */
  revokeAllTokens(agentId: string): number {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return 0;
    let revoked = 0;
    for (const id of tokenIds) {
      const token = this.tokens.get(id);
      if (token && !token.revoked) {
        token.revoked = true;
        revoked++;
      }
    }
    return revoked;
  }

  /**
   * List all active (non-revoked, non-expired) tokens for an agent.
   */
  listActiveTokens(agentId: string): CapabilityToken[] {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return [];
    const now = new Date();
    return Array.from(tokenIds)
      .map(id => this.tokens.get(id)!)
      .filter(t => !t.revoked && new Date(t.expiresAt) > now);
  }

  /**
   * Update last active timestamp (call on any agent activity).
   */
  touch(agentId: string): void {
    const identity = this.identities.get(agentId);
    if (identity) {
      identity.lastActiveAt = new Date().toISOString();
    }
  }

  /**
   * Sign a message with an agent's private key (for inter-agent verification).
   * Includes nonce + timestamp for replay protection.
   * Returns: "nonce:timestamp:signature"
   */
  sign(agentId: string, message: string, tokenId?: string): string {
    const identity = this.identities.get(agentId);
    if (!identity) throw new Error(`Unknown agent: ${agentId}`);
    // Require a valid capability token with "sign" permission if tokens exist for this agent
    if (tokenId) {
      const validation = this.validateToken(tokenId, "sign", 0, undefined);
      if (!validation.valid) throw new Error(`Sign permission denied: ${validation.reason}`);
    } else if (this.agentTokens.has(agentId) && this.agentTokens.get(agentId)!.size > 0) {
      throw new Error("Token required: agent has capability tokens — provide tokenId to sign");
    }
    // Replay protection: embed nonce + timestamp into the signed payload
    const nonce = randomBytes(16).toString("hex");
    const timestamp = Date.now().toString();
    const payload = `${nonce}:${timestamp}:${message}`;
    const signature = signMessage(payload, identity.privateKey);
    return `${nonce}:${timestamp}:${signature}`;
  }

  /**
   * Verify a signed message. Checks:
   *   1. Signature is cryptographically valid (constant-time comparison)
   *   2. Timestamp is within the replay window (5 minutes)
   *   3. Nonce has not been used before (prevents replay attacks)
   */
  verifySignedMessage(agentId: string, message: string, signedPayload: string): { valid: boolean; reason?: string } {
    const identity = this.identities.get(agentId);
    if (!identity) return { valid: false, reason: "Unknown agent" };

    const parts = signedPayload.split(":");
    if (parts.length < 3) return { valid: false, reason: "Invalid signature format" };
    const nonce = parts[0];
    const timestamp = parts[1];
    const signature = parts.slice(2).join(":");

    // Check timestamp freshness (prevent replay of old messages)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) return { valid: false, reason: "Invalid timestamp" };
    const age = Date.now() - ts;
    if (age > NONCE_WINDOW_MS) return { valid: false, reason: "Signature expired (older than 5 minutes)" };
    if (age < -30_000) return { valid: false, reason: "Signature from the future" }; // 30s clock skew tolerance

    // Check nonce hasn't been used (prevents replay within the window)
    if (this.usedNonces.has(nonce)) return { valid: false, reason: "Nonce already used (replay detected)" };

    // Verify signature (constant-time)
    const payload = `${nonce}:${timestamp}:${message}`;
    const expected = signMessage(payload, identity.privateKey);
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return { valid: false, reason: "Invalid signature" };
    if (!timingSafeEqual(sigBuf, expBuf)) return { valid: false, reason: "Invalid signature" };

    // Record nonce to prevent replay
    this.usedNonces.set(nonce, Date.now());
    this._pruneNonces();

    return { valid: true };
  }

  /**
   * Prune expired nonces to prevent memory exhaustion.
   */
  private _pruneNonces(): void {
    if (this.usedNonces.size <= MAX_NONCES / 2) return;
    const cutoff = Date.now() - NONCE_WINDOW_MS;
    for (const [nonce, ts] of this.usedNonces) {
      if (ts < cutoff) this.usedNonces.delete(nonce);
    }
    // Hard cap: if still too many, drop oldest
    if (this.usedNonces.size > MAX_NONCES) {
      const sorted = Array.from(this.usedNonces.entries()).sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, sorted.length - MAX_NONCES);
      for (const [nonce] of toRemove) this.usedNonces.delete(nonce);
    }
  }

  /**
   * Garbage-collect expired and revoked tokens to prevent unbounded memory growth.
   * Call periodically (e.g., every reconciliation cycle).
   */
  purgeExpiredTokens(): number {
    const now = new Date();
    let purged = 0;
    for (const [id, token] of this.tokens) {
      if (token.revoked || new Date(token.expiresAt) < now) {
        this.tokens.delete(id);
        const agentSet = this.agentTokens.get(token.agentId);
        if (agentSet) agentSet.delete(id);
        purged++;
      }
    }
    return purged;
  }

  // ── Serialization ────────────────────────────────────────────────────────

  serialize(): {
    identities: Omit<AgentIdentity, "privateKey">[];
    tokens: CapabilityToken[];
  } {
    return {
      identities: Array.from(this.identities.values()).map(({ privateKey, ...safe }) => safe),
      tokens: Array.from(this.tokens.values()),
    };
  }

  static deserialize(data: {
    identities: AgentIdentity[];
    tokens: CapabilityToken[];
  }): IdentityRegistry {
    const registry = new IdentityRegistry();
    for (const id of data.identities) {
      registry.identities.set(id.agentId, id);
    }
    for (const token of data.tokens) {
      registry.tokens.set(token.id, token);
      if (!registry.agentTokens.has(token.agentId)) {
        registry.agentTokens.set(token.agentId, new Set());
      }
      registry.agentTokens.get(token.agentId)!.add(token.id);
    }
    return registry;
  }

  get size(): number {
    return this.identities.size;
  }
}
