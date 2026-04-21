# Claude Agent SDK + MnemoPay Integration Guide

MnemoPay adds two things to the Claude Agent SDK pattern that nothing else gives you out of the box: a stable 1-hour prompt-cache layer for recall results, and clean per-subagent cost attribution in a double-entry ledger. This guide walks through both end to end.

---

## Install

```bash
npm install @mnemopay/sdk
npm install @anthropic-ai/sdk   # peer dep — already in your project if you're using Agent SDK
```

---

## 10-line quick start: recall + Claude cache

```ts
import MnemoPay from "@mnemopay/sdk";
import Anthropic from "@anthropic-ai/sdk";

const agent = MnemoPay.quick("my-agent");
const anthropic = new Anthropic();

await agent.remember("User prefers metric units", { importance: 0.8 });
await agent.remember("Last order: 3x API seats, $75/mo", { importance: 0.9 });

const cacheBlock = await agent.recall("user context", 10, { formatForClaudeCache: true });

const response = await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are a helpful assistant." }, cacheBlock],
  messages: [{ role: "user", content: "What plan is the user on?" }],
});
```

That's it. On the first call `cacheBlock` is written to the Anthropic cache. Every call in the next hour that sends the same recall payload reads from cache at ~10% of the normal input token price.

---

## How the cache prefix works

When `formatForClaudeCache` is `true`, `recall()` returns a `ClaudeCacheBlock` instead of `Memory[]`:

```ts
// ClaudeCacheBlock shape
{
  type: "text",
  text: "[Memory Cache]\nmem-abc: User prefers metric units (importance=0.800, tags=pref)\nmem-xyz: Last order: 3x API seats (importance=0.900, tags=billing)",
  cache_control: { type: "ephemeral", ttl: 3600 }
}
```

Key design detail: memories are **sorted by id** before serialization. This means two `recall()` calls that return the same memory set produce byte-identical `text`, which is what makes the Anthropic cache prefix actually hit. If you change importance, add/remove a memory, or use a different query that returns a different set — the text changes, the cache misses, and a fresh write happens.

The `ttl: 3600` value tells Anthropic to use the 1-hour extended TTL window (requires the extended-TTL beta on your account; falls back to the standard 5-minute window if your account doesn't have it yet).

### Static helper for existing memory arrays

If you've already called `recall()` and have a `Memory[]`, you don't need to call again:

```ts
import { formatForClaudeCache } from "@mnemopay/sdk";

const memories = await agent.recall("user preferences", 10);
const block = formatForClaudeCache(memories);

// Or via the class static:
const block2 = MnemoPay.formatForClaudeCache(memories, { ttlSeconds: 300 }); // 5-min TTL
```

---

## Memory integrity as a receipt

MnemoPay's Merkle tree proves that the memories you fed into the system prompt haven't been tampered with since you last snapshotted them. Use this as an audit receipt for regulated environments.

```ts
import MnemoPay, { MerkleTree } from "@mnemopay/sdk";

const agent = MnemoPay.quick("my-agent");
const tree = new MerkleTree();

// Each time you store a memory, add it to the Merkle tree
const id = await agent.remember("API rate limit is 1000 req/min");
tree.addLeaf(id, "API rate limit is 1000 req/min");

// Take a snapshot — store this hash in your DB, a contract, or a log
const snapshot = tree.snapshot();
// → { rootHash: "a3f2c8...", leafCount: 1, snapshotHash: "b7c1d9..." }

// Before feeding memories into a prompt, verify integrity
const memories = await agent.recall("rate limits");
for (const m of memories) {
  tree.addLeaf(m.id, m.content); // re-build tree if needed
}
const check = tree.detectTampering(snapshot);
if (check.tampered) {
  throw new Error(`Memory tampering detected: ${check.summary}`);
}
// Safe to proceed — memories match the snapshot
```

---

## Per-subagent cost attribution

The Agent SDK pattern: Opus orchestrator spawns Sonnet research workers and a Haiku formatter. Each makes Claude API calls. No existing tool tells you what each subagent cost — until now.

MnemoPay records each attribution as a double-entry ledger pair:
- **Debit** `subagent_compute:{parentAgentId}` — the parent bears the cost
- **Credit** `compute_earned:{subagentId}` — the subagent "earned" the compute

This keeps the ledger balanced and gives you a clean audit trail.

```ts
import MnemoPay, { SubagentCostTracker } from "@mnemopay/sdk";

const orchestrator = MnemoPay.quick("orchestrator");
// SubagentCostTracker is automatically wired to orchestrator.ledger
// Access it via orchestrator.subagentCosts

// After each Claude API call (use usage object from the Anthropic response):
orchestrator.subagentCosts.attributeSubagentCost({
  parentAgentId: "orchestrator",
  subagentId: "researcher-1",
  subagentRole: "researcher",
  modelId: "claude-sonnet-4-6",
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
  cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  cacheWriteTtl: "1h",  // matches the TTL you passed to formatForClaudeCache
});

// Get a cost breakdown for the full pipeline run
const breakdown = orchestrator.subagentCosts.subagentCostBreakdown("orchestrator");
for (const entry of breakdown) {
  console.log(
    `${entry.subagentRole} (${entry.modelId}): ` +
    `$${entry.totalCostUsd.toFixed(6)} ` +
    `saved $${entry.cacheSavingsUsd.toFixed(6)} via cache`
  );
}

// Totals
console.log("Total cost:", orchestrator.subagentCosts.totalCost("orchestrator"));
console.log("Total cache savings:", orchestrator.subagentCosts.totalCacheSavings("orchestrator"));
```

### Time-range filtering

```ts
// Cost breakdown for a specific run window
const runBreakdown = orchestrator.subagentCosts.subagentCostBreakdown("orchestrator", {
  sinceTs: runStartTime.toISOString(),
  untilTs: runEndTime.toISOString(),
});
```

---

## Full Agent SDK example

A complete Opus orchestrator + Sonnet workers pipeline with MnemoPay recall caching and cost attribution:

```ts
import MnemoPay, { SubagentCostTracker } from "@mnemopay/sdk";
import Anthropic from "@anthropic-ai/sdk";

const PARENT_ID = "research-orchestrator";
const agent = MnemoPay.quick(PARENT_ID);
const anthropic = new Anthropic();

// Load agent memory (persisted across sessions automatically)
await agent.remember("Research scope: renewable energy storage", { importance: 0.9 });
await agent.remember("User wants executive-level summary", { importance: 0.8 });

async function runResearchPipeline(topic: string) {
  // Step 1: Build a cached recall block from agent memory
  const memoryBlock = await agent.recall(topic, 10, { formatForClaudeCache: true });

  // Step 2: Opus orchestrator plans the research
  const planResponse = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 512,
    system: [
      { type: "text", text: "You are a research orchestrator. Plan a 3-step research task." },
      memoryBlock,  // cached for 1 hour
    ],
    messages: [{ role: "user", content: `Plan research on: ${topic}` }],
  });

  agent.subagentCosts.attributeSubagentCost({
    parentAgentId: PARENT_ID,
    subagentId: "opus-planner",
    subagentRole: "orchestrator",
    modelId: "claude-opus-4-7",
    inputTokens: planResponse.usage.input_tokens,
    outputTokens: planResponse.usage.output_tokens,
    cacheReadTokens: planResponse.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: planResponse.usage.cache_creation_input_tokens ?? 0,
    cacheWriteTtl: "1h",
  });

  const plan = planResponse.content[0].type === "text" ? planResponse.content[0].text : "";

  // Step 3: Sonnet workers execute each step in parallel
  const steps = ["step-1", "step-2", "step-3"];
  const results = await Promise.all(
    steps.map(async (step) => {
      const workerResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: [
          { type: "text", text: `You are a research specialist. Execute ${step} of the plan.` },
          memoryBlock,  // same cached block — no recharge, cache hit
        ],
        messages: [{ role: "user", content: plan }],
      });

      agent.subagentCosts.attributeSubagentCost({
        parentAgentId: PARENT_ID,
        subagentId: `sonnet-worker-${step}`,
        subagentRole: "researcher",
        modelId: "claude-sonnet-4-6",
        inputTokens: workerResponse.usage.input_tokens,
        outputTokens: workerResponse.usage.output_tokens,
        cacheReadTokens: workerResponse.usage.cache_read_input_tokens ?? 0,
        cacheWriteTtl: "1h",
      });

      return workerResponse.content[0].type === "text" ? workerResponse.content[0].text : "";
    }),
  );

  // Step 4: Haiku formats the final output
  const formatResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: [
      { type: "text", text: "Format the research findings as an executive summary." },
      memoryBlock,  // still cached
    ],
    messages: [{ role: "user", content: results.join("\n\n") }],
  });

  agent.subagentCosts.attributeSubagentCost({
    parentAgentId: PARENT_ID,
    subagentId: "haiku-formatter",
    subagentRole: "formatter",
    modelId: "claude-haiku-4-5",
    inputTokens: formatResponse.usage.input_tokens,
    outputTokens: formatResponse.usage.output_tokens,
    cacheReadTokens: formatResponse.usage.cache_read_input_tokens ?? 0,
    cacheWriteTtl: "1h",
  });

  // Print cost breakdown
  const breakdown = agent.subagentCosts.subagentCostBreakdown(PARENT_ID);
  console.log("\n--- Pipeline cost breakdown ---");
  for (const entry of breakdown) {
    console.log(`  ${entry.subagentRole.padEnd(16)} $${entry.totalCostUsd.toFixed(6)}  cache saved: $${entry.cacheSavingsUsd.toFixed(6)}`);
  }
  console.log(`  ${"TOTAL".padEnd(16)} $${agent.subagentCosts.totalCost(PARENT_ID).toFixed(6)}`);
  console.log(`  ${"CACHE SAVINGS".padEnd(16)} $${agent.subagentCosts.totalCacheSavings(PARENT_ID).toFixed(6)}`);

  return formatResponse.content[0].type === "text" ? formatResponse.content[0].text : "";
}

const summary = await runResearchPipeline("solid-state battery breakthroughs 2025");
console.log("\nResult:", summary);
```

---

## API reference

### `recall(query, limit, { formatForClaudeCache: true })`

Returns a `ClaudeCacheBlock` instead of `Memory[]` when the flag is set.

```ts
interface ClaudeCacheBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral"; ttl: number };
}
```

### `MnemoPay.formatForClaudeCache(memories, opts?)`

Static helper. Converts any `Memory[]` to a `ClaudeCacheBlock`. Also exported as `formatForClaudeCache` from the module root.

Options:
- `prefix` — header line prefix (default: `[Memory Cache]`)
- `includeScore` — whether to include computed score in text (default: `false` to keep output stable)
- `ttlSeconds` — cache TTL in seconds (default: `3600`)

### `agent.subagentCosts.attributeSubagentCost(params)`

Records one inference event to the ledger. Params:

| Field | Type | Required | Notes |
|---|---|---|---|
| `parentAgentId` | string | yes | Orchestrator ID |
| `subagentId` | string | yes | Subagent ID |
| `subagentRole` | string | yes | Human label (e.g. "researcher") |
| `modelId` | string | yes | Must be in `MODEL_PRICING` |
| `inputTokens` | number | yes | Regular input tokens |
| `outputTokens` | number | yes | Output tokens |
| `cacheReadTokens` | number | no | Tokens read from cache (0.1× rate) |
| `cacheWriteTokens` | number | no | Tokens written to cache |
| `cacheWriteTtl` | "5m" \| "1h" | no | Default "5m" |
| `timestamp` | string | no | ISO timestamp, defaults to now |

### `agent.subagentCosts.subagentCostBreakdown(parentAgentId, opts?)`

Returns `SubagentCostBreakdownEntry[]` sorted by `totalCostUsd` descending.

```ts
interface SubagentCostBreakdownEntry {
  subagentId: string;
  subagentRole: string;
  modelId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheSavingsUsd: number;
  eventCount: number;
}
```

---

## Pricing table

Current values in `MODEL_PRICING` (2026 Anthropic list rates — not guaranteed to stay current):

| Model | Input/M | Output/M | Cache read | Cache write 1h |
|---|---|---|---|---|
| claude-opus-4-7 | $5.00 | $25.00 | $0.50 (0.1×) | $10.00 (2×) |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.30 (0.1×) | $6.00 (2×) |
| claude-haiku-4-5 | $1.00 | $5.00 | $0.10 (0.1×) | $2.00 (2×) |

To add a new model, export and extend `MODEL_PRICING` from `@mnemopay/sdk`:

```ts
import { MODEL_PRICING } from "@mnemopay/sdk";
MODEL_PRICING["claude-new-model"] = {
  inputPerMillion: 2.00,
  outputPerMillion: 10.00,
  cacheReadMultiplier: 0.1,
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2.0,
};
```
