// FTS sanity check — verify SQLiteStorage → RecallEngine wiring.
// Direct import from dist to skip any package resolution quirks.
import { MnemoPay, SQLiteStorage } from "../../dist/index.js";

console.log("1. Creating SQLiteStorage(:memory:)");
const storage = new SQLiteStorage(":memory:");
console.log("2. Creating agent");
const agent = MnemoPay.quick("fts-sanity-test", {
  recall: "hybrid",
  embeddings: "local",
  storage,
});
console.log("3. Strategy:", agent.__proto__.constructor.name);

console.log("4. Storing memories");
await agent.remember("User asked about the weather in Paris", { tags: ["s:a"] });
await agent.remember("User loves Italian food pasta pizza", { tags: ["s:b"] });
await agent.remember("The project code name is zyxwqv-9401 and it matters", { tags: ["s:c"] });
await agent.remember("User discussed favorite programming languages", { tags: ["s:d"] });
await agent.remember("Thursday meeting covered quarterly goals", { tags: ["s:e"] });

console.log("5. Querying 'zyxwqv'");
const results = await agent.recall("zyxwqv", 3);
console.log("6. Top 3 hits:");
results.forEach((r, i) =>
  console.log(`   ${i + 1}. ${r.content.slice(0, 70)}`),
);
const top = results[0]?.content ?? "";
const pass = top.includes("zyxwqv");
console.log(`\nRESULT: Top-1 contains 'zyxwqv'? ${pass ? "PASS ✓" : "FAIL ✗"}`);

await agent.disconnect();
process.exit(pass ? 0 : 1);
