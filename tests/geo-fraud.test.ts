import { describe, it, expect } from "vitest";
import { FraudGuard } from "../src/fraud.js";
import MnemoPay from "../src/index.js";

/**
 * Geo-Enhanced Fraud Detection Tests
 *
 * Design principle: geo signals INFORM, they don't BLOCK.
 * Only sanctioned countries cause a hard block.
 * Everything else flags for review while letting the transaction through.
 */

// ─── Geo Signals — Never Block Alone ──────────────────────────────────────

describe("Geo Fraud — Signals Never Block Alone", () => {
  it("country switch produces low-weight signal that does NOT block", () => {
    const guard = new FraudGuard({ enableGeoCheck: true });

    // Build profile from Nigeria
    for (let i = 0; i < 5; i++) {
      guard.recordCharge("agent-1", 50, { ip: "1.2.3.4", country: "NG" });
    }

    // Now transact from Ghana — should flag, NOT block
    const risk = guard.assessCharge("agent-1", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      ip: "5.6.7.8", country: "GH",
    });

    expect(risk.allowed).toBe(true);
    const geoSwitch = risk.signals.find(s => s.type === "geo_country_switch");
    expect(geoSwitch).toBeDefined();
    expect(geoSwitch!.weight).toBeLessThan(0.3); // Low weight
    expect(geoSwitch!.severity).toBe("low");
  });

  it("rapid country hopping flags but does NOT block", () => {
    const guard = new FraudGuard({
      enableGeoCheck: true,
      geo: { enabled: true, homeCountryThreshold: 5, rapidHopThreshold: 3, highRiskCorridors: [], sanctionedCountries: [], currencyRegions: {} },
    });

    // Hop between 4 countries
    guard.recordCharge("hopper", 10, { country: "NG" });
    guard.recordCharge("hopper", 10, { country: "GH" });
    guard.recordCharge("hopper", 10, { country: "KE" });
    guard.recordCharge("hopper", 10, { country: "ZA" });

    const risk = guard.assessCharge("hopper", 10, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "US",
    });

    expect(risk.allowed).toBe(true); // Still allowed
    const hop = risk.signals.find(s => s.type === "geo_rapid_hop");
    expect(hop).toBeDefined();
    expect(hop!.weight).toBeLessThanOrEqual(0.35);
  });

  it("currency mismatch is informational only", () => {
    const guard = new FraudGuard({ enableGeoCheck: true });

    guard.recordCharge("agent-2", 100, { country: "US" });

    // US agent using NGN — mismatch but not dangerous
    const risk = guard.assessCharge("agent-2", 100, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "US", currency: "NGN",
    });

    expect(risk.allowed).toBe(true);
    const mismatch = risk.signals.find(s => s.type === "geo_currency_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch!.weight).toBeLessThanOrEqual(0.1);
  });

  it("timezone anomaly is informational only", () => {
    const guard = new FraudGuard({ enableGeoCheck: true });

    guard.recordCharge("night-agent", 50, { country: "NG" });

    // Simulate 3am local time (UTC+1, so UTC hour would be 2)
    const risk = guard.assessCharge("night-agent", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "NG", utcOffset: 1,
    });

    // May or may not fire depending on current UTC hour
    // Just verify it doesn't block
    expect(risk.allowed).toBe(true);
  });

  it("high-risk corridor flags but does NOT block", () => {
    const guard = new FraudGuard({
      geo: {
        enabled: true, homeCountryThreshold: 5, rapidHopThreshold: 3,
        highRiskCorridors: [["NG", "AE"]], // Example corridor
        sanctionedCountries: [], currencyRegions: {},
      },
    });

    guard.recordCharge("corridor-agent", 100, { country: "NG" });

    const risk = guard.assessCharge("corridor-agent", 100, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "AE",
    });

    expect(risk.allowed).toBe(true);
    const corridor = risk.signals.find(s => s.type === "geo_high_risk_corridor");
    expect(corridor).toBeDefined();
    expect(corridor!.weight).toBeLessThanOrEqual(0.25);
  });
});

// ─── Sanctioned Countries — The Only Hard Block ───────────────────────────

describe("Geo Fraud — Sanctioned Countries Block", () => {
  it("blocks transaction from OFAC-sanctioned country", () => {
    const guard = new FraudGuard({ enableGeoCheck: true });

    const risk = guard.assessCharge("agent-sanc", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "KP", // North Korea
    });

    expect(risk.allowed).toBe(false);
    const sanction = risk.signals.find(s => s.type === "sanctioned_country");
    expect(sanction).toBeDefined();
    expect(sanction!.severity).toBe("critical");
    expect(sanction!.weight).toBe(0.9);
  });

  it("blocks Iran", () => {
    const guard = new FraudGuard();
    const risk = guard.assessCharge("agent-ir", 50, 0.5, new Date(Date.now() - 3600000), 0, { country: "IR" });
    expect(risk.allowed).toBe(false);
  });

  it("blocks Syria", () => {
    const guard = new FraudGuard();
    const risk = guard.assessCharge("agent-sy", 50, 0.5, new Date(Date.now() - 3600000), 0, { country: "SY" });
    expect(risk.allowed).toBe(false);
  });

  it("legacy blockedCountries still works", () => {
    const guard = new FraudGuard({ blockedCountries: ["XX"] });
    const risk = guard.assessCharge("agent-xx", 50, 0.5, new Date(Date.now() - 3600000), 0, { country: "XX" });
    expect(risk.allowed).toBe(false);
  });

  it("legitimate countries are NOT blocked", () => {
    const guard = new FraudGuard();
    const countries = ["NG", "US", "GB", "GH", "KE", "ZA", "DE", "JP", "BR", "IN"];
    for (const c of countries) {
      const risk = guard.assessCharge(`agent-${c}`, 50, 0.5, new Date(Date.now() - 3600000), 0, { country: c });
      expect(risk.allowed).toBe(true);
    }
  });
});

// ─── Geo Trust Score ──────────────────────────────────────────────────────

describe("Geo Fraud — Trust Score", () => {
  it("builds trust for consistent location", () => {
    const guard = new FraudGuard();

    // 10 transactions from Nigeria
    for (let i = 0; i < 10; i++) {
      guard.recordCharge("loyal-agent", 50, { country: "NG" });
    }

    const profile = guard.getGeoProfile("loyal-agent");
    expect(profile).toBeDefined();
    expect(profile!.homeCountry).toBe("NG");
    expect(profile!.trustScore).toBeGreaterThan(0.5);
    expect(profile!.totalTxCount).toBe(10);
  });

  it("trust dampens geo signals for established agents", () => {
    const guard = new FraudGuard({
      geo: {
        enabled: true, homeCountryThreshold: 3, rapidHopThreshold: 3,
        highRiskCorridors: [["NG", "AE"]],
        sanctionedCountries: [], currencyRegions: {},
      },
    });

    // Build strong trust (20 tx from Nigeria)
    for (let i = 0; i < 20; i++) {
      guard.recordCharge("trusted", 50, { country: "NG" });
    }

    const profile = guard.getGeoProfile("trusted");
    expect(profile!.trustScore).toBeGreaterThan(0.7);

    // Now trigger corridor signal — weight should be dampened
    const risk = guard.assessCharge("trusted", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "AE",
    });

    expect(risk.allowed).toBe(true);
    const corridor = risk.signals.find(s => s.type === "geo_high_risk_corridor");
    expect(corridor).toBeDefined();
    // Dampened: 0.25 * (1 - trust*0.5) < 0.25
    expect(corridor!.weight).toBeLessThan(0.25);
  });

  it("new agent has zero trust — full signal weight", () => {
    const guard = new FraudGuard({
      geo: {
        enabled: true, homeCountryThreshold: 5, rapidHopThreshold: 3,
        highRiskCorridors: [["US", "NG"]],
        sanctionedCountries: [], currencyRegions: {},
      },
    });

    guard.recordCharge("newbie", 50, { country: "US" });

    const risk = guard.assessCharge("newbie", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "NG",
    });

    expect(risk.allowed).toBe(true);
    const corridor = risk.signals.find(s => s.type === "geo_high_risk_corridor");
    expect(corridor).toBeDefined();
    // No trust dampening — full weight
    expect(corridor!.weight).toBe(0.25);
  });

  it("multi-country agent has lower trust", () => {
    const guard = new FraudGuard();

    // Split transactions across 3 countries
    for (let i = 0; i < 5; i++) guard.recordCharge("traveler", 50, { country: "NG" });
    for (let i = 0; i < 3; i++) guard.recordCharge("traveler", 50, { country: "GH" });
    for (let i = 0; i < 2; i++) guard.recordCharge("traveler", 50, { country: "US" });

    const profile = guard.getGeoProfile("traveler");
    expect(profile!.totalTxCount).toBe(10);
    // Trust is lower because transactions are spread across countries
    expect(profile!.trustScore).toBeLessThan(0.8);
    expect(profile!.homeCountry).toBe("NG"); // Most frequent
  });
});

// ─── Geo Profile Persistence ──────────────────────────────────────────────

describe("Geo Fraud — Persistence", () => {
  it("geo profiles survive serialize → deserialize", () => {
    const guard = new FraudGuard();

    for (let i = 0; i < 10; i++) {
      guard.recordCharge("persist-agent", 50, { country: "NG", ip: "1.2.3.4" });
    }

    const serialized = guard.serialize();
    const restored = FraudGuard.deserialize(serialized);

    const profile = restored.getGeoProfile("persist-agent");
    expect(profile).toBeDefined();
    expect(profile!.homeCountry).toBe("NG");
    expect(profile!.totalTxCount).toBe(10);
    expect(profile!.trustScore).toBeGreaterThan(0);
  });
});

// ─── Geo + Other Signals Combined ─────────────────────────────────────────

describe("Geo Fraud — Combined Signals", () => {
  it("geo alone stays under block threshold", () => {
    const guard = new FraudGuard({
      geo: {
        enabled: true, homeCountryThreshold: 3, rapidHopThreshold: 2,
        highRiskCorridors: [["NG", "AE"]],
        sanctionedCountries: [], currencyRegions: { NGN: ["NG"] },
      },
    });

    // Create worst-case geo: country switch + rapid hop + corridor + currency mismatch
    guard.recordCharge("worst-geo", 50, { country: "NG" });
    guard.recordCharge("worst-geo", 50, { country: "GH" });
    guard.recordCharge("worst-geo", 50, { country: "US" });

    const risk = guard.assessCharge("worst-geo", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "AE", currency: "NGN", utcOffset: 4,
    });

    // Even with ALL geo signals firing, should NOT block on its own
    expect(risk.allowed).toBe(true);
  });

  it("no signals fire without geo context", () => {
    const guard = new FraudGuard();

    // No IP, no country — no geo signals
    const risk = guard.assessCharge("no-ctx", 50, 0.5, new Date(Date.now() - 3600000), 0);

    const geoSignals = risk.signals.filter(s => s.type.startsWith("geo_") || s.type === "sanctioned_country" || s.type === "ip_hopping");
    expect(geoSignals).toHaveLength(0);
  });

  it("disabled geo produces no signals", () => {
    const guard = new FraudGuard({ geo: { enabled: false, homeCountryThreshold: 5, rapidHopThreshold: 3, highRiskCorridors: [], sanctionedCountries: ["KP"], currencyRegions: {} } });

    const risk = guard.assessCharge("disabled", 50, 0.5, new Date(Date.now() - 3600000), 0, {
      country: "KP", // Even sanctioned — geo disabled
    });

    // No geo signals at all when disabled
    const geoSignals = risk.signals.filter(s => s.type.startsWith("geo_") || s.type === "sanctioned_country");
    expect(geoSignals).toHaveLength(0);
    expect(risk.allowed).toBe(true);
  });
});

// ─── Integration: MnemoPay.quick with Geo ─────────────────────────────────

describe("Geo Fraud — MnemoPay Integration", () => {
  it("agent can transact normally with geo context", async () => {
    const agent = MnemoPay.quick("geo-agent", {
      fraud: { enableGeoCheck: true, settlementHoldMinutes: 0, disputeWindowMinutes: 0 },
    });

    // Normal transaction with geo context — should work fine
    const tx = await agent.charge(50, "API access", { ip: "41.58.0.1", country: "NG" });
    expect(tx.status).toBe("pending");

    const settled = await agent.settle(tx.id);
    expect(settled.status).toBe("completed");
  });

  it("agent traveling between countries can still transact", async () => {
    const agent = MnemoPay.quick("travel-agent", {
      fraud: { enableGeoCheck: true, settlementHoldMinutes: 0, disputeWindowMinutes: 0 },
    });

    // Nigeria
    const tx1 = await agent.charge(25, "First purchase", { country: "NG" });
    await agent.settle(tx1.id);

    // Now in Ghana — should still work
    const tx2 = await agent.charge(25, "Second purchase", { country: "GH" });
    await agent.settle(tx2.id);

    // Now in US — should still work
    const tx3 = await agent.charge(25, "Third purchase", { country: "US" });
    await agent.settle(tx3.id);

    const bal = await agent.balance();
    expect(bal.wallet).toBeGreaterThan(0);
  });
});
