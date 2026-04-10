# MnemoPay

**The trust & reputation layer for AI agents.** Agent Credit Score + Behavioral Finance + Payments + Memory + Identity in one SDK.

Your agent builds a credit score, detects fraud in real time, makes psychologically sound financial decisions, and proves its memory hasn't been tampered with. All on top of persistent memory, real payment rails, and a double-entry ledger that never drifts by a penny.

```bash
npm install @mnemopay/sdk
```

```ts
import MnemoPay, { AgentCreditScore, BehavioralEngine, MerkleTree } from "@mnemopay/sdk";

const agent = MnemoPay.quick("my-agent");

await agent.remember("User prefers monthly billing");
const tx = await agent.charge(25, "Monthly API access");
await agent.settle(tx.id);

// Score the agent (300-850, like human FICO)
const fico = new AgentCreditScore();
const score = fico.compute({ transactions: [tx], createdAt: new Date(), ...});
// → { score: 672, rating: "good", feeRate: 0.015, trustLevel: "standard" }
```

14 modules. Hash-chained ledger. Replay detection. Reputation streaks. 100K-operation stress tested. Apache 2.0 licensed.

---

## Building an MCP server? Start here.

If you're shipping an MCP server and want to charge per-call — even sub-cent amounts — MnemoPay is built for you.

- **Sub-cent payments** via Lightning rail (impossible on Stripe/Paystack due to fees)
- **Per-tool metering** with `agent.charge(amount, toolName)` — two lines of code
- **Agent Credit Score** gates abusive callers automatically — 300-850 credit score, free tier + paid tier
- **Cryptographic receipts** every user can audit — no "trust me bro" billing
- **Free indefinitely** for the first 10 MCP servers that adopt it, subject to 90 days' written notice of any future change ([email](mailto:omiagbogold@icloud.com) with your repo)

```ts
import MnemoPay from "@mnemopay/sdk";
const agent = MnemoPay.quick("my-mcp-server");

// Inside your tool handler:
const tx = await agent.charge(0.002, "embed_document");  // 0.2¢
if (tx.status === "blocked") return { error: "Payment declined" };
await agent.settle(tx.id);
// ... run the tool
```

Zero-config starter → production Lightning rail → Agent Credit Score gating. Same API.

---

## What Makes MnemoPay Different

$87M has been invested across 5 competitors. None have more than 3 of these 10 features:

| Feature | MnemoPay | Mem0 ($24M) | Skyfire ($9.5M) | Kite ($33M) | Payman ($14M) |
|---|:---:|:---:|:---:|:---:|:---:|
| Persistent Memory | **Yes** | Yes | No | No | No |
| Payment Rails (3) | **Yes** | No | USDC only | Stablecoin | Bank only |
| Agent Identity (KYA) | **Yes** | No | Building | Passport | No |
| **Agent Credit Score (300-850)** | **Yes** | No | No | No | No |
| **Behavioral Finance** | **Yes** | No | No | No | No |
| **Memory Integrity (Merkle)** | **Yes** | No | No | No | No |
| **EWMA Anomaly Detection** | **Yes** | No | No | No | No |
| Double-Entry Ledger | **Yes** | No | No | No | No |
| Autonomous Commerce | **Yes** | No | No | No | No |
| Multi-Agent Network | **Yes** | No | Partial | Partial | No |
| **Score** | **10/10** | 1/10 | 2/10 | 2/10 | 1/10 |

---

## Agent Credit Score — Credit Score for AI Agents

A novel cross-session credit scoring system for AI agents. Five-component scoring on a 300-850 range (familiar to developers from consumer credit; MnemoPay is not affiliated with Fair Isaac Corporation or any consumer credit bureau):

```ts
import { AgentCreditScore } from "@mnemopay/sdk";

const fico = new AgentCreditScore();
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

Peer-reviewed behavioral economics from Nobel laureate Daniel Kahneman and collaborators. Every parameter cited to published research.

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

## Memory (Compounding Knowledge Base)

Not a traditional RAG lookup. MnemoPay memories compound — every transaction strengthens associated context, weak memories decay, strong ones consolidate. The same pattern Karpathy describes as "LLM Wiki" but applied to payments and trust.

- **Ebbinghaus forgetting curve** — memories decay naturally over time
- **Hebbian reinforcement** — successful transactions strengthen associated memories
- **Consolidation** — auto-prunes weak memories, keeps what matters
- **Semantic recall** — find memories by relevance, not just recency
- **100KB per memory** — store rich context, not just strings

## Reputation Streaks & Badges

Agents earn trust over time. Consecutive successful settlements build streaks that unlock badges and reduce fees.

```ts
const rep = await agent.reputation();
console.log(rep.streak);
// → { currentStreak: 47, bestStreak: 312, streakBonus: 0.094 }

console.log(rep.badges);
// → [
//   { id: "first_settlement", name: "First Settlement", earnedAt: 1712700000000 },
//   { id: "streak_50", name: "Streak Master", earnedAt: 1712900000000 },
//   { id: "volume_10k", name: "High Roller", earnedAt: 1713100000000 },
// ]
```

| Badge | Requirement |
|---|---|
| First Settlement | Complete 1 settlement |
| Streak 10 | 10 consecutive settlements |
| Streak 50 | 50 consecutive settlements |
| Volume $1K | $1,000+ total settled |
| Volume $10K | $10,000+ total settled |
| Perfect Record | 100+ settlements, 0 disputes |

Streaks reset on refunds or disputes. Streak bonuses compound reputation up to +10%.

## Hash-Chained Ledger

Every ledger entry links to the previous via SHA-256 hash chain. If any entry is modified, the chain breaks and `verify()` catches it instantly.

```ts
const summary = agent.ledger.verify();
console.log(summary.chainValid);     // true
console.log(summary.chainIntegrity); // 1.0 (100% of links verified)
```

Combined with Merkle integrity on memories and HMAC on transactions, MnemoPay gives you three independent tamper-detection systems.

## Payments (cent-precise double-entry)

- **Double-entry bookkeeping** — every debit has a credit, always balances to zero
- **Escrow flow** — charge -> hold -> settle -> refund (same shape as Stripe/Square)
- **Volume-tiered fees** — 1.9% / 1.5% / 1.0% based on cumulative volume
- **3 payment rails** — Paystack (Africa), Stripe (global), Lightning (BTC)
- **Cent-precise integer math** — stress-tested with 100,000 transactions across 10 concurrent agents, zero drift

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

### Stripe — real card charges with saved customers

End-to-end flow for charging a user's saved card without a browser handoff:

```ts
import MnemoPay, { StripeRail } from "@mnemopay/sdk";

const rail = new StripeRail(process.env.STRIPE_SECRET_KEY!);
const agent = MnemoPay.quick("agent-1", { paymentRail: rail });

// 1. Create a Stripe customer (one-time, persist cus_... to your DB)
const { customerId } = await rail.createCustomer("user@example.com", "Jerry O");

// 2. Collect a card via Stripe.js: create a SetupIntent, return client_secret
//    to the browser, let Stripe Elements confirm it. You receive pm_... from
//    the webhook or confirmation callback. Save it alongside the customer.
const { clientSecret } = await rail.createSetupIntent(customerId);
// → hand clientSecret to frontend, get back paymentMethodId after confirm

// 3. Charge the saved card later, off-session, no user interaction needed
const tx = await agent.charge(25, "Monthly API access", undefined, {
  customerId,
  paymentMethodId: "pm_saved_from_step_2",
  offSession: true,
});

// 4. Settle (captures the hold) or refund (releases it)
await agent.settle(tx.id);
```

Paystack supports the same pattern via `authorizationCode`:

```ts
const tx = await agent.charge(5000, "NGN invoice", undefined, {
  email: "customer@example.com",
  authorizationCode: "AUTH_abc123", // from an earlier Paystack transaction
});
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
│                    MnemoPay SDK v1.2.0                     │
├──────────┬──────────┬───────────┬──────────────────────────┤
│  Memory  │ Payments │ Identity  │  Agent Credit Score (300-850)    │
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

- `core.test.ts` — memory, payments, lifecycle, FICO, behavioral, Merkle, EWMA, canaries, streaks, badges
- `fraud.test.ts` — velocity, anomaly, fees, disputes, replay detection
- `geo-fraud.test.ts` — geo signals, trust, sanctions
- `identity.test.ts` — KYA, tokens, permissions
- `production-100k.test.ts` — 100K operations, 10 concurrent agents, hash-chain verification, zero drift
- `ledger.test.ts` — double-entry, reconciliation
- `network.test.ts` — multi-agent, deals, supply chains
- `paystack.test.ts` — rail, webhooks, transfers
- `stress.test.ts` — 1000-cycle precision, parallel ops
- `recall.test.ts` — semantic search, decay, reinforcement

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2026 J&B Enterprise LLC.

---

## Trademark and regulatory notices

**Agent Credit Score** is a creditworthiness scoring system **for autonomous software agents**, not for consumer credit reporting. It does not produce a consumer report as defined by the Fair Credit Reporting Act (FCRA) and is not regulated under the FCRA. MnemoPay is not a consumer reporting agency.

MnemoPay is not a bank, money transmitter, or insurer, and does not hold customer deposits. Payments are settled through third-party payment rails (Stripe, Paystack, Lightning Network) — MnemoPay is software that connects to those rails on behalf of developers, not a financial institution.

"FICO" is a registered trademark of Fair Isaac Corporation. MnemoPay and its Agent Credit Score module are not affiliated with, endorsed by, or derived from Fair Isaac Corporation. The `AgentFICO` export name is a deprecated alias kept for backward compatibility with earlier beta releases and will be removed in a future major version.

---

Built by [Jerry Omiagbo](https://github.com/mnemopay)
