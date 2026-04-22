# Annex IV Technical Documentation — @mnemopay/sdk

**Regulation:** EU AI Act (Regulation 2024/1689), Annex IV technical documentation requirements.
**Risk classification:** Limited risk (Article 50 transparency obligations applicable to agent interactions; not high-risk per Annex III).
**Last reviewed:** 2026-04-21
**Maintainer:** Jerry Omiagbo, J&B Enterprise LLC (d/b/a MnemoPay), jeremiah@getbizsuite.com

> This document is the voluntary technical-file stub MnemoPay maintains ahead of the Aug 2, 2026 GPAI + transparency deadlines. @mnemopay/sdk is a developer SDK — not a deployed AI system — so most Annex IV items are inherited from the deploying developer. What follows is the portion MnemoPay, as the SDK provider, holds responsible.

## 1. General description
@mnemopay/sdk (npm `@mnemopay/sdk`, PyPI `mnemopay`) is a software library. It gives AI agents (a) persistent memory with Ebbinghaus decay + Hebbian reinforcement, (b) payment rails (Stripe, Paystack, Lightning, x402), (c) a portable Agent Credit Score (300-850) built from behavioral signals, (d) Merkle-hash audit trails on every memory and payment event. Apache-2.0 license.

**Intended purpose.** To be embedded inside third-party AI agent software to provide memory persistence, payment authorization, and cryptographic audit. The SDK never acts autonomously — it executes commands issued by the deploying agent.

**Foreseeable misuse, excluded.** Use in biometric categorization, social scoring of natural persons, predictive policing, emotion inference in workplace/education, real-time remote biometric identification — all prohibited by Article 5 and explicitly out of scope. Agent FICO scores **must not** be fed back into treatment of human users; the SDK does not compute any human-directed score.

## 2. System architecture
- **Recall engine** (`/recall`) — TF-IDF + vector search with session summarization + entity graph spreading. No neural training component.
- **Payment rails** (`/rails`) — thin wrappers over Stripe, Paystack, Lightning Network, x402. Payment authorization is HITL-gated via approval policy (v1.0).
- **Agent FICO scorer** — deterministic formula over payment consistency, anomaly history, retrieval accuracy, identity. Published weights, no black-box model.
- **Anomaly detector** — EWMA + PSI drift; flags behavioral deviation for the deploying system.
- **Merkle integrity** — every write produces a verifiable receipt; a Merkle root is exposed via the SDK.

## 3. Data and data governance
- **Training data:** none. The SDK contains no trained neural components; Agent FICO is a deterministic formula.
- **Runtime data:** whatever the deploying agent stores in its own MnemoPay ledger. Data lives on the deployer's infrastructure (SQLite / Postgres). MnemoPay Inc. operates no cloud that stores customer memory by default.
- **Personal data:** the SDK is designed around *agents*, not natural persons. If a deploying developer chooses to store natural-persons' PII, that obligation falls on the deployer under GDPR + the AI Act.

## 4. Transparency + user information (Article 50)
- Any agent that uses @mnemopay/sdk to generate content or interact with users must mark its output as AI-generated per Article 50(1). The SDK provides `receiptId` on every operation — downstream developers are instructed (README, docs) to surface this to end users.
- "Forget" is auditable: memory deletion writes a signed entry to the Merkle chain. A third party can reconstruct what was dropped and when.

## 5. Human oversight
Payment authorization above configurable thresholds routes to a human-in-the-loop approval step (v1.0+). Default threshold: $50 equivalent. Deploying developers may lower but not bypass.

## 6. Robustness, accuracy, cybersecurity
- **Benchmark:** 77.2% LongMemEval oracle, 500 questions, Sonnet-4 model, GPT-4o judge. Weakest bucket: multi-session 66.9% (public).
- **Stress:** 1M-op production stress test, zero data corruption, HMAC-SHA256 receipts verified against Merkle root.
- **Adversarial:** 300K adversarial-detection regression fixed in v0.9.3. Canary honeypots seeded in v1.0-beta.1.
- **Cybersecurity:** 800+ tests, cross-repo security sweep 2026-04-16 (6 P1s fixed). Granular npm publish token, no OTP bypass.
- **Circuit breaker + asymmetric AIMD rate limiting** (v0.9.3) to bound failure blast radius.

## 7. Changes and versioning
Semantic versioning. Breaking changes trigger minor-version bump and a migration note in CHANGELOG. Version in production: 1.4.1 (2026-04-21). npm tag `latest`.

## 8. Conformity + standards referenced
- Apache 2.0 license, source-public.
- Alignment with C2PA 2.3 for content provenance (downstream responsibility).
- Agent identity path compatible with W3C DIDs + Verifiable Credentials.
- Payments path compatible with Coinbase x402 + Google Agentic Payments Protocol.

## 9. Known gaps (tracked)
1. No disparate-impact test across agent archetypes for Agent FICO — planned Q3 2026.
2. No formal CE conformity assessment filed (not required for developer SDK at limited-risk classification).
3. Auditor has not been engaged; this file is self-prepared.

## 10. Contact + responsible party
Jerry Omiagbo, J&B Enterprise LLC (d/b/a MnemoPay), Texas USA. jeremiah@getbizsuite.com. https://mnemopay.com.

---

*This document is provided in good faith as voluntary pre-deadline preparation. It is not a substitute for a CE conformity assessment by a notified body, which is not required for this class of product. Deploying developers remain responsible for their own Annex IV files covering their full AI system.*
