# Claude Design — Paste-Ready Prompts for MnemoPay

Claude Design (Opus 4.7, Anthropic Labs) turns prompts into prototypes, slides, and one-pagers. Paste any block below verbatim. Each block is a complete brief — tone, content, visual direction, constraints.

Jerry's workflow:
1. Open Claude Design in Anthropic Labs.
2. Paste one block below.
3. Iterate: "make slide 3 more quantitative", "swap to a dark theme with violet accents", "redo the hero in the style of Linear's homepage".
4. Export: PNG for social, PDF for investor sends.

---

## 1. Investor Deck (12 slides, seed round)

```
Design a 12-slide seed-round investor deck for MnemoPay. MnemoPay is the memory + payments + identity + credit-score SDK for AI agents. One npm install, full agent trust stack.

Tone: confident, data-forward, slightly irreverent. Think Linear meets Stripe early-days. No stock photos, no generic AI imagery. Use typographic slides with one strong number or chart per slide.

Color system: off-black background (#0B0D0F), white text, a single accent color (choose between electric violet #7C3AED or acid green #A3E635, pick one and commit). Use Inter or IBM Plex Mono. Numbers should be display-size (120pt+).

Slides:

1. Title — "Agent banking infrastructure. One SDK." MnemoPay logo, tagline, "Seed round — 2026". Nothing else.
2. Why now — AI agents moved $2.66B of venture capital into "agent payments" in 2026. They still can't remember customers, settle disputes, or hold a credit score. Source the $2.66B number.
3. The problem — 3-column: agents can't remember (vector DBs don't do identity), can't get paid (Stripe needs human accounts), can't be trusted (no reputation primitive).
4. The insight — memory + payments + identity converge into one question: "should this agent transact?" Everyone is building one leg of the stool. We ship all four in one npm install.
5. Product — annotated code screenshot. `import { MnemoPay } from "@mnemopay/sdk"` → charge → settle → FICO. Highlight the 3-line integration.
6. Agent Credit Score — 300-850 range, 5 components (payment history 35%, utilization 20%, age 15%, diversity 15%, fraud 15%). The behavioral finance moat. Show a sample scorecard.
7. Traction — specific numbers: 672+ tests passing, v1.0.0-beta.1 on npm, Python SDK on PyPI, listed on Smithery + ClawHub + mcpservers.org, 1.4K weekly npm downloads, N paying customers, $MRR.
8. Market — $10.91B agent economy 2026. Mem0 ($24M raised, 88K weekly downloads), AGT.finance, Kite ($33M), Bank of Bots — none has the full stack. Agent FICO category is unclaimed.
9. Business model — usage-based: 1.0%-2.5% transaction fee (tier by score), $49/mo Pro, $299/mo Enterprise. Live on Stripe.
10. Go-to-market — 3 wedges: EU AI Act compliance (Aug 2 2026 deadline), drone delivery proof-of-presence (GridStamp sister product), MCP server monetization (sub-cent billing per tool call).
11. Team — Jerry Omiagbo, founder, full-stack, Dallas TX. J&B Enterprise LLC. Solo-shipped 18 repos, 672 tests, multiple published SDKs in 90 days.
12. Ask — $X at $Ym post. Use of funds: 40% eng (2 hires), 30% GTM, 20% infra, 10% runway buffer. Close with email + Cal link.

Constraints:
- No bullet point should be longer than 6 words.
- No slide should have more than 3 bullet points.
- Every number must be sourced in a footnote (tiny gray text, bottom-right).
- Export as 16:9 PDF.
```

---

## 2. One-Pager (single page, investor send)

```
Design a single-page PDF one-pager for MnemoPay that can be sent cold to a VC. A/A4 format, portrait.

Layout:
- Top 15%: logo left, tagline right ("Agent banking infrastructure. One SDK."), plus a tiny "Seed round — 2026" badge.
- 40% hero: three stacked metric blocks — "672 tests passing" / "v1.0.0-beta.1 shipped on npm" / "1.0% fee at score 800+". Numbers at 96pt, label at 11pt all-caps gray.
- 30% body: three columns — "What it does" (memory + payments + identity + credit score), "Why now" ($2.66B invested in agent payments 2026, Aug 2 EU AI Act deadline), "Why us" (only full-stack competitor, behavioral finance moat, 90-day build velocity).
- 15% footer: 3-line "Ask" block ($X at $Ym), then contact line (jeremiah@getbizsuite.com, Cal.com link, GitHub link).

Visual: off-black background, electric violet accent, Inter font. Include a minimalist sparkline chart showing npm weekly downloads trend if you can fake it tastefully.

Constraints:
- Must remain readable at A4 size (no microcopy smaller than 9pt).
- No filler — every pixel earns its place.
- Exportable as print-ready PDF.
```

---

## 3. EU AI Act Pitch (targeted variant)

```
Design a 6-slide pitch deck specifically for EU AI companies preparing for the August 2 2026 EU AI Act GPAI obligations deadline. This is a compliance-motivated ICP, not a general investor pitch.

Target audience: CTO / Head of Engineering / Compliance Lead at Mistral, Aleph Alpha, Wayve, Einride, Oxa, Pleias, Saidot, trail-ml, DataGuard, FlixBus, Unitary, Fraugster, Feedzai, Adarga, Quantexa, Corti, Pavocoin.

Tone: calm, technical, deadline-aware. Do NOT try to sell urgency — they already know. Sell competence.

Slides:

1. "Article 13 + Article 53 + Annex III — one SDK." MnemoPay logo. Subtitle: "Compliance primitives for AI agents, ready before August 2."
2. What the Act requires (plain English): (a) high-risk AI systems must keep an audit log of inputs/decisions, (b) GPAI providers must disclose training data summary + copyright compliance, (c) all deployed agents must be traceable to a legal entity. Link to EUR-Lex reference.
3. What MnemoPay ships that maps to each: Merkle-chained memory integrity (Article 13 audit logs), IdentityRegistry + KYA (Article 53 traceability), AgentCreditScore + behavioral monitor (Annex III high-risk risk management).
4. Integration demo — actual code, 6 lines. Show how an existing agent gets Act-ready without rewriting the core.
5. Validation evidence — 672 tests, Merkle integrity spec, EWMA anomaly spec, independent legal review note (cite your Apr 9 legal pass if relevant).
6. Next step — "15-minute technical call with Jerry, your CTO, and one of our compliance engineers. Cal.com/jeremiah-bizsuite/15min". Email: jeremiah@getbizsuite.com.

Visual: clean white background (compliance context = trust = light theme). Accent: navy #0B2948. Serif headings (think New York Times Magazine), sans body. No emojis, no gradients.

Export: 16:9 PDF, under 2 MB so it passes corporate email filters.
```

---

## 4. Homepage Hero Redesign (getbizsuite.com/mnemopay)

```
Redesign the hero section for getbizsuite.com (MnemoPay landing page). This is a developer-facing site — the conversion event is "npm install @mnemopay/sdk", not "book a demo".

Above the fold only. Design for 1440x900 desktop first, then phone. Must render in under 1s on 4G.

Content (use verbatim):
- Eyebrow: "Agent banking infrastructure"
- Headline: "Your agents can handle money. Now they can remember customers, settle disputes, and build a credit score."
- Sub: "One npm install. Memory + payments + identity + Agent Credit Score."
- Primary CTA: `npm install @mnemopay/sdk` (copy-to-clipboard chip, monospace)
- Secondary CTA: "Read the 5-minute tutorial" (links to dev.to article)
- Trust row, tiny: "v1.0.0-beta.1 • 672 tests • listed on Smithery + mcpservers.org"

Visual direction: brutalist-minimal (Linear + Vercel crossed with early Stripe). Off-black background. One-color accent (electric violet). Large monospace numerals. A subtle animated terminal typing the npm install command on load.

Do NOT include:
- A hero illustration of a robot.
- Generic "AI" network graph.
- Testimonial carousel.
- A sign-up form above the fold.

Export: Figma-ready frames for desktop and mobile, plus a short Framer-motion stub for the terminal animation.
```

---

## 5. Social Launch Card Set (Twitter + LinkedIn)

```
Design 6 social cards announcing "MnemoPay v1.0.0-beta.1 — the first agent banking SDK." Square (1080x1080) for LinkedIn, plus 16:9 variants for Twitter.

Card series:

1. "The agent stack is broken" — three crossed-out logos: vector DB (memory only), Stripe (no agent identity), any KYC service (no memory). Caption: "No one has ever put these three in one SDK."
2. "Until now." — clean MnemoPay logo on off-black. Single line: "Memory. Payments. Identity. In 3 lines of code."
3. Code snippet card — actual screenshot of 3-line integration. Syntax-highlighted. Caption: "This is the whole SDK. v1.0.0-beta.1 on npm today."
4. "Agent Credit Score" — a 300-850 gauge visual, needle at 780. Caption: "First credit score for AI agents. 5 components, behavioral finance moat."
5. "672 tests. 0 shortcuts." — big number. Underneath: fraud detection, Merkle integrity, EWMA anomaly, AIMD rate limiting, circuit breaker. Caption: "Built for production from day one."
6. "Install line" — just `npm install @mnemopay/sdk` in enormous monospace. Caption: "Ship agent banking this weekend. Full tutorial in comments."

Visual system: same as hero — off-black, violet accent, monospace for code, Inter for copy. Every card must be legible at thumbnail size (128px).

Export: 6 PNGs at 2x retina, plus a single combined PDF for easy upload.
```

---

## How to iterate inside Claude Design

After pasting, use these follow-up prompts verbatim:

- "Make the numbers larger and the body copy smaller — I want a 5:1 hierarchy."
- "Swap the accent to acid green and remove the footer noise."
- "Export a 9:16 phone variant of slide 3."
- "Regenerate with a Tufte-style minimalist chart instead of the bar chart."
- "Redo the whole deck in a serif-dominant style, like a New Yorker feature."
- "Give me a Figma-ready version with layers named for engineering handoff."

If Claude Design misses specific brand details (color hex, logo file, font license), paste them in as a new message and say "use these from now on."
