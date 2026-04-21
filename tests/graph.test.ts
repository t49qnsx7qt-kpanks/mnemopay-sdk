/**
 * EntityGraph + canonicalization — pure unit tests (no network).
 */

import { describe, it, expect } from "vitest";
import {
  canonicalize,
  levenshtein,
  normalizeEntityKey,
} from "../src/recall/entities.js";
import { EntityGraph } from "../src/recall/graph.js";

describe("normalizeEntityKey", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeEntityKey("Kura Sushi!")).toBe("kura sushi");
    expect(normalizeEntityKey("  Kura   Sushi  ")).toBe("kura sushi");
  });
  it("returns empty for punctuation-only input", () => {
    expect(normalizeEntityKey("!!!!")).toBe("");
  });
});

describe("levenshtein", () => {
  it("is zero for identical strings", () => {
    expect(levenshtein("kura sushi", "kura sushi")).toBe(0);
  });
  it("single substitution", () => {
    expect(levenshtein("cats", "bats")).toBe(1);
  });
  it("three edits between longer strings", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("canonicalize", () => {
  const existing = [
    { canonicalName: "Kura Sushi", aliases: ["kura"] },
    { canonicalName: "Uchi Dallas", aliases: [] },
  ];

  it("matches exact (case-insensitive)", () => {
    const r = canonicalize("kura sushi", existing);
    expect(r.matched).toBe(true);
    expect(r.tier).toBe("exact");
    expect(r.canonicalName).toBe("Kura Sushi");
  });

  it("matches alias", () => {
    const r = canonicalize("Kura", existing);
    expect(r.matched).toBe(true);
    expect(r.tier).toBe("alias");
    expect(r.canonicalName).toBe("Kura Sushi");
  });

  it("matches fuzzy single-typo for long strings", () => {
    const r = canonicalize("Uchi Dalas", existing); // 1 edit
    expect(r.matched).toBe(true);
    expect(r.tier).toBe("fuzzy");
    expect(r.canonicalName).toBe("Uchi Dallas");
  });

  it("does not match unrelated names", () => {
    const r = canonicalize("Musashi", existing);
    expect(r.matched).toBe(false);
    expect(r.tier).toBeNull();
  });

  it("refuses fuzzy on very short tokens", () => {
    const r = canonicalize("kur", existing);
    // Under length-5 threshold: no fuzzy
    expect(r.tier).not.toBe("fuzzy");
  });
});

describe("EntityGraph", () => {
  it("upserts idempotently and accumulates aliases", () => {
    const g = new EntityGraph();
    const a = g.upsertEntity("Kura Sushi");
    const b = g.upsertEntity("kura sushi");
    expect(a).toBe(b);
    const c = g.upsertEntity("Uchi Dallas");
    expect(c).not.toBe(a);
    expect(g.size().entities).toBe(2);
  });

  it("ingestMemoryEntities creates co-occurrence edges", () => {
    const g = new EntityGraph();
    g.ingestMemoryEntities({
      memoryId: "m1",
      entities: [{ name: "Kura Sushi" }, { name: "Plano" }, { name: "sake" }],
    });
    // 3 entities → 3 pairwise edges
    expect(g.size().edges).toBe(3);
    expect(g.size().mentions).toBe(3);
  });

  it("spread BFS 2-hop assigns decreasing scores by distance", () => {
    const g = new EntityGraph();

    // Memory 1: Kura Sushi ↔ Plano
    g.ingestMemoryEntities({
      memoryId: "m1",
      entities: [{ name: "Kura Sushi" }, { name: "Plano" }],
    });
    // Memory 2: Plano ↔ Jerry
    g.ingestMemoryEntities({
      memoryId: "m2",
      entities: [{ name: "Plano" }, { name: "Jerry" }],
    });
    // Memory 3: Jerry ↔ DELE (should be 2-hop from Kura)
    g.ingestMemoryEntities({
      memoryId: "m3",
      entities: [{ name: "Jerry" }, { name: "DELE" }],
    });

    const kuraId = g.findByName("Kura Sushi")!;
    expect(kuraId).toBeTruthy();

    const result = g.spread([kuraId], 2);
    // m1 is direct (hop 0) → score 1
    expect(result.memoryScores.get("m1")).toBe(1);
    // m2 has Plano at hop 1 → score 0.5
    expect(result.memoryScores.get("m2")).toBe(0.5);
    // m3 has Jerry at hop 2 → score 1/3
    expect(result.memoryScores.get("m3")).toBeCloseTo(1 / 3, 5);
  });

  it("findByName resolves via alias", () => {
    const g = new EntityGraph();
    g.upsertEntity("Kura Sushi");
    g.upsertEntity("Kura Sushi"); // no new alias
    g.upsertEntity("Kura Sushi Plano"); // new — NOT an alias (different name)
    // Add an alias explicitly by fuzzy-matching a near-miss
    g.upsertEntity("Kura Sushii"); // fuzzy 1 → should register as alias of first
    expect(g.findByName("Kura Sushii")).toBe(g.findByName("Kura Sushi"));
  });
});
