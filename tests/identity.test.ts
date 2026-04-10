import { describe, it, expect, beforeEach } from "vitest";
import {
  IdentityRegistry,
  type AgentIdentity,
  type CapabilityToken,
  type Permission,
} from "../src/identity.js";

describe("IdentityRegistry — Agent Identity & Capability Tokens", () => {
  let registry: IdentityRegistry;

  beforeEach(() => {
    registry = new IdentityRegistry();
  });

  // ── Identity Creation ───────────────────────────────────────────────────

  describe("createIdentity()", () => {
    it("creates an identity with cryptographic keypair", () => {
      const id = registry.createIdentity("agent-1", "owner-1", "owner@example.com");
      expect(id.agentId).toBe("agent-1");
      expect(id.ownerId).toBe("owner-1");
      expect(id.publicKey).toHaveLength(88); // Ed25519 SPKI DER (44 bytes hex)
      expect(id.privateKey).toHaveLength(96); // Ed25519 PKCS8 DER (48 bytes hex)
      expect(id.publicKey).not.toBe(id.privateKey);
      expect(id.verified).toBe(false);
      expect(id.kya.ownerEmail).toBe("owner@example.com");
      expect(id.kya.ownerKycStatus).toBe("unverified");
      expect(id.kya.financialAuthorized).toBe(false);
    });

    it("accepts optional display name and capabilities", () => {
      const id = registry.createIdentity("agent-2", "owner-1", "o@e.com", {
        displayName: "Shopping Bot",
        capabilities: ["purchase", "compare"],
      });
      expect(id.displayName).toBe("Shopping Bot");
      expect(id.capabilities).toEqual(["purchase", "compare"]);
    });

    it("rejects duplicate agent IDs", () => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
      expect(() => registry.createIdentity("agent-1", "owner-2", "x@e.com"))
        .toThrow("already exists");
    });

    it("supports organization owner type", () => {
      const id = registry.createIdentity("agent-3", "org-1", "team@corp.com", {
        ownerType: "organization",
        ownerCountry: "US",
      });
      expect(id.kya.ownerType).toBe("organization");
      expect(id.kya.ownerCountry).toBe("US");
    });

    it("tracks registry size", () => {
      expect(registry.size).toBe(0);
      registry.createIdentity("a1", "o1", "a@b.com");
      registry.createIdentity("a2", "o1", "a@b.com");
      expect(registry.size).toBe(2);
    });
  });

  // ── Identity Retrieval ──────────────────────────────────────────────────

  describe("getIdentity()", () => {
    it("returns public identity without private key", () => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
      const pub = registry.getIdentity("agent-1");
      expect(pub).not.toBeNull();
      expect(pub!.agentId).toBe("agent-1");
      expect("privateKey" in pub!).toBe(false);
    });

    it("returns null for unknown agent", () => {
      expect(registry.getIdentity("nonexistent")).toBeNull();
    });
  });

  // ── KYC Verification ───────────────────────────────────────────────────

  describe("verifyKYC()", () => {
    it("marks agent as verified and financially authorized", () => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
      registry.verifyKYC("agent-1");

      const id = registry.getIdentity("agent-1")!;
      expect(id.verified).toBe(true);
      expect(id.kya.ownerKycStatus).toBe("verified");
      expect(id.kya.financialAuthorized).toBe(true);
      expect(id.kya.kycVerifiedAt).toBeDefined();
    });

    it("throws for unknown agent", () => {
      expect(() => registry.verifyKYC("ghost")).toThrow("Unknown agent");
    });
  });

  // ── Token Issuance ──────────────────────────────────────────────────────

  describe("issueToken()", () => {
    beforeEach(() => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
    });

    it("issues a token with specified permissions", () => {
      const token = registry.issueToken("agent-1", ["charge", "settle"]);
      expect(token.agentId).toBe("agent-1");
      expect(token.permissions).toEqual(["charge", "settle"]);
      expect(token.revoked).toBe(false);
      expect(token.totalSpent).toBe(0);
      expect(token.issuedBy).toBe("owner-1");
    });

    it("applies amount limits", () => {
      const token = registry.issueToken("agent-1", ["charge"], {
        maxAmount: 100,
        maxTotalSpend: 500,
      });
      expect(token.maxAmount).toBe(100);
      expect(token.maxTotalSpend).toBe(500);
    });

    it("applies counterparty whitelist", () => {
      const token = registry.issueToken("agent-1", ["charge"], {
        allowedCounterparties: ["agent-2", "agent-3"],
      });
      expect(token.allowedCounterparties).toEqual(["agent-2", "agent-3"]);
    });

    it("applies category restrictions", () => {
      const token = registry.issueToken("agent-1", ["charge"], {
        allowedCategories: ["food", "transport"],
      });
      expect(token.allowedCategories).toEqual(["food", "transport"]);
    });

    it("sets custom expiry", () => {
      const token = registry.issueToken("agent-1", ["charge"], {
        expiresInMinutes: 30,
      });
      const issued = new Date(token.issuedAt).getTime();
      const expires = new Date(token.expiresAt).getTime();
      expect(expires - issued).toBe(30 * 60_000);
    });

    it("defaults to 60-minute expiry", () => {
      const token = registry.issueToken("agent-1", ["charge"]);
      const issued = new Date(token.issuedAt).getTime();
      const expires = new Date(token.expiresAt).getTime();
      expect(expires - issued).toBe(60 * 60_000);
    });

    it("throws for unknown agent", () => {
      expect(() => registry.issueToken("ghost", ["charge"])).toThrow("Unknown agent");
    });
  });

  // ── Token Validation ────────────────────────────────────────────────────

  describe("validateToken()", () => {
    let token: CapabilityToken;

    beforeEach(() => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
      token = registry.issueToken("agent-1", ["charge", "settle"], {
        maxAmount: 100,
        maxTotalSpend: 500,
        allowedCounterparties: ["agent-2"],
      });
    });

    it("validates a permitted action", () => {
      const result = registry.validateToken(token.id, "charge");
      expect(result.valid).toBe(true);
      expect(result.agentId).toBe("agent-1");
      expect(result.identity).toBeDefined();
      expect(result.identity!.privateKey).toBe("[redacted]");
      expect(result.activeToken).toBeDefined();
    });

    it("rejects unauthorized permission", () => {
      const result = registry.validateToken(token.id, "refund");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("refund");
    });

    it("admin token grants all permissions", () => {
      const adminToken = registry.issueToken("agent-1", ["admin"]);
      expect(registry.validateToken(adminToken.id, "charge").valid).toBe(true);
      expect(registry.validateToken(adminToken.id, "refund").valid).toBe(true);
      expect(registry.validateToken(adminToken.id, "transfer").valid).toBe(true);
    });

    it("rejects amount exceeding per-transaction limit", () => {
      const result = registry.validateToken(token.id, "charge", 150);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceeds");
    });

    it("allows amount within per-transaction limit", () => {
      const result = registry.validateToken(token.id, "charge", 50);
      expect(result.valid).toBe(true);
    });

    it("rejects when total spend would exceed limit", () => {
      // Spend 450 first
      registry.recordSpend(token.id, 450);
      // Try to spend 60 more (total = 510 > 500)
      const result = registry.validateToken(token.id, "charge", 60);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceed limit");
    });

    it("allows spend within total limit", () => {
      registry.recordSpend(token.id, 400);
      const result = registry.validateToken(token.id, "charge", 50);
      expect(result.valid).toBe(true);
    });

    it("rejects unauthorized counterparty", () => {
      const result = registry.validateToken(token.id, "charge", 50, "agent-99");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not in allowed list");
    });

    it("allows whitelisted counterparty", () => {
      const result = registry.validateToken(token.id, "charge", 50, "agent-2");
      expect(result.valid).toBe(true);
    });

    it("allows any counterparty when whitelist is empty", () => {
      const openToken = registry.issueToken("agent-1", ["charge"]);
      const result = registry.validateToken(openToken.id, "charge", 50, "anyone");
      expect(result.valid).toBe(true);
    });

    it("rejects revoked token", () => {
      registry.revokeToken(token.id);
      const result = registry.validateToken(token.id, "charge");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("revoked");
    });

    it("rejects expired token", () => {
      // Issue a token that expires immediately
      const shortToken = registry.issueToken("agent-1", ["charge"], {
        expiresInMinutes: -1, // already expired
      });
      const result = registry.validateToken(shortToken.id, "charge");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("returns not found for unknown token", () => {
      const result = registry.validateToken("nonexistent", "charge");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  // ── Token Lifecycle ─────────────────────────────────────────────────────

  describe("token lifecycle", () => {
    beforeEach(() => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
    });

    it("recordSpend accumulates total spent", () => {
      const token = registry.issueToken("agent-1", ["charge"], { maxTotalSpend: 1000 });
      registry.recordSpend(token.id, 100);
      registry.recordSpend(token.id, 200);
      // Validate shows remaining capacity
      const result = registry.validateToken(token.id, "charge", 700);
      expect(result.valid).toBe(true);
      // One more dollar tips it over
      registry.recordSpend(token.id, 700);
      const result2 = registry.validateToken(token.id, "charge", 1);
      expect(result2.valid).toBe(false);
    });

    it("revokeToken prevents further use", () => {
      const token = registry.issueToken("agent-1", ["charge"]);
      expect(registry.validateToken(token.id, "charge").valid).toBe(true);
      registry.revokeToken(token.id);
      expect(registry.validateToken(token.id, "charge").valid).toBe(false);
    });

    it("revokeAllTokens is a kill switch", () => {
      const t1 = registry.issueToken("agent-1", ["charge"]);
      const t2 = registry.issueToken("agent-1", ["settle"]);
      const t3 = registry.issueToken("agent-1", ["refund"]);

      const revoked = registry.revokeAllTokens("agent-1");
      expect(revoked).toBe(3);

      expect(registry.validateToken(t1.id, "charge").valid).toBe(false);
      expect(registry.validateToken(t2.id, "settle").valid).toBe(false);
      expect(registry.validateToken(t3.id, "refund").valid).toBe(false);
    });

    it("revokeAllTokens returns 0 for unknown agent", () => {
      expect(registry.revokeAllTokens("ghost")).toBe(0);
    });

    it("listActiveTokens excludes revoked and expired", () => {
      const t1 = registry.issueToken("agent-1", ["charge"]);
      const t2 = registry.issueToken("agent-1", ["settle"]);
      registry.issueToken("agent-1", ["refund"], { expiresInMinutes: -1 }); // expired
      registry.revokeToken(t1.id);

      const active = registry.listActiveTokens("agent-1");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(t2.id);
    });

    it("listActiveTokens returns empty for unknown agent", () => {
      expect(registry.listActiveTokens("ghost")).toEqual([]);
    });
  });

  // ── Activity Tracking ───────────────────────────────────────────────────

  describe("touch()", () => {
    it("updates lastActiveAt timestamp", () => {
      const id = registry.createIdentity("agent-1", "owner-1", "o@e.com");
      const originalTime = id.lastActiveAt;

      // Small delay to ensure timestamp difference
      registry.touch("agent-1");
      const updated = registry.getIdentity("agent-1")!;
      expect(new Date(updated.lastActiveAt).getTime())
        .toBeGreaterThanOrEqual(new Date(originalTime).getTime());
    });

    it("does nothing for unknown agent (no throw)", () => {
      expect(() => registry.touch("ghost")).not.toThrow();
    });
  });

  // ── Signing ─────────────────────────────────────────────────────────────

  describe("sign()", () => {
    it("produces a signature string", () => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
      const sig = registry.sign("agent-1", "hello world");
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
    });

    it("produces different signatures for different messages", () => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com");
      const sig1 = registry.sign("agent-1", "message A");
      const sig2 = registry.sign("agent-1", "message B");
      expect(sig1).not.toBe(sig2);
    });

    it("throws for unknown agent", () => {
      expect(() => registry.sign("ghost", "msg")).toThrow("Unknown agent");
    });
  });

  // ── Serialization ──────────────────────────────────────────────────────

  describe("serialization", () => {
    it("serialize and deserialize preserves full state", () => {
      registry.createIdentity("agent-1", "owner-1", "o@e.com", {
        displayName: "Test Bot",
        capabilities: ["shop"],
      });
      registry.createIdentity("agent-2", "owner-2", "o2@e.com");
      registry.verifyKYC("agent-1");

      const t1 = registry.issueToken("agent-1", ["charge", "settle"], {
        maxAmount: 100,
        maxTotalSpend: 500,
      });
      registry.issueToken("agent-2", ["remember", "recall"]);
      registry.recordSpend(t1.id, 150);
      registry.revokeToken(t1.id);

      const data = registry.serialize();
      const restored = IdentityRegistry.deserialize(data);

      // Identities preserved
      expect(restored.size).toBe(2);
      expect(restored.getIdentity("agent-1")!.verified).toBe(true);
      expect(restored.getIdentity("agent-1")!.displayName).toBe("Test Bot");
      expect(restored.getIdentity("agent-2")!.kya.ownerKycStatus).toBe("unverified");

      // Token state preserved
      expect(restored.validateToken(t1.id, "charge").valid).toBe(false); // revoked
      const agent2Tokens = restored.listActiveTokens("agent-2");
      expect(agent2Tokens).toHaveLength(1);
      expect(agent2Tokens[0].permissions).toEqual(["remember", "recall"]);
    });

    it("empty registry serializes and deserializes", () => {
      const data = registry.serialize();
      const restored = IdentityRegistry.deserialize(data);
      expect(restored.size).toBe(0);
    });
  });

  // ── Multi-agent scenarios ──────────────────────────────────────────────

  describe("multi-agent flows", () => {
    it("supports buyer-seller token scoping", () => {
      registry.createIdentity("buyer", "user-1", "buyer@e.com");
      registry.createIdentity("seller", "user-2", "seller@e.com");
      registry.verifyKYC("buyer");
      registry.verifyKYC("seller");

      // Buyer gets a charge token scoped to seller
      const buyerToken = registry.issueToken("buyer", ["charge"], {
        maxAmount: 50,
        maxTotalSpend: 200,
        allowedCounterparties: ["seller"],
      });

      // Seller gets a settle token
      const sellerToken = registry.issueToken("seller", ["settle", "refund"]);

      // Buyer can charge towards seller
      expect(registry.validateToken(buyerToken.id, "charge", 30, "seller").valid).toBe(true);
      // Buyer cannot charge towards random agent
      expect(registry.validateToken(buyerToken.id, "charge", 30, "random").valid).toBe(false);
      // Seller can settle
      expect(registry.validateToken(sellerToken.id, "settle").valid).toBe(true);
      // Seller cannot charge
      expect(registry.validateToken(sellerToken.id, "charge").valid).toBe(false);
    });

    it("kill switch revokes one agent without affecting others", () => {
      registry.createIdentity("agent-a", "owner", "o@e.com");
      registry.createIdentity("agent-b", "owner", "o@e.com");

      const ta = registry.issueToken("agent-a", ["charge"]);
      const tb = registry.issueToken("agent-b", ["charge"]);

      registry.revokeAllTokens("agent-a");

      expect(registry.validateToken(ta.id, "charge").valid).toBe(false);
      expect(registry.validateToken(tb.id, "charge").valid).toBe(true);
    });
  });
});
