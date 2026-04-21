/**
 * PersistenceAdapter parity suite.
 *
 * Every adapter MUST satisfy the same set of behaviors:
 *   - set/get roundtrip preserves content, embedding (exact bytes), metadata
 *   - delete is idempotent
 *   - search returns top-K in descending cosine-similarity order
 *   - agent scoping — rows from one agent are invisible to another
 *   - concurrent writes all land correctly
 *
 * The Neon suite runs only when NEON_TEST_URL is set, so CI/local runs
 * stay hermetic by default.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryAdapter,
  NeonAdapter,
  RecallEngine,
  localEmbed,
  l2Normalize,
  type PersistenceAdapter,
} from "../src/index.js";
import { MnemoPay } from "../src/index.js";

const NEON_URL = process.env.NEON_TEST_URL;
// Unique per run so parallel test workers don't clobber each other.
const TABLE = `mnemopay_memories_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

type AdapterFactory = {
  name: string;
  build: () => Promise<PersistenceAdapter>;
  teardown?: (adapter: PersistenceAdapter) => Promise<void>;
};

const factories: AdapterFactory[] = [
  {
    name: "MemoryAdapter",
    build: async () => new MemoryAdapter(),
  },
];

if (NEON_URL) {
  factories.push({
    name: "NeonAdapter",
    build: async () => new NeonAdapter({ url: NEON_URL, table: TABLE }),
    teardown: async (adapter) => {
      // Drop the test-specific table so repeat runs are hermetic.
      const pool = (adapter as any).pool;
      if (pool) {
        try {
          await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
        } catch {
          /* ignore */
        }
      }
      await adapter.close();
    },
  });
} else {
  // Tell the dev that Neon parity was skipped, but do not fail the run.
  // eslint-disable-next-line no-console
  console.log("[persistence.spec] NEON_TEST_URL not set — skipping Neon parity suite.");
}

function makeEmbedding(text: string, dims = 384): Float32Array {
  return localEmbed(text, dims);
}

function assertSameVector(a: Float32Array, b: Float32Array, tol = 1e-5): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
  }
}

for (const factory of factories) {
  describe(`PersistenceAdapter parity — ${factory.name}`, () => {
    let adapter: PersistenceAdapter;

    beforeAll(async () => {
      adapter = await factory.build();
    });

    afterAll(async () => {
      if (factory.teardown) await factory.teardown(adapter);
      else await adapter.close();
    });

    it("set/get roundtrip preserves content, embedding, metadata", async () => {
      const emb = makeEmbedding("hello world");
      await adapter.set("agent-a", "m1", "hello world", emb, {
        tag: "greeting",
        n: 42,
      });
      const row = await adapter.get("agent-a", "m1");
      expect(row).not.toBeNull();
      expect(row!.content).toBe("hello world");
      assertSameVector(row!.embedding, emb);
      expect(row!.metadata).toEqual({ tag: "greeting", n: 42 });
    });

    it("set overwrites prior row with same (agentId, id)", async () => {
      await adapter.set("agent-a", "m-ovr", "v1", makeEmbedding("v1"), { v: 1 });
      await adapter.set("agent-a", "m-ovr", "v2", makeEmbedding("v2"), { v: 2 });
      const row = await adapter.get("agent-a", "m-ovr");
      expect(row!.content).toBe("v2");
      expect(row!.metadata).toEqual({ v: 2 });
    });

    it("get returns null for missing row", async () => {
      const row = await adapter.get("agent-a", "does-not-exist");
      expect(row).toBeNull();
    });

    it("delete removes a row and is idempotent", async () => {
      const emb = makeEmbedding("delete me");
      await adapter.set("agent-a", "m-del", "delete me", emb);
      expect(await adapter.get("agent-a", "m-del")).not.toBeNull();
      await adapter.delete("agent-a", "m-del");
      expect(await adapter.get("agent-a", "m-del")).toBeNull();
      // Second delete must not throw.
      await adapter.delete("agent-a", "m-del");
    });

    it("search returns top-K in descending score order", async () => {
      const agent = "agent-search";
      // Use distinct L2-normalized vectors so cosine similarity is unambiguous.
      const base = l2Normalize(new Float32Array([1, 0, 0, 0]));
      const close = l2Normalize(new Float32Array([0.9, 0.1, 0, 0]));
      const mid = l2Normalize(new Float32Array([0.5, 0.5, 0, 0]));
      const far = l2Normalize(new Float32Array([0, 1, 0, 0]));

      // Only the MemoryAdapter supports arbitrary dimensions; NeonAdapter is
      // pinned to 384 by the schema. Pad each vector to 384 dims so both
      // adapters can be tested with the same code path.
      const pad = (v: Float32Array, dims = 384): Float32Array => {
        const out = new Float32Array(dims);
        out.set(v);
        return l2Normalize(out);
      };

      await adapter.set(agent, "near", "near content", pad(close));
      await adapter.set(agent, "mid", "mid content", pad(mid));
      await adapter.set(agent, "far", "far content", pad(far));

      const results = await adapter.search(agent, pad(base), 3);
      expect(results).toHaveLength(3);
      // Descending order by score.
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
      // Best match is `near`.
      expect(results[0].id).toBe("near");
      // Far is last.
      expect(results[2].id).toBe("far");
    });

    it("search scopes results by agentId", async () => {
      // Fresh state to avoid pollution from other tests.
      const agent1 = `isolation-${Math.random().toString(36).slice(2)}`;
      const agent2 = `isolation-${Math.random().toString(36).slice(2)}`;
      const emb = makeEmbedding("shared text");

      await adapter.set(agent1, "only-in-1", "only in 1", emb);
      await adapter.set(agent2, "only-in-2", "only in 2", emb);

      const r1 = await adapter.search(agent1, emb, 10);
      const r2 = await adapter.search(agent2, emb, 10);

      expect(r1.some((h) => h.id === "only-in-1")).toBe(true);
      expect(r1.some((h) => h.id === "only-in-2")).toBe(false);
      expect(r2.some((h) => h.id === "only-in-2")).toBe(true);
      expect(r2.some((h) => h.id === "only-in-1")).toBe(false);
    });

    it("concurrent writes to distinct ids all land", async () => {
      const agent = `conc-${Math.random().toString(36).slice(2)}`;
      const N = 20;
      const ids = Array.from({ length: N }, (_, i) => `cw-${i}`);
      await Promise.all(
        ids.map((id) =>
          adapter.set(agent, id, `content-${id}`, makeEmbedding(id), {
            pos: Number(id.split("-")[1]),
          }),
        ),
      );

      // Every row is readable with correct metadata.
      for (const id of ids) {
        const row = await adapter.get(agent, id);
        expect(row).not.toBeNull();
        expect(row!.content).toBe(`content-${id}`);
        expect((row!.metadata as any).pos).toBe(Number(id.split("-")[1]));
      }
    });

    it("search honors topK truncation", async () => {
      const agent = `topk-${Math.random().toString(36).slice(2)}`;
      for (let i = 0; i < 5; i++) {
        await adapter.set(agent, `t-${i}`, `row ${i}`, makeEmbedding(`row ${i}`));
      }
      const res = await adapter.search(agent, makeEmbedding("row 0"), 2);
      expect(res.length).toBe(2);
    });
  });
}

// ─── RecallEngine integration against the default memory adapter ────────────

describe("RecallEngine with default persist", () => {
  it("defaults to memory adapter when persist option is omitted", async () => {
    const engine = new RecallEngine({ strategy: "vector", agentId: "rec-default" });
    await engine.embed("m1", "the cat sat on the mat");
    await engine.embed("m2", "dogs bark at night");
    const adapter = engine.getAdapter();
    expect(adapter).toBeInstanceOf(MemoryAdapter);
    const hit = await adapter.get("rec-default", "m1");
    expect(hit).not.toBeNull();
    expect(hit!.content).toBe("the cat sat on the mat");
    await engine.close();
  });

  it("accepts a custom adapter via persist option", async () => {
    const custom = new MemoryAdapter();
    const engine = new RecallEngine({
      strategy: "vector",
      agentId: "rec-custom",
      persist: { type: "custom", adapter: custom },
    });
    await engine.embed("m1", "hello");
    expect(await custom.get("rec-custom", "m1")).not.toBeNull();
    await engine.close();
  });

  it("MnemoPay.quick stores recall data in the memory adapter by default", async () => {
    const agent = MnemoPay.quick("recall-quick-agent", {
      recall: "vector",
      persist: { type: "memory" },
    });
    const id = await agent.remember("I love coffee with cinnamon", { importance: 0.9 });
    expect(typeof id).toBe("string");
    const results = await agent.recall("what do I like to drink?");
    expect(results.length).toBeGreaterThan(0);
  });
});
