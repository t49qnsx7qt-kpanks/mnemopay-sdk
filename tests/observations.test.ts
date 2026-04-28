/**
 * Observations write-path test (Hindsight port).
 *
 * Covers the entity-observation pipeline in src/recall/observations.ts:
 *
 *   1. `hashFactIds()` is insensitive to input order.
 *   2. `regenerateObservation()` produces a non-empty summary and records
 *      the fact-ids hash.
 *   3. Debounce: calling again with the SAME fact set + within the debounce
 *      window → no-op (updatedAt does not change, same ObservationRow returned).
 *   4. Regeneration triggers when the fact set changes, even within the
 *      debounce window, because the hash changes.
 *   5. `selectFactsForEntity` filters to entity-matching non-observation
 *      memories.
 *
 * No LLM is required: the offline summarizer fallback gives us a deterministic
 * output whenever the relevant API keys are absent (summarizer.ts honors this).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Memory } from "../src/index.js";
import {
  hashFactIds,
  regenerateObservation,
  getObservation,
  enqueueObservationRegen,
  selectFactsForEntity,
  _resetObservationStoreForTests,
} from "../src/recall/observations.js";

function mem(id: string, content: string, entityIds: string[], factType = "world"): Memory {
  return {
    id,
    agentId: "test",
    content,
    importance: 0.5,
    score: 0.5,
    createdAt: new Date(Date.now() - 1000),
    lastAccessed: new Date(),
    accessCount: 0,
    tags: [],
    factType: factType as any,
    confidence: 1.0,
    entityIds,
  } as Memory;
}

describe("Observations pipeline", () => {
  beforeEach(() => {
    _resetObservationStoreForTests();
  });

  it("hashFactIds is order-insensitive", () => {
    const a = hashFactIds(["a", "b", "c"]);
    const b = hashFactIds(["c", "a", "b"]);
    const c = hashFactIds(["a", "b", "d"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("selectFactsForEntity filters by entityIds and drops observation-type memories", () => {
    const map = new Map<string, Memory>();
    map.set("f1", mem("f1", "about laptop", ["laptop"]));
    map.set("f2", mem("f2", "about phone", ["phone"]));
    map.set("f3", mem("f3", "laptop + phone", ["laptop", "phone"]));
    map.set("f4", mem("f4", "prior observation", ["laptop"], "observation"));

    const laptop = selectFactsForEntity("laptop", map);
    expect(laptop.map((m) => m.id).sort()).toEqual(["f1", "f3"]);
    const phone = selectFactsForEntity("phone", map);
    expect(phone.map((m) => m.id).sort()).toEqual(["f2", "f3"]);
  });

  it("regenerateObservation produces a summary and stores facts hash", async () => {
    const facts = [
      mem("f1", "User bought a Dell XPS 15 in 2023.", ["laptop"]),
      mem("f2", "User upgraded RAM to 32GB.", ["laptop"]),
    ];
    const row = await regenerateObservation("laptop", facts, "agent-A", {
      offline: true,
      minIntervalMs: 0,
    });
    expect(row).not.toBeNull();
    expect(row!.entityId).toBe("laptop");
    expect(row!.summary.length).toBeGreaterThan(0);
    expect(row!.factsHash).toBe(hashFactIds(["f1", "f2"]));
    // Should be cached in the in-process store.
    expect(getObservation("laptop", "agent-A")!.summary).toBe(row!.summary);
  });

  it("debounces regeneration when facts + time are unchanged", async () => {
    const facts = [mem("f1", "A", ["laptop"]), mem("f2", "B", ["laptop"])];

    // Freeze clock — same hash, within minIntervalMs → no-op.
    const t0 = 1_000_000;
    const first = await regenerateObservation("laptop", facts, "agent-B", {
      offline: true,
      now: t0,
      minIntervalMs: 30_000,
    });
    const second = await regenerateObservation("laptop", facts, "agent-B", {
      offline: true,
      now: t0 + 1_000, // 1s later, well within debounce
      minIntervalMs: 30_000,
    });
    expect(second).not.toBeNull();
    expect(second!.updatedAt).toBe(first!.updatedAt); // unchanged
    expect(second!.summary).toBe(first!.summary);
  });

  it("regenerates when facts change even within debounce window", async () => {
    const t0 = 2_000_000;
    const first = await regenerateObservation(
      "laptop",
      [mem("f1", "A", ["laptop"])],
      "agent-C",
      { offline: true, now: t0, minIntervalMs: 30_000 },
    );
    const second = await regenerateObservation(
      "laptop",
      [mem("f1", "A", ["laptop"]), mem("f2", "B", ["laptop"])],
      "agent-C",
      { offline: true, now: t0 + 500, minIntervalMs: 30_000 },
    );
    expect(second).not.toBeNull();
    expect(second!.factsHash).not.toBe(first!.factsHash);
    expect(second!.updatedAt).toBe(t0 + 500);
  });

  it("enqueueObservationRegen returns null when no facts match", async () => {
    const map = new Map<string, Memory>();
    map.set("f1", mem("f1", "unrelated", ["phone"]));
    const row = await enqueueObservationRegen({
      agentId: "agent-D",
      entityId: "laptop",
      memories: map,
      options: { offline: true, minIntervalMs: 0 },
    });
    expect(row).toBeNull();
  });

  it("end-to-end: enqueueObservationRegen populates the store", async () => {
    const map = new Map<string, Memory>();
    map.set("f1", mem("f1", "bought Dell XPS", ["laptop"]));
    map.set("f2", mem("f2", "added SSD", ["laptop"]));
    const row = await enqueueObservationRegen({
      agentId: "agent-E",
      entityId: "laptop",
      memories: map,
      options: { offline: true, minIntervalMs: 0 },
    });
    expect(row).not.toBeNull();
    expect(getObservation("laptop", "agent-E")).not.toBeNull();
  });
});
