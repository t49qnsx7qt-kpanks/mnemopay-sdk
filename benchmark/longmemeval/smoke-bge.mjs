import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1", ...dns.getServers()]);

process.on("uncaughtException", e => { console.error("UNCAUGHT:", e); process.exit(2); });
process.on("unhandledRejection", e => { console.error("UNHANDLED:", e); process.exit(3); });

try {
  console.log("step 1: importing SDK...");
  const sdk = await import("@mnemopay/sdk");
  console.log("step 2: keys =", Object.keys(sdk).filter(k => /bge|Mnemo|local/i.test(k)));

  const { MnemoPay, bgeStats, localEmbed } = sdk;
  console.log("step 3: creating agent...");
  const agent = MnemoPay.quick("bge-smoke", { recall: "hybrid", embeddings: "bge" });

  console.log("step 4: remembering (this triggers BGE load)...");
  await agent.remember("The user's favorite food is sushi");
  await agent.remember("The user loves jazz music");

  console.log("step 5: bgeStats after remember:", JSON.stringify(bgeStats, null, 2));

  console.log("step 6: recall...");
  const hits = await agent.recall("what does the user like to eat", 5);
  console.log("step 7: hits =", hits.length);
  for (const h of hits.slice(0, 2)) console.log("  hit:", h.content.slice(0, 50));

  console.log("step 8: bgeStats final:", JSON.stringify(bgeStats, null, 2));
  console.log("DONE");
} catch (e) {
  console.error("CATCH:", e);
  process.exit(4);
}
