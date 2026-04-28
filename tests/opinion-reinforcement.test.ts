/**
 * Opinion reinforcement test (Hindsight port).
 *
 * When a new `opinion` memory lands and overlaps (entity + cosine-sim) with
 * an existing opinion, we classify the relation and update confidence:
 *
 *   reinforce  → +0.15
 *   weaken     → -0.15
 *   contradict → -0.30  (larger magnitude — disconfirmation dominates)
 *   neutral    →  0     (no-op)
 *
 * We exercise each branch via an injected deterministic classifier + an
 * injected embed function so the test is hermetic (no LLM, no provider).
 * We also check the gates: non-opinion memories, no entity overlap, and
 * sim below the floor all produce zero updates.
 */

import { describe, it, expect } from "vitest";
import {
  applyOpinionReinforcement,
  OPINION_DELTA,
  type OpinionRelation,
} from "../src/behavioral.js";

type Mem = {
  id: string;
  content: string;
  factType?: string;
  entityIds?: string[];
  confidence?: number;
};

/** Deterministic embedder: two identical Float32Array entries → cosine = 1.0. */
function mkEngine(sim: number) {
  // For sim=1 we give every content the same vector.
  // For sim<1 we give the new memory vec [1,0,0,...] and existing [cos, sin, 0,...]
  // so cos(theta) = sim.
  return {
    getOrEmbed: async (id: string, _content: string): Promise<Float32Array> => {
      const v = new Float32Array(8);
      if (id.startsWith("new")) {
        v[0] = 1;
      } else {
        v[0] = sim;
        v[1] = Math.sqrt(Math.max(0, 1 - sim * sim));
      }
      return v;
    },
  };
}

function seed(existingId: string, existingContent: string, initialConf = 0.5): Map<string, Mem> {
  const map = new Map<string, Mem>();
  map.set(existingId, {
    id: existingId,
    content: existingContent,
    factType: "opinion",
    entityIds: ["coffee"],
    confidence: initialConf,
  });
  return map;
}

describe("applyOpinionReinforcement", () => {
  it("reinforce raises confidence by +0.15 (clamped at 1.0)", async () => {
    const mems = seed("e1", "User loves pour-over coffee.", 0.8);
    const newMem: Mem = {
      id: "new1",
      content: "Still loves pour-over coffee.",
      factType: "opinion",
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    const classifier = async (): Promise<OpinionRelation> => "reinforce";
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier,
    });
    expect(results.length).toBe(1);
    expect(results[0].relation).toBe("reinforce");
    expect(results[0].delta).toBe(OPINION_DELTA.reinforce);
    // 0.8 + 0.15 = 0.95
    expect(mems.get("e1")!.confidence).toBeCloseTo(0.95, 5);
  });

  it("weaken lowers confidence by 0.15", async () => {
    const mems = seed("e1", "User prefers dark roast.", 0.6);
    const newMem: Mem = {
      id: "new1",
      content: "User sometimes drinks medium roast now.",
      factType: "opinion",
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    const classifier = async (): Promise<OpinionRelation> => "weaken";
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier,
    });
    expect(results.length).toBe(1);
    expect(results[0].relation).toBe("weaken");
    expect(mems.get("e1")!.confidence).toBeCloseTo(0.45, 5);
  });

  it("contradict drops confidence by 0.30 (behavioral-finance asymmetry)", async () => {
    const mems = seed("e1", "User loves pour-over coffee.", 0.8);
    const newMem: Mem = {
      id: "new1",
      content: "User no longer drinks coffee.",
      factType: "opinion",
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    const classifier = async (): Promise<OpinionRelation> => "contradict";
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier,
    });
    expect(results.length).toBe(1);
    expect(results[0].relation).toBe("contradict");
    expect(Math.abs(results[0].delta)).toBe(Math.abs(OPINION_DELTA.contradict));
    // 0.8 - 0.30 = 0.50
    expect(mems.get("e1")!.confidence).toBeCloseTo(0.5, 5);
  });

  it("contradict magnitude > reinforce magnitude (disconfirmation dominates)", () => {
    expect(Math.abs(OPINION_DELTA.contradict)).toBeGreaterThan(Math.abs(OPINION_DELTA.reinforce));
  });

  it("neutral leaves confidence untouched", async () => {
    const mems = seed("e1", "User likes coffee.", 0.7);
    const newMem: Mem = {
      id: "new1",
      content: "User mentioned coffee.",
      factType: "opinion",
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    const classifier = async (): Promise<OpinionRelation> => "neutral";
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier,
    });
    expect(results.length).toBe(0);
    expect(mems.get("e1")!.confidence).toBe(0.7);
  });

  it("no-op when the new memory is not an opinion", async () => {
    const mems = seed("e1", "User loves coffee.", 0.5);
    const newMem: Mem = {
      id: "new1",
      content: "User hates coffee now.",
      factType: "world", // not an opinion
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier: async (): Promise<OpinionRelation> => "contradict",
    });
    expect(results).toEqual([]);
    expect(mems.get("e1")!.confidence).toBe(0.5);
  });

  it("no-op when entity sets do not overlap", async () => {
    const mems = seed("e1", "User loves coffee.", 0.5);
    const newMem: Mem = {
      id: "new1",
      content: "User hates tea.",
      factType: "opinion",
      entityIds: ["tea"], // no overlap with coffee
      confidence: 1.0,
    };
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier: async (): Promise<OpinionRelation> => "contradict",
    });
    expect(results).toEqual([]);
    expect(mems.get("e1")!.confidence).toBe(0.5);
  });

  it("no-op when cosine similarity is below the 0.75 floor", async () => {
    const mems = seed("e1", "User loves coffee.", 0.8);
    const newMem: Mem = {
      id: "new1",
      content: "Totally unrelated content about coffee.",
      factType: "opinion",
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    // sim=0.3 — well below the 0.75 floor.
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(0.3),
      classifier: async (): Promise<OpinionRelation> => "contradict",
    });
    expect(results).toEqual([]);
    expect(mems.get("e1")!.confidence).toBe(0.8);
  });

  it("clamps confidence into [0, 1]", async () => {
    const mems = seed("e1", "Strong opinion.", 0.05);
    const newMem: Mem = {
      id: "new1",
      content: "Opposite opinion.",
      factType: "opinion",
      entityIds: ["coffee"],
      confidence: 1.0,
    };
    // Contradict delta = -0.30 → would drop below 0, must clamp to 0.
    const results = await applyOpinionReinforcement({
      newMemory: newMem,
      memories: mems,
      recallEngine: mkEngine(1.0),
      classifier: async (): Promise<OpinionRelation> => "contradict",
    });
    expect(results[0].newConfidence).toBe(0);
    expect(mems.get("e1")!.confidence).toBe(0);
  });
});
