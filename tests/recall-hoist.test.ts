/**
 * Recall observation hoist (Hindsight port).
 *
 * When an entity in the top-K raw fact results has a cached observation, the
 * observation is injected with a synthetic score of
 *   OBSERVATION_BOOST (1.3) × max raw fact score for that entity
 * so it wins the slot the raw facts were competing for.
 *
 * These tests go through the full RecallEngine.search() path so we exercise
 * both the score-mode and hybrid-mode hoist paths. No LLM / no vector DB is
 * required: we hand-craft memories and registered observations directly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RecallEngine } from "../src/recall/engine.js";
import {
  regenerateObservation,
  getObservation,
  _resetObservationStoreForTests,
} from "../src/recall/observations.js";

interface TestMem {
  id: string;
  content: string;
  importance: number;
  score: number;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
  entityIds?: string[];
}

function mkMem(id: string, content: string, score: number, entityIds: string[] = []): TestMem {
  return {
    id,
    content,
    importance: score,
    score,
    createdAt: new Date(),
    lastAccessed: new Date(),
    accessCount: 0,
    tags: [],
    entityIds,
  };
}

describe("RecallEngine observation hoist", () => {
  beforeEach(() => {
    _resetObservationStoreForTests();
  });

  it("hoists observations above raw facts in score mode", async () => {
    const engine = new RecallEngine({ strategy: "score", agentId: "hoist-A" });

    // Register a consolidated observation for entity "laptop".
    await regenerateObservation(
      "laptop",
      [
        { id: "f1", content: "bought Dell", agentId: "hoist-A", importance: 0.5, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [], entityIds: ["laptop"] } as any,
      ],
      "hoist-A",
      { offline: true, minIntervalMs: 0 },
    );

    // Sanity: the observation must be cached in the shared in-process store.
    expect(getObservation("laptop", "hoist-A")).not.toBeNull();

    const mems: TestMem[] = [
      mkMem("a", "Dell XPS purchase note", 0.9, ["laptop"]),
      mkMem("b", "unrelated fact", 0.8, ["car"]),
      mkMem("c", "RAM upgrade receipt", 0.7, ["laptop"]),
    ];

    const results = await engine.search("", mems, 10);
    // Observation should be at the top. Its id is "observation::laptop".
    expect(results[0].id).toBe("observation::laptop");
    expect((results[0] as any).isObservation).toBe(true);
    // Score must be > the highest raw score for the hoisted entity.
    const topRaw = Math.max(
      ...results.filter((r) => !(r as any).isObservation).map((r) => r.combinedScore),
    );
    expect(results[0].combinedScore).toBeGreaterThan(topRaw);
  });

  it("does NOT inject observations for entities not in the top-K", async () => {
    const engine = new RecallEngine({ strategy: "score", agentId: "hoist-B" });

    // Register an observation for "phone" — but no memory in the set mentions phone.
    await regenerateObservation(
      "phone",
      [
        { id: "p1", content: "iPhone 15", agentId: "hoist-B", importance: 0.5, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [], entityIds: ["phone"] } as any,
      ],
      "hoist-B",
      { offline: true, minIntervalMs: 0 },
    );

    const mems: TestMem[] = [
      mkMem("a", "Dell XPS purchase note", 0.9, ["laptop"]),
      mkMem("b", "car service record", 0.8, ["car"]),
    ];

    const results = await engine.search("", mems, 10);
    // No observation result should appear because "phone" isn't in the top-K entities.
    const obs = results.filter((r) => (r as any).isObservation);
    expect(obs.length).toBe(0);
  });

  it("is a no-op when no memories carry entityIds", async () => {
    const engine = new RecallEngine({ strategy: "score", agentId: "hoist-C" });

    // Registering an observation but no memory pulls it in.
    await regenerateObservation(
      "laptop",
      [
        { id: "f1", content: "x", agentId: "hoist-C", importance: 0.5, score: 0.5, createdAt: new Date(), lastAccessed: new Date(), accessCount: 0, tags: [], entityIds: ["laptop"] } as any,
      ],
      "hoist-C",
      { offline: true, minIntervalMs: 0 },
    );

    const mems: TestMem[] = [
      mkMem("a", "no entity memory", 0.9, []),
      mkMem("b", "also no entity", 0.8, []),
    ];
    const results = await engine.search("", mems, 10);
    expect(results.some((r) => (r as any).isObservation)).toBe(false);
    expect(results.length).toBe(2);
  });
});
