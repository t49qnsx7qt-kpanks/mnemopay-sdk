# MnemoPay — EU AI Act Pitch (targeted)

Use this when cold-emailing or presenting to EU AI companies preparing for the **August 2 2026** GPAI obligations deadline. Tone = calm and technical. Do NOT sell urgency — they already feel it. Sell competence.

---

## 6-slide structure

### Slide 1 — Title

**Article 13 + Article 53 + Annex III — one SDK.**

MnemoPay · Compliance primitives for AI agents, ready before August 2 2026.

---

### Slide 2 — What the Act actually requires (plain English)

1. **Article 13 — Transparency.** High-risk AI systems must maintain an immutable log of inputs and decisions, with sufficient detail for post-hoc audit.
2. **Article 53 — GPAI providers.** Must disclose training-data summary, demonstrate copyright compliance, and keep agents traceable to a legal entity.
3. **Annex III — High-risk systems.** Anything that touches credit, hiring, education, critical infrastructure, or law enforcement must have an active risk management system and human oversight.

Every agent your team ships that moves money, makes a recommendation, or interacts with EU residents falls under at least one of these.

---

### Slide 3 — How MnemoPay maps to each

| Act requirement | MnemoPay primitive | How it satisfies |
|---|---|---|
| Article 13 audit log | `IntegrityService` (Merkle-chained memory) | Every recall/charge/decision hashed into a chain; tampering detectable in O(log n) |
| Article 53 traceability | `IdentityRegistry` + `CapabilityTokens` | Every agent is tied to a legal entity + scoped capability; exportable to regulators on demand |
| Annex III risk mgmt | `AnomalyMonitor` + `AgentCreditScore` + HITL gate | EWMA anomaly + canary hits + fraud delta; low scores require human approval |

Not a compliance consultancy — it's a library you `npm install`.

---

### Slide 4 — Integration demo

Six lines. No core rewrite.

```ts
import { MnemoPay, IntegrityService, IdentityRegistry } from "@mnemopay/sdk";

const registry = new IdentityRegistry({ entity: "Your GmbH, 12345 Berlin" });
const agent = MnemoPay.quick("agent-42", {
  persist: { type: "neon", url: process.env.NEON_URL }, // Article 13 log
  identity: await registry.register("agent-42"),        // Article 53 traceability
  integrity: new IntegrityService(),                    // Merkle chain
});
// Every agent.remember / agent.charge / agent.settle now audit-logged.
```

---

### Slide 5 — Validation evidence

- **672 tests** covering memory integrity, fraud detection, credit scoring, rate limiting, circuit breakers, drift detection.
- **Merkle integrity spec** — SHA-256 chained, tamper-evident, O(log n) proof generation. Test coverage on tamper, fork, and replay attacks.
- **EWMA anomaly spec** — exponentially weighted moving average on behavioral drift, calibrated on synthetic attack traces.
- **Independent legal review** — IP, trademark, and license posture reviewed Apr 9 2026, P0/P1 issues closed.
- **Open source** — auditable under Apache 2.0. Your compliance team can read every line.

---

### Slide 6 — Next step

15-minute technical call with Jerry (founder) and your head of compliance.

- **Book:** cal.com/jeremiah-bizsuite/15min
- **Email:** jeremiah@getbizsuite.com
- **GitHub:** github.com/mnemopay/mnemopay-sdk

---

## Cold email template (top 6 send-ready prospects)

Send from `jeremiah@getbizsuite.com`. Subject personalizes by role.

**Subject:** Article 13 audit logs + Article 53 traceability — one npm install

> Hi [Name],
>
> [One sentence showing you know their product — e.g. "Saw Saidot's work on AI registries — pragmatic stuff."]
>
> Short version: we ship an open-source SDK ([@mnemopay/sdk](https://www.npmjs.com/package/@mnemopay/sdk)) that covers Article 13 audit logs, Article 53 traceability, and Annex III risk management for AI agents — all in one install. Merkle-chained memory, identity registry tied to a legal entity, behavioral anomaly detection with credit scoring.
>
> 672 tests, Apache 2.0, independently legal-reviewed. Integration is 6 lines.
>
> If you've got Aug 2 on your roadmap and don't love the idea of stitching three vendors together, worth 15 minutes? cal.com/jeremiah-bizsuite/15min.
>
> Either way — good luck with the work.
>
> Jerry
> Founder, MnemoPay (J&B Enterprise LLC)
> jeremiah@getbizsuite.com

**Personalization hooks (per prospect — adapt the opener):**
- Mistral → "Saw the Magistral release — open-weights stance matters here, since GPAI Art. 53 disclosure obligations land hardest on open providers."
- Aleph Alpha → "Watching Luminous land in EU public-sector — Article 53 training-data disclosure is going to be the sharpest edge for you."
- Wayve → "AV2.0 means every driving decision is Annex III high-risk. Audit-log surface is going to matter."
- Einride → "Autonomous freight + EU hauls = Annex III across the whole fleet. Immutable telemetry is the unlock."
- Oxa → "Driver agnostic across fleets means you need per-fleet traceability. That's Article 53."
- Pleias → "Open-weights + EU-native is a perfect profile — and also the profile the Act is most specific about."

**Verified send-ready:** hello@saidot.ai · sales@saidot.ai · hello@trail-ml.com · info@dataguard.de · contact@pleias.fr · data.protection@flixbus.com · legal@mistral.ai

**Tracking:** log each send into `marketing/email-followup.js` SENT_EMAILS array with `type: "eu-ai-act"` so the drip catches them automatically.
