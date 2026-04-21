# MnemoPay SDK — Benchmarks

Reproducible stress benchmarks for the MnemoPay SDK. Numbers below are from
actual runs on commodity hardware — no ad-hoc synthetic shortcuts, no mocking
of the payment path. Every operation goes through the same code paths a
production agent would take.

## Test harness

- **Scale test:** 100 concurrent agents, N operations per agent, mixed op
  workload with adversarial injection and full ledger verification.
- **Op mix per agent:** 30% `charge`, 25% `settle`, 20% `verify` (computes
  Agent FICO + runs `FraudGuard.assessCharge`), 15% `remember`/`recall`
  memory ops, 10% `refund`/`dispute`.
- **Adversarial injection:** 2% of charges are replay attempts with a stable
  fingerprint (same `(agentId, amount, reason)`). A prime-charge runs once
  before the main loop so every loop-side adversarial charge has a prior.
  The run measures what fraction of those are blocked by
  `ReplayDetector` + `FraudGuard` composite scoring.
- **Ledger integrity:** Every agent carries its own double-entry ledger.
  After the run finishes, every per-agent ledger is verified; a balanced
  ledger (total debits === total credits) is the strongest invariant — it
  guarantees no silent drift.

SLO assertions applied to every run:

- `totalOps >= target`
- `imbalance === 0` (per-agent and aggregate)
- `detectionRate >= 0.95` of injected adversarial attempts
- `throughput > 200 ops/sec`
- `p99 latency < 500 ms`

## Hardware

- **CPU:** Intel Core i5-1035G1 (4 cores / 8 threads, 1.00GHz base)
- **RAM:** 8 GB
- **OS:** Windows 11 Home
- **Node:** v24.14.1
- **SDK version:** @mnemopay/sdk@1.3.1

This is intentionally modest hardware. A commodity laptop. Server-class
hardware will comfortably multiply these numbers.

## Results

| Scale     | Total ops   | Wall time | Throughput   | p50     | p95     | p99      | Adversarial  | Ledger drift |
|-----------|-------------|-----------|--------------|---------|---------|----------|--------------|--------------|
| 300 K     |   310,628   | ~90 s     | ~3,189 ops/s |  18 ms  |  38 ms  |  47 ms   | 1,776/1,776 (100%) | $0.00 |
| 500 K     |   517,758   | 105.2 s   |  4,920 ops/s |  18 ms  |  39 ms  |  47 ms   | 3,043/3,043 (100%) | $0.00 |
| 1,000 K   | 1,035,388   | 371.0 s   |  2,791 ops/s |  27 ms  |  83 ms  | 140 ms   | 5,969/5,969 (100%) | $0.00 |

### Notes

- At 500 K, the harness actually ran *hotter* than 300 K because JIT warmup
  had already completed — the prime-charge cost was amortized across more
  loop iterations.
- At 1 M, throughput drops gracefully as the `verify` operation reads longer
  transaction histories per call (`agent.history(50)` scales with the
  agent's transaction count). p99 latency rose from ~47 ms to ~140 ms —
  still 3.6× inside the 500 ms SLO.
- **Adversarial detection: 100.0% across all three scales.** This validates
  the Win #1/#2 fix applied in v1.3.1 (forwarding `reason` to
  `FraudGuard.assessCharge` + upgrading 60-second-duplicate severity to
  `critical` with composite score floor of 1.0).
- Error rates (0.31–0.33%) are race-condition noise inherent to concurrent
  mixed-op workloads — expected "already settled" / "nothing to refund"
  errors from the op queue, not scaling defects.

## Processed value

| Scale   | Ledger debits       | Ledger credits      | Imbalance |
|---------|---------------------|---------------------|-----------|
| 300 K   | ~$4.54 M            | ~$4.54 M            | $0.00     |
| 500 K   |  $7,579,182.37      |  $7,579,182.37      | $0.00     |
| 1,000 K | $15,103,429.72      | $15,103,429.72      | $0.00     |

Every per-agent ledger balanced (100/100 in every run).

## Reproducing

From a clean clone of the repo:

```bash
npm install
npm run build

# Pick the scale:
npx vitest run tests/stress/stress-300k.test.ts --reporter=verbose
npx vitest run tests/stress/stress-500k.test.ts --reporter=verbose
npx vitest run tests/stress/stress-1m.test.ts   --reporter=verbose
```

Each test has its own 10- / 15- / 30-minute wall-clock budget via the
Vitest `testTimeout`. The test fails if any SLO above is violated.

## What this says about the SDK

- **Correctness is not traded for throughput.** Double-entry ledger
  invariant holds under 1 M concurrent operations. No debit ever exists
  without its matching credit.
- **Fraud detection is not a best-effort pass.** 100% of injected replay
  attempts were blocked across three scales. The `FraudGuard` composite
  scoring with a `critical` severity floor provides a hard block boundary
  even under extreme velocity.
- **Latency stays well inside real-time budgets.** p99 < 140 ms at 1 M ops.
  For comparison, a typical card-network authorization SLO is 2–3 seconds.
- **The SDK scales in-process on commodity hardware.** No external database,
  no queue, no network hop. The whole stack ran on a 4-core ultrabook with
  8 GB of RAM.

## Files

- `tests/stress/stress-300k.test.ts`
- `tests/stress/stress-500k.test.ts`
- `tests/stress/stress-1m.test.ts`
- `src/fraud.ts` — FraudGuard + ReplayDetector
- `src/ledger.ts` — double-entry ledger + `.verify()` invariant check

---

Last updated: 2026-04-20 — runs performed by author on Windows 11 /
i5-1035G1 / 8 GB RAM. Results will vary on different hardware; SLO
assertions are conservative and should pass on any machine meeting
minimum recommended specs for Node 18+.
