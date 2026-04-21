import dns from "node:dns";
dns.setServers(["8.8.8.8", ...dns.getServers()]);
process.env.BGE_LOCAL_MODEL_PATH = new URL("./bge-model/", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");

const { localEmbed, RecallEngine } = await import("@mnemopay/sdk");
const engine = new RecallEngine({ strategy: "hybrid", embeddingProvider: "bge" });

const text = "The user's favorite food is sushi";
const bgeVec = await engine.embed("id1", text);
const localVec = localEmbed(text, 384);

let diffSum = 0, maxDiff = 0;
for (let i = 0; i < 384; i++) {
  const d = Math.abs(bgeVec[i] - localVec[i]);
  diffSum += d;
  if (d > maxDiff) maxDiff = d;
}
console.log("BGE dims:", bgeVec.length, "local dims:", localVec.length);
console.log("BGE first 5:", Array.from(bgeVec.slice(0, 5)).map(v => v.toFixed(4)));
console.log("Local first 5:", Array.from(localVec.slice(0, 5)).map(v => v.toFixed(4)));
console.log("Sum of |diffs|:", diffSum.toFixed(4), "Max diff:", maxDiff.toFixed(4));
let bgeNorm = 0;
for (let i = 0; i < 384; i++) bgeNorm += bgeVec[i] * bgeVec[i];
console.log("BGE L2 norm:", Math.sqrt(bgeNorm).toFixed(4), "(should be ~1.0)");
console.log("VECTORS DIFFERENT:", diffSum > 0.1 ? "YES" : "NO (problem!)");
