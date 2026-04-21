# MnemoPay — One-Pager

*(Paste the design brief from `claude-design-prompts.md` § 2 into Claude Design for the visual PDF. This file is the copy source-of-truth.)*

---

## Header

**MnemoPay** — Agent banking infrastructure. One SDK.
*Seed round · 2026*

---

## Hero metrics

| 672 | v1.0.0-beta.1 | 1.0% |
|---|---|---|
| tests passing | shipped on npm today | fee at credit score 800+ |

---

## What it does

MnemoPay is the only SDK that gives an AI agent **memory, payments, identity, and a credit score** in one `npm install`.

- **Memory** — Merkle-hashed, recallable, auditable (built for EU AI Act Article 13).
- **Payments** — Stripe + Paystack + Lightning rails, charge → settle two-phase.
- **Identity** — IdentityRegistry + KYA + CapabilityTokens (Article 53 ready).
- **Agent Credit Score** — 300–850, 5 components, tiered fees reward good agents.

```ts
import { MnemoPay } from "@mnemopay/sdk";
const agent = MnemoPay.quick("agent-42");
await agent.charge({ amount: 1299 }); await agent.settle();
```

---

## Why now

- **$2.66B** invested in agent payments in 2026 — none ship the full stack.
- **$10.91B** agent economy in 2026, doubling annually.
- **August 2 2026** — EU AI Act GPAI obligations go live. Every EU agent company needs Article 13 audit logs and Article 53 traceability before that date.

---

## Why us

- **Only full-stack competitor** — Mem0 has memory, Kite has payments, nobody has both plus identity plus a score.
- **Behavioral finance moat** — FICO re-weighted for machine behavior, training on every transaction through the SDK.
- **Ship velocity** — solo founder, 18 repos, 672 tests, 3 SDKs published in 90 days.

---

## Traction

- `v1.0.0-beta.1` on npm · `v1.0.0b1` on PyPI (Python SDK)
- Listed on Smithery, ClawHub, mcpservers.org
- 1.4K weekly npm downloads (pre-launch baseline)
- Stripe live: $49/mo Pro, $299/mo Enterprise, plus 1.0%–2.5% usage fees
- Neon Postgres persistence shipped today
- 59 B2B emails sent with follow-up drip automated
- Sister SDK GridStamp (221 tests, 96.56% fleet-sim success) for drone/robot rail

---

## Ask

Raising **$[TBD]** at **$[TBD] post-money**.

40% engineering · 30% GTM · 20% infrastructure · 10% runway

---

## Contact

**Jerry Omiagbo** · Founder · J&B Enterprise LLC (Texas)
jeremiah@getbizsuite.com · cal.com/jeremiah-bizsuite · github.com/mnemopay/mnemopay-sdk
