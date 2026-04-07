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
  | "admin";          // Full administrative access

export interface IdentityVerification {
  valid: boolean;
  agentId: string;
  reason?: string;
  identity?: AgentIdentity;
  activeToken?: CapabilityToken;
}

// ─── Crypto Utilities ───────────────────────────────────────────────────────

import { createHmac, randomBytes } from "crypto";

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

// ─── Identity Registry ──────────────────────────────────────────────────────

export class IdentityRegistry {
  private identities: Map<string, AgentIdentity> = new Map();
  private tokens: Map<string, CapabilityToken> = new Map();
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
   */
  sign(agentId: string, message: string): string {
    const identity = this.identities.get(agentId);
    if (!identity) throw new Error(`Unknown agent: ${agentId}`);
    return signMessage(message, identity.privateKey);
  }

  // ── Serialization ────────────────────────────────────────────────────────

  serialize(): {
    identities: AgentIdentity[];
    tokens: CapabilityToken[];
  } {
    return {
      identities: Array.from(this.identities.values()),
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
