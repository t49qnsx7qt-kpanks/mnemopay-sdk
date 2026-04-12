import { describe, it } from "vitest";
import { MnemoPay } from "./src/index.js";

const TOTAL_TRANSACTIONS = 200_000;
const AGENT_COUNT = 50;
const STRESS_FRAUD = {
  maxChargesPerMinute: 500_000, maxChargesPerHour: 5_000_000,
  maxChargesPerDay: 50_000_000, maxDailyVolume: 500_000_000,
  settlementHoldMinutes: 0, anomalyStdDevThreshold: 1000,
  blockThreshold: 2.0, flagThreshold: 2.0, maxPendingTransactions: 100_000,
};
function createAgent(id: string) { return MnemoPay.quick(id, { debug: false, fraud: STRESS_FRAUD }); }
function heapMB() { return process.memoryUsage().heapUsed / 1024 / 1024; }
function randomAmount(): number {
  const roll = Math.random();
  let raw: number;
  if (roll < 0.40) raw = Math.random() * 0.99 + 0.01;
  else if (roll < 0.70) raw = Math.random() * 49 + 1;
  else if (roll < 0.90) raw = Math.random() * 200 + 50;
  else raw = Math.random() * 150 + 100;
  return Math.round(raw * 100) / 100;
}

describe("full suite peak tracker", () => {
  const agents: ReturnType<typeof createAgent>[] = [];
  const agentTxIds: Map<string, string[]> = new Map();
  let initialHeap = 0;
  let peak = 0;
  let peakLabel = '';

  function track(label: string) {
    const h = heapMB();
    if (h > peak) { peak = h; peakLabel = label; }
    return h;
  }

  it("scenario 1: provision agents", () => {
    initialHeap = heapMB();
    peak = initialHeap;
    for (let i = 0; i < AGENT_COUNT; i++) {
      const a = createAgent(`stress200k-agent-${i}`);
      agents.push(a);
      agentTxIds.set(a.agentId, []);
    }
    track("after provision");
  });

  it("scenario 2: 200K charges", async () => {
    const batchSize = 200;
    const rounds = Math.ceil(TOTAL_TRANSACTIONS / batchSize);
    for (let round = 0; round < rounds; round++) {
      const promises: Promise<void>[] = [];
      const count = Math.min(batchSize, TOTAL_TRANSACTIONS - round * batchSize);
      for (let j = 0; j < count; j++) {
        const agentIdx = (round * batchSize + j) % AGENT_COUNT;
        const agent = agents[agentIdx]!;
        promises.push((async () => {
          try {
            const tx = await agent.charge(randomAmount(), `stress-${round}-${j}`);
            agentTxIds.get(agent.agentId)!.push(tx.id);
          } catch {}
        })());
      }
      await Promise.all(promises);
      if (round % 500 === 0) track(`charge round ${round}`);
    }
    const h = track("after 200K charges");
    console.log(`  scenario 2 ends: ${h.toFixed(1)} MB = ${(h/initialHeap).toFixed(2)}x`);
  }, 300_000);

  it("scenario 3: settle 80%", async () => {
    for (const agent of agents) {
      const txIds = agentTxIds.get(agent.agentId)!;
      const settleCount = Math.floor(txIds.length * 0.8);
      for (let i = 0; i < settleCount; i++) {
        try { await agent.settle(txIds[i]!); } catch {}
      }
    }
    const h = track("after settle 80%");
    console.log(`  scenario 3 ends: ${h.toFixed(1)} MB = ${(h/initialHeap).toFixed(2)}x`);
  }, 300_000);

  it("scenario 5: partial failures", async () => {
    const failAgent = createAgent("stress200k-fail");
    for (let i = 0; i < 100; i++) { // small sample
      try { await failAgent.charge(-1, `bad-${i}`); } catch {}
    }
    track("after partial failures");
  }, 30_000);

  it("scenario 9: precision 10K", async () => {
    const precAgent = createAgent("stress200k-precision");
    for (let i = 0; i < 1000; i++) { // 1K sample
      try {
        const tx = await precAgent.charge(0.01 * (1 + i % 100), `precision-${i}`);
        await precAgent.settle(tx.id);
      } catch {}
    }
    const h = track("after precision test");
    console.log(`  scenario 9 (1K sample): ${h.toFixed(1)} MB = ${(h/initialHeap).toFixed(2)}x`);
  }, 30_000);

  it("scenario 11: agent churn 100 agents", async () => {
    const ephemeralAgents: ReturnType<typeof createAgent>[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      for (let j = 0; j < 5; j++) {
        const a = createAgent(`stress200k-ephemeral-${cycle}-${j}`);
        ephemeralAgents.push(a);
        try {
          const tx = await a.charge(5, "ephemeral-work");
          await a.settle(tx.id);
        } catch {}
      }
    }
    const h = track("after agent churn");
    console.log(`  scenario 11: ${h.toFixed(1)} MB = ${(h/initialHeap).toFixed(2)}x (${ephemeralAgents.length} ephemeral agents still in scope)`);
  }, 30_000);

  it("final report", () => {
    const h = track("final");
    console.log(`\nPeak: ${peak.toFixed(1)} MB = ${(peak/initialHeap).toFixed(2)}x at "${peakLabel}"`);
    console.log(`Initial: ${initialHeap.toFixed(1)} MB`);
  });
});
