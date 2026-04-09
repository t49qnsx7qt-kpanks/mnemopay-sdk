# MnemoPay

**The credit bureau for AI agents.** Memory + Payments + Identity + Agent FICO + Behavioral Finance in one SDK.

Your agent builds a credit score, detects fraud in real time, makes psychologically sound financial decisions, and proves its memory hasn't been tampered with. All on top of persistent memory, real payment rails, and a double-entry ledger that never drifts by a penny.

```bash
npm install @mnemopay/sdk
```

```ts
import MnemoPay, { AgentFICO, BehavioralEngine, MerkleTree } from "@mnemopay/sdk";

const agent = MnemoPay.quick("my-agent");

await agent.remember("User prefers monthly billing");
const tx = await agent.charge(25, "Monthly API access");
await agent.settle(tx.id);

// Score the agent (300-850, like human FICO)
const fico = new AgentFICO();
const score = fico.compute({ transactions: [tx], createdAt: new Date(), ...});
// → { score: 672, rating: "good", feeRate: 0.015, trustLevel: "standard" }
```

14 modules. Zero vulnerabilities. Production-ready. MIT licensed.

---

## What Makes MnemoPay Different

$87M has been invested across 5 competitors. None have more than 3 of these 10 features:

| Feature | MnemoPay | Mem0 ($24M) | Skyfire ($9.5M) | Kite ($33M) | Payman ($14M) |
|---|:---:|:---:|:---:|:---:|:---:|
| Persistent Memory | **Yes** | Yes | No | No | No |
| Payment Rails (3) | **Yes** | No | USDC only | Stablecoin | Bank only |
| Agent Identity (KYA) | **Yes** | No | Building | Passport | No |
| **Agent FICO (300-850)** | **Yes** | No | No | No | No |
| **Behavioral Finance** | **Yes** | No | No | No | No |
| **Memory Integrity (Merkle)** | **Yes** | No | No | No | No |
| **EWMA Anomaly Detection** | **Yes** | No | No | No | No |
| Double-Entry Ledger | **Yes** | No | No | No | No |
| Autonomous Commerce | **Yes** | No | No | No | No |
| Multi-Agent Network | **Yes** | No | Partial | Partial | No |
| **Score** | **10/10** | 1/10 | 2/10 | 2/10 | 1/10 |

---

## Agent FICO — Credit Score for AI Agents

The first cross-session credit scoring system for AI agents. Mirrors human FICO (300-850 range) with five components:

```ts
import { AgentFICO } from "@mnemopay/sdk";

const fico = new AgentFICO();
const result = fico.compute({
  transactions: await agent.history(1000),
  createdAt: agentCreationDate,
  fraudFlags: 0,
  disputeCount: 0,
  disputesLost: 0,
  warnings: 0,
  budgetCap: 5000,
  memoriesCount: agent.memories.size,
});

console.log(result.score);     // 742
console.log(result.rating);    // "very_good"
console.log(result.feeRate);   // 0.013 (1.3%)
console.log(result.trustLevel); // "high"
console.log(result.requiresHITL); // false
```

| Component | Weight | What It Measures |
|---|---|---|
| Payment History | 35% | Success rate, disputes, recency-weighted |
| Credit Utilization | 20% | Spend vs budget cap, sweet spot 10-30% |
| History Length | 15% | Account age, activity density |
| Behavior Diversity | 15% | Counterparties, categories, amount range |
| Fraud Record | 15% | Fraud flags, disputes lost, warnings |

| Score Range | Rating | Trust Level | Fee Rate |
|---|---|---|---|
| 800-850 | Exceptional | Full trust | 1.0% |
| 740-799 | Very Good | High trust | 1.3% |
| 670-739 | Good | Standard | 1.5% |
| 580-669 | Fair | Reduced | 1.9% |
| 300-579 | Poor | Minimal + HITL | 2.5% |

---

## Behavioral Finance Engine

Nobel Prize-winning behavioral economics, implemented. Every parameter from peer-reviewed research.

```ts
import { BehavioralEngine } from "@mnemopay/sdk";

const behavioral = new BehavioralEngine();

// Prospect Theory (Kahneman & Tversky, 1992)
// Losses hurt 2.25x more than gains feel good
behavioral.prospectValue(100);   // { value: 57.5, domain: "gain" }
behavioral.prospectValue(-100);  // { value: -129.5, domain: "loss" }

// Should the agent wait before buying?
const cooling = behavioral.coolingOff(2000, 5000); // amount, monthly income
// → { recommended: true, hours: 3.2, riskLevel: "high", regretProbability: 0.65 }

// Frame spending as goal delay (2.25x more effective than gain framing)
const frame = behavioral.lossFrame(200, {
  name: "Emergency Fund", target: 10000, current: 3000, monthlySavings: 500
});
// → "This $200 purchase delays your Emergency Fund goal by 12 days."

// Save More Tomorrow (Thaler & Benartzi, 2004)
const smart = behavioral.commitmentDevice(0.035, 0.03, 4);
// → { finalRate: 0.095, explanation: "3.5% → 9.5% over 4 raise cycles" }

// Predict regret from purchase history
behavioral.recordRegret({ amount: 300, category: "gadgets", regretScore: 8, timestamp: "..." });
const prediction = behavioral.predictRegret(400, "gadgets");
// → { probability: 0.72, triggerCoolingOff: true }
```

**Research sources:** Tversky & Kahneman 1992, Laibson 1997, Thaler & Benartzi 2004, Barber & Odean 2000, Nunes & Dreze 2006, Shiller 2000.

---

## Memory Integrity (Merkle Tree)

Tamper-evident memory. If anyone injects, modifies, or deletes an agent's memories, the Merkle root changes and you know.

```ts
import { MerkleTree } from "@mnemopay/sdk";

const tree = new MerkleTree();

// Every memory write adds a leaf
tree.addLeaf("mem-1", "User prefers monthly billing");
tree.addLeaf("mem-2", "Last purchase was $25 API access");

// Take periodic snapshots
const snapshot = tree.snapshot();
// → { rootHash: "a3f2...", leafCount: 2, snapshotHash: "b7c1..." }

// Later: check if memories were tampered
const check = tree.detectTampering(snapshot);
// → { tampered: false, summary: "Integrity verified. 2 memories, root matches." }

// Prove a specific memory exists without revealing others
const proof = tree.getProof("mem-1");
MerkleTree.verifyProof(proof); // true
```

**Defends against:** MemoryGraft injection, silent deletion, content tampering, replay attacks, reordering attacks.

---

## Anomaly Detection (EWMA + Behavioral Fingerprinting + Canaries)

Three independent systems that catch compromised agents.

```ts
import { EWMADetector, BehaviorMonitor, CanarySystem } from "@mnemopay/sdk";

// 1. EWMA: real-time streaming anomaly detection
const detector = new EWMADetector(0.15, 2.5, 3.5, 10);
detector.update(100); // normal
detector.update(100); // normal
detector.update(9999); // → { anomaly: true, severity: "critical", zScore: 8.2 }

// 2. Behavioral fingerprinting: detect hijacked agents
const monitor = new BehaviorMonitor({ warmupPeriod: 10 });
// Build profile over time
monitor.observe("agent-1", { amount: 100, hourOfDay: 14, chargesPerHour: 2 });
// Sudden change = suspected hijack
monitor.observe("agent-1", { amount: 9999, hourOfDay: 3, chargesPerHour: 50 });
// → { suspected: true, severity: "critical", anomalousFeatures: 3 }

// 3. Canary honeypots: plant traps for compromised agents
const canary = new CanarySystem();
const trap = canary.plant("transaction");
canary.check(trap.id, "rogue-agent");
// → { severity: "critical", message: "CANARY TRIGGERED: Agent compromised" }
```

**Math:** `mu_t = alpha * x_t + (1 - alpha) * mu_{t-1}`, alert when `|x_t - mu_t| > k * sigma_t` (Roberts 1959, Lucas & Saccucci 1990).

---

## Memory (Neuroscience-backed)

- **Ebbinghaus forgetting curve** — memories decay naturally over time
- **Hebbian reinforcement** — successful transactions strengthen associated memories
- **Consolidation** — auto-prunes weak memories, keeps what matters
- **Semantic recall** — find memories by relevance, not just recency
- **100KB per memory** — store rich context, not just strings

## Payments (Bank-grade math)

- **Double-entry bookkeeping** — every debit has a credit, always balances to zero
- **Escrow flow** — charge -> hold -> settle -> refund (same as Stripe/Square)
- **Volume-tiered fees** — 1.9% / 1.5% / 1.0% based on cumulative volume
- **3 payment rails** — Paystack (Africa), Stripe (global), Lightning (BTC)
- **Penny-precise** — stress-tested with 1,000 random transactions

## Identity (KYA Compliance)

- **Cryptographic identity** — HMAC-SHA256 keypairs, replay protection
- **Capability tokens** — scoped permissions with spend limits
- **Counterparty whitelists** — restrict who the agent can transact with
- **Kill switch** — revoke all tokens instantly

## Fraud Detection (ML-grade)

- **Velocity checks** — per-minute/hour/day limits
- **Isolation Forest** — unsupervised ML anomaly detection
- **Geo-enhanced** — country tracking, rapid-hop detection, OFAC sanctions
- **Adaptive engine** — asymmetric AIMD, anti-gaming, circuit breaker, PSI drift detection

## Multi-Agent Commerce

- **CommerceEngine** — autonomous shopping with mandates, escrow, approval callbacks
- **MnemoPayNetwork** — register agents, execute deals, shared memory context
- **Supply chains** — 10-step agent chains, 100-agent marketplaces, all tested

---

## Payment Rails

```ts
import { PaystackRail, StripeRail, LightningRail } from "@mnemopay/sdk";

// Africa (NGN, GHS, ZAR, KES)
const paystack = new PaystackRail(process.env.PAYSTACK_SECRET_KEY!);

// Global (USD, EUR, GBP)
const stripe = new StripeRail(process.env.STRIPE_SECRET_KEY!);

// Crypto (BTC via Lightning Network)
const lightning = new LightningRail(LND_URL, MACAROON);

const agent = MnemoPay.quick("my-agent", { paymentRail: paystack });
```

---

## MCP Server

```bash
npx @mnemopay/sdk init
# or
claude mcp add mnemopay -s user -- npx -y @mnemopay/sdk
```

Tools: `charge`, `settle`, `refund`, `remember`, `recall`, `balance`, `history`, `profile`, `reputation`, `fraud_stats`, `dispute`, `reinforce`, `consolidate`, `forget`, `logs`.

---

## Middleware

```ts
// OpenAI
import { mnemoPayMiddleware } from "@mnemopay/sdk/middleware/openai";

// Anthropic
import { mnemoPayMiddleware } from "@mnemopay/sdk/middleware/anthropic";

// LangGraph
import { mnemoPayTools } from "@mnemopay/sdk/langgraph";
```

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    MnemoPay SDK v1.0.0-beta.1              │
├──────────┬──────────┬───────────┬──────────────────────────┤
│  Memory  │ Payments │ Identity  │  Agent FICO (300-850)    │
│          │          │           │  5-component scoring     │
│ remember │ charge   │ KYA       ├──────────────────────────┤
│ recall   │ settle   │ tokens    │  Behavioral Finance      │
│ reinforce│ refund   │ perms     │  prospect theory, nudges │
│ forget   │ dispute  │ killswitch├──────────────────────────┤
│          │          │           │  Anomaly Detection       │
│          │          │           │  EWMA + fingerprinting   │
├──────────┴──────────┴───────────┼──────────────────────────┤
│     Double-Entry Ledger         │  Merkle Integrity        │
│  debit + credit = always zero   │  tamper-evident memory   │
├─────────────────────────────────┼──────────────────────────┤
│     Fraud Guard (ML-grade)      │  Canary Honeypots        │
│  velocity + geo + adaptive      │  compromise detection    │
├─────────────────────────────────┴──────────────────────────┤
│              Payment Rails                                 │
│        Paystack  │   Stripe   │   Lightning                │
└────────────────────────────────────────────────────────────┘
```

---

## Testing

```bash
npm test    # full test suite across 12 files
```

- `core.test.ts` — memory, payments, lifecycle, FICO, behavioral, Merkle, EWMA, canaries, stress tests
- `fraud.test.ts` — velocity, anomaly, fees, disputes
- `geo-fraud.test.ts` — geo signals, trust, sanctions
- `identity.test.ts` — KYA, tokens, permissions
- `ledger.test.ts` — double-entry, reconciliation
- `network.test.ts` — multi-agent, deals, supply chains
- `paystack.test.ts` — rail, webhooks, transfers
- `stress.test.ts` — 1000-cycle precision, parallel ops
- `recall.test.ts` — semantic search, decay, reinforcement

---

## License

MIT

---

Built by [Jerry Omiagbo](https://github.com/mnemopay)
