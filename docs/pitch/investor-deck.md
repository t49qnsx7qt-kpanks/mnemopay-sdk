# MnemoPay — Seed Round Deck (2026)

Use this as (a) the source-of-truth script when talking through the deck, and (b) the content to paste into Claude Design (see `claude-design-prompts.md` for the design brief).

---

## Slide 1 — Title

**Agent banking infrastructure. One SDK.**

MnemoPay · Seed round · 2026

Contact: jeremiah@getbizsuite.com · cal.com/jeremiah-bizsuite

---

## Slide 2 — Why Now

**$2.66B was invested in "agent payments" in 2026.**

Across Mem0, Kite, Bank of Bots, AGT.finance, and others. None of them ship memory, payments, identity, and a credit score in a single SDK. The category is unclaimed.

AI agents are writing code, booking travel, and moving capital right now. They still can't remember who they served yesterday, can't settle a dispute, can't carry a reputation across services.

---

## Slide 3 — The Problem

Today, building a production AI agent means stitching four vendors together:

| Agent needs to... | Today's stack |
|---|---|
| Remember the customer | A vector DB (Pinecone / Weaviate / Mem0) |
| Get paid | Stripe — which requires a human-owned account |
| Prove who it is | A bespoke identity + KYC layer |
| Be trusted | Nothing. There is no agent credit bureau. |

Every agent founder rebuilds the same stack and every stack has gaps.

---

## Slide 4 — The Insight

**Memory + payments + identity all answer one question: "Should this agent transact?"**

If you ship them separately you have four APIs and no answer. If you ship them together — plus a credit score that learns from the data flowing through them — you have a single trust primitive.

That's MnemoPay.

---

## Slide 5 — Product

One npm install, three lines:

```ts
import { MnemoPay } from "@mnemopay/sdk";

const agent = MnemoPay.quick("agent-42");
await agent.charge({ amount: 1299, description: "coffee" });
await agent.settle();
// Credit score updates automatically. Fraud monitor runs automatically.
// Memory of this transaction is Merkle-hashed automatically.
```

- `v1.0.0-beta.1` on npm (`@mnemopay/sdk`)
- `v1.0.0b1` on PyPI (`mnemopay`)
- 24-tool MCP server listed on Smithery, ClawHub, mcpservers.org

---

## Slide 6 — Agent Credit Score (the moat)

A 300–850 score for AI agents, modeled on FICO but re-weighted for machine behavior:

- **Payment history — 35%** (settled charges, disputes)
- **Utilization — 20%** (spend vs approved mandate)
- **Age — 15%** (agent tenure, memory chain length)
- **Diversity — 15%** (vendors, rails, categories)
- **Fraud signals — 15%** (EWMA anomaly, canary hits, geo drift)

Tier-based fees (1.0% at 800+, 2.5% at <580 with HITL approval) means good agents pay less. No competitor has shipped this. Every agent on MnemoPay generates training data that sharpens the score.

---

## Slide 7 — Traction

- **Code:** 672 tests passing, v1.0.0-beta.1, v1.0.0b1 Python, 18 integrations shipped in 90 days
- **Distribution:** listed on three MCP directories, Dev.to tutorial live, open-source GitHub
- **Downloads:** 1.4K weekly on npm (baseline pre-launch)
- **Revenue:** Stripe live for $49 Pro and $299 Enterprise tiers + usage-based fees
- **Infrastructure:** Neon Postgres adapter shipped, Paystack + Stripe + Lightning rails live
- **Pipeline:** 59 B2B emails sent + follow-ups, 6 EU AI Act prospects send-ready, Pika / Agno / Matternet portfolio overlap identified

---

## Slide 8 — Market

The agent economy is **$10.91B** in 2026 and doubling annually. Funded competitors:

| Company | Raised | What they ship | Gap |
|---|---|---|---|
| Mem0 | $24M | Memory | No payments, no identity, no score |
| Kite | $33M | Payments | No memory, no score |
| AGT.finance | early | Finance agents | Closed-source, no SDK |
| Bank of Bots | early | "BOB Score" (our closest analogue) | Thin memory, no open SDK |
| Inforge / Methux | research | Trust scoring (Bayesian / Weibull) | Academic, no product |

**No one ships all four. Agent FICO is unclaimed.** We have the benchmarks (LongMemEval 62-64%, 30K stress-test, 96.56% fleet sim success on sister product GridStamp) and the tests (672) to defend the technical claim.

---

## Slide 9 — Business Model

- **Usage-based:** 1.0%–2.5% of agent transaction volume (tiered by credit score)
- **Subscription:** $49/mo Pro, $299/mo Enterprise (live on Stripe)
- **B2B outreach:** $997 AI Audit wedge (getbizsuite.com/ai-audit.html) as top-of-funnel

Unit economics:
- Zero marginal cost per additional agent — SDK runs in customer infra, we charge on rails.
- Every transaction generates AgentCreditScore training data: data moat compounds.
- No hosted-infra dependency: ship yourself or let us host. Both paths are live.

---

## Slide 10 — Go-to-Market (3 wedges)

**Wedge 1 — EU AI Act compliance.** August 2 2026 deadline for GPAI obligations (Articles 13, 53, Annex III). MnemoPay's Merkle integrity + IdentityRegistry + behavioral monitor map directly. 6 prospects email-ready (Saidot, trail-ml, DataGuard, Pleias, FlixBus, Mistral), 25+ more LinkedIn-targeted.

**Wedge 2 — Drone delivery proof-of-presence.** Sister SDK GridStamp (221 tests, 96.56% success in fleet sim, 91% spoof detection). Target: AUVSI proposal drafted, FAA BEYOND partners, Matternet portfolio. Cryptographic proof-of-delivery → RaaS billing.

**Wedge 3 — MCP server monetization.** Every MCP server author we've emailed (Ref, MySQL, Atlassian, Playwright, Twitter, ArXiv, Google Workspace) has the same problem: no sub-cent billing primitive. MnemoPay drops in with one line.

---

## Slide 11 — Team

**Jerry Omiagbo** — Founder, full-stack engineer. Dallas, TX.

- Solo-shipped 18 repos and 672 tests in 90 days
- Published SDKs: `@mnemopay/sdk`, `mnemopay` (PyPI), `gridstamp`
- Operating entity: J&B Enterprise LLC (Texas)
- Prior: multi-product operator (DELE ride-hailing, BizSuite plugins, WeMeetWeMet dating app)

Hiring plan (post-seed): 1 staff engineer (rails + infra), 1 GTM lead (EU AI Act beachhead).

---

## Slide 12 — Ask

**Raising $[TBD] at $[TBD] post.**

Use of funds:
- 40% engineering (2 hires, Agent Credit Score v2)
- 30% GTM (EU AI Act beachhead, enterprise SE)
- 20% infrastructure (Neon + Stripe reliability)
- 10% runway buffer

Next step: 30-min technical call. cal.com/jeremiah-bizsuite · jeremiah@getbizsuite.com

---

## Speaker notes (private)

- If asked "why hasn't Stripe done this?" — answer: Stripe requires human-owned accounts; agent identity is a classification problem they don't want to own.
- If asked "why hasn't Mem0 done this?" — answer: they raised to scale memory distribution; adding payments would fork their roadmap and expose them to money-transmitter regulation.
- If asked "regulation risk?" — we're Platform-as-a-Service, not the rails. Stripe and Paystack carry the MT licenses. We carry the data + scoring layer, which is unregulated.
- If asked "moat" — data flywheel + full-stack bundling + behavioral finance know-how. Reproducing us means shipping 4 products and tuning a score on live data we already have.
- If asked "concentration risk" — top customer is [TBD]. If pre-revenue, say so plainly and redirect to pipeline depth.
