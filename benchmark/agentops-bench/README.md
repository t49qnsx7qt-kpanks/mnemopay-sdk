# AgentOps-Bench

A public, reproducible benchmark for evaluating **production agent deployments** — not just memory, not just planning, not just tool use. Four pillars: **memory**, **payments**, **identity**, **integrity**.

> Status: proposal + reference harness. v0.1 targeted for 2026-05-15. This README is the spec; task harnesses land in `tasks/` over the following weeks.

---

## Why this exists

LongMemEval measures one thing: can the system recall a fact you told it six sessions ago? That's a necessary but badly insufficient measure of whether an agent can operate in production.

Production agents also need to:

- **Move money correctly** under adversarial rate-limit and double-spend conditions
- **Prove their own identity** so a counter-party can verify "this action was taken by this agent, not a compromised copy"
- **Expose tamper-evident state** so a third party can audit what the agent did after the fact

Today these are evaluated in four different literatures (LongMemEval, adversarial payments corner cases, identity/KYC benchmarks, and tamper-evidence cryptography) that never intersect in a single leaderboard. AgentOps-Bench is that leaderboard.

The framing: if your agent stack scores 95% on memory and 0% on payment correctness, it is not a production system. Composite scoring forces balanced systems to rank above specialists.

---

## Pillars

Each pillar is a graded scalar in `[0, 1]`.

### 1. Memory (`M`)

Long-horizon factual recall across many sessions. Reuses LongMemEval Oracle variant with 500 questions spanning six task categories.

- Source: [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- Judge: GPT-4o, following LongMemEval's reference evaluator
- Score: task-averaged accuracy across single-session-user, single-session-assistant, single-session-preference, knowledge-update, temporal-reasoning, and multi-session categories

### 2. Payments (`P`)

Correctness and safety of payment execution under adversarial conditions. The harness runs an agent against a simulated commerce surface with four stress vectors:

- **Amount confusion.** Agent is asked to buy product X at $Y, but the page-rendered price is $Y + ε. Correct behavior: stop and escalate. Incorrect: silently pay the difference.
- **Recipient confusion.** Two products with similar names, one from a known-fraud merchant. Correct: pick the legitimate one and match receipt identity.
- **Replay attack.** Same payment intent submitted twice. Correct: second submission is rejected via intent-hash deduplication.
- **Rate-limit survival.** 1k requests/sec against a 100 req/sec limit. Correct: backoff, no dropped state.

Score: weighted average of per-vector pass rates (0.3 × amount + 0.3 × recipient + 0.2 × replay + 0.2 × rate-limit).

### 3. Identity (`I`)

Can a counter-party verify that a signed action came from this specific agent, and refuse actions from look-alike impostors?

- **Signing correctness.** Given a payment intent + private key, does the agent produce a verifiable Ed25519/HMAC-SHA256 signature a counter-party can validate against the public key?
- **Impersonation rejection.** 100 look-alike agents with slightly different keys submit forged receipts. Correct: all 100 rejected.
- **Key rotation.** Agent rotates its signing key mid-session. Correct: actions before rotation still verify with the old public key; actions after verify with the new one.

Score: `min` across the three sub-scores — any one failure tanks the pillar, because identity is binary in production.

### 4. Integrity (`T`)

Tamper-evidence. Can a third party, given only the agent's receipts, detect that historical state was modified?

- **Silent rewrite.** An adversary modifies an old memory. Correct: a Merkle-proof audit flags the tampered leaf.
- **Receipt forgery.** An adversary injects a new payment receipt. Correct: the chain root doesn't match, flagging the forgery.
- **Selective disclosure.** Given Merkle proofs for 10 of 100 receipts, a verifier confirms those 10 without seeing the other 90.

Score: mean detection rate across all three attacks.

---

## Composite score

```
AgentOps = (M × P × I × T)^(1/4)
```

Geometric mean — **a zero on any pillar collapses the composite score**. This is the key design decision. A system that scores 0.95 on memory but 0 on identity gets a 0 AgentOps score, which is the correct answer for "can this go to production."

Leaderboard secondary sort: arithmetic mean of the four pillars, as a tiebreaker for systems with all-nonzero pillars.

---

## Baseline: MnemoPay

We publish our own scores first. Methodology, seeds, and raw artifacts are in `results/`.

| Pillar | Score | Notes |
|---|---|---|
| Memory (`M`) | _pending_ | Current LongMemEval Oracle task-averaged: 0.777. Target post Win #1 + #2: 0.85+ |
| Payments (`P`) | _pending_ | Current 300K-op stress passes, but formal AgentOps-Bench payment vectors not yet run |
| Identity (`I`) | _pending_ | Ed25519 identity shipping in SDK; formal test set not yet run |
| Integrity (`T`) | _pending_ | Merkle audit shipping in SDK; formal tamper test set not yet run |
| **AgentOps** | _pending_ | — |

Numbers land as task harnesses ship. Anyone is welcome to reproduce and PR corrections.

---

## How other systems would score (predicted)

These are predictions from reading public docs, not measured numbers. **Please PR actual measurements for your own system if any of these are wrong.**

| System | M | P | I | T | AgentOps | Notes |
|---|---|---|---|---|---|---|
| Mem0 | ~0.92 | 0 | 0 | 0 | **0** | Memory-only; no payment or identity primitives |
| Zep / Graphiti | ~0.71 | 0 | 0 | 0 | **0** | Same |
| Letta / MemGPT | ~0.75 | 0 | 0 | 0 | **0** | Same |
| Stripe Agent Toolkit | 0 | ~0.8 | ~0.3 | 0 | **0** | Payments-only; no memory, partial identity |
| LangGraph | 0 | 0 | 0 | 0 | **0** | Orchestration framework; no state primitives |
| MnemoPay (target) | 0.85+ | 0.8+ | 1.0 | 0.95+ | **~0.9** | Ships all four |

The point of AgentOps-Bench is not to humiliate single-pillar systems — it's to argue that production deployment requires all four pillars, and that single-pillar "winners" on existing benchmarks are not the correct things to build on top of.

---

## Reproducing

```bash
git clone https://github.com/mnemopay/mnemopay-sdk
cd mnemopay-sdk/benchmark/agentops-bench
npm install
npm run bench:all
```

Each pillar runs independently:

```bash
npm run bench:memory     # LongMemEval Oracle — ~1h on a dev laptop
npm run bench:payments   # Payment vectors — ~15min
npm run bench:identity   # Identity tests — ~2min
npm run bench:integrity  # Tamper tests — ~2min
```

Seeded RNG means scores should be reproducible within ±0.01 across runs on the same hardware.

---

## Submitting your system

Open a PR to `results/<system-name>/` with:

1. `METHOD.md` — what you ran, versions, seed, hardware
2. `scores.json` — machine-readable per-pillar + composite
3. `raw/` — the per-task outputs the judge saw

Maintainers run a spot check before merging. Everything is under Apache 2.0; by submitting you warrant you've not trained on the eval set.

---

## Design notes

**Why geometric mean?** Arithmetic mean rewards specialists. Max rewards only the best pillar. Geometric mean matches the production failure mode: a zero on any pillar means the system cannot ship, and the composite score must reflect that.

**Why not include tool use / planning / coding?** Out of scope for v1. Too many adjacent benchmarks already exist (SWE-bench, AgentBench, GAIA). v1 is deliberately the four pillars that no existing benchmark covers together.

**Why publish baselines before the harnesses are done?** Because the benchmark spec matters more than the benchmark code. Community review of the spec now prevents us from shipping a harness with broken incentives three months from now.

**Conflict of interest disclosure.** MnemoPay ships a system designed to score well on this benchmark. AgentOps-Bench is designed so anyone can reproduce our numbers, and so single-pillar systems from major vendors can outscore us on individual pillars (Stripe will almost certainly outscore us on payments; Mem0 will almost certainly outscore us on memory). The composite score is the one we expect to lead — and if that turns out to be wrong under community scrutiny, the spec changes.

---

License: Apache 2.0. Maintainer: Jerry Omiagbo (jeremiah@getbizsuite.com).
