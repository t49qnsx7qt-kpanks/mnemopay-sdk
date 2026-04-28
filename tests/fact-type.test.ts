/**
 * Fact-type round-trip test (Hindsight port).
 *
 * Covers the write/read surface added for the `FactType` union:
 *   - remember() accepts factType / confidence / entityIds
 *   - defaults ("world", 1.0, []) preserve the pre-port behavior
 *   - enum values persist on the in-memory Memory object
 *   - fact_type column shows up on freshly-migrated SQLite databases
 *
 * This does NOT exercise observations or opinion reinforcement — those have
 * their own test files. All we assert here is that the label threads cleanly
 * through the public API and through the SQLite adapter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MnemoPay, SQLiteStorage } from "../src/index.js";
import type { FactType } from "../src/index.js";

describe("FactType round-trip", () => {
  it("defaults to world when no factType is provided", async () => {
    const agent = MnemoPay.quick("ft-default");
    const id = await agent.remember("The sky is blue");
    const m = (await agent.recall(1))[0];
    expect(m.id).toBe(id);
    expect((m as any).factType).toBe("world");
    expect((m as any).confidence).toBe(1.0);
    expect((m as any).entityIds).toEqual([]);
  });

  it("preserves explicit factType/confidence/entityIds", async () => {
    const agent = MnemoPay.quick("ft-explicit");
    const ids: string[] = [];
    const labels: FactType[] = ["world", "experience", "opinion", "observation"];
    for (const t of labels) {
      ids.push(
        await agent.remember(`statement type=${t}`, {
          factType: t,
          confidence: t === "opinion" ? 0.6 : 1.0,
          entityIds: [`entity-${t}`],
        }),
      );
    }
    const mems = await agent.recall(10);
    for (const t of labels) {
      const m = mems.find((x) => (x as any).factType === t);
      expect(m, `missing memory for factType ${t}`).toBeDefined();
      expect((m as any).entityIds).toEqual([`entity-${t}`]);
    }
    const opinion = mems.find((x) => (x as any).factType === "opinion");
    expect((opinion as any).confidence).toBe(0.6);
  });

  it("clamps confidence into [0,1]", async () => {
    const agent = MnemoPay.quick("ft-clamp");
    await agent.remember("too high", { factType: "opinion", confidence: 1.5, entityIds: ["x"] });
    await agent.remember("too low", { factType: "opinion", confidence: -0.5, entityIds: ["y"] });
    const mems = await agent.recall(10);
    const high = mems.find((m) => m.content === "too high") as any;
    const low = mems.find((m) => m.content === "too low") as any;
    expect(high.confidence).toBe(1.0);
    expect(low.confidence).toBe(0);
  });

  it("persists factType via SQLiteStorage round-trip", async () => {
    const storage = new SQLiteStorage(":memory:");
    const a1 = MnemoPay.quick("ft-sqlite", { storage });
    await a1.remember("opinion with entity", {
      factType: "opinion",
      confidence: 0.4,
      entityIds: ["laptop"],
    });
    await a1.remember("plain world fact");
    // Force flush to storage.
    (a1 as any)._saveToDisk();

    // Second agent loads from the same storage.
    const a2 = MnemoPay.quick("ft-sqlite", { storage });
    const mems = await a2.recall(10);
    expect(mems.length).toBe(2);
    const op = mems.find((m) => m.content === "opinion with entity") as any;
    const world = mems.find((m) => m.content === "plain world fact") as any;
    expect(op.factType).toBe("opinion");
    expect(op.confidence).toBeCloseTo(0.4, 5);
    expect(op.entityIds).toEqual(["laptop"]);
    expect(world.factType).toBe("world");
  });
});
