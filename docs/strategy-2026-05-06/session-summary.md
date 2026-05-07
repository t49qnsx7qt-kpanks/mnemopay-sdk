# Strategy session 2026-05-06 — what was decided + what was drafted

**Session driver:** Jeremiah asked for deep market research on MnemoPay positioning + a strategic call on Praetor (kill, narrow, or merge).
**Session output:** revised positioning ("portable trust layer for agents that handle money"), Praetor merge plan into MnemoPay, MCP Hive Founding-100 application, and 5 supporting drafts.
**Nothing was pushed, deployed, or made public.** Everything below is in `_drafts/` or `docs/strategy-2026-05-06/`.

## Key research findings (from 3 parallel WebSearch+WebFetch agents)

1. **Stripe Agentic Commerce Suite is a bigger threat than the prior strategic call recognized.** MPP + Link Agent Wallet + Agent Controls subsumes ~80% of MnemoPay's payment surface for Stripe-native builders. → Repositioning around "portable, cross-rail" is the correct response.
2. **MCP Hive launches May 11, 2026.** Founding-100 program ("Project Ignite") is open. Zero platform fees for founding partners. **No payment SDK partner mentioned on their public site** — this is an exact-fit distribution opening for MnemoPay.
3. **EU AI Act compliance buyer doesn't buy SDKs** — buys platforms with policy packs and AIGP-certified humans. SOC 2 Type II is table stakes; we don't have it. The Aug 2 cliff is too short for enterprise procurement (134-day median cycle). → Compliance becomes upsell, not primary positioning. Two front doors: dev SDK self-serve + enterprise compliance "talk-to-us."
4. **Asqav SDK already claims "Article 12 audit bundle" positioning** — MIT, ML-DSA-65 sigs, RFC 3161 timestamps, Articles 12+26+DORA. Audit-only (no payments, no reputation, no memory). MnemoPay's bundle is broader; positioning has to lean on "the bundle" not "the audit."
5. **The portable bundle (payments + memory + Agent FICO + audit) is the moat.** No platform incumbent can copy this without killing their own moat (rail-locked is the moat).

## Decisions made (pending Jeremiah final sign-off)

| Decision | Choice |
|---|---|
| New tagline | "MnemoPay — the portable trust layer for agents that handle money." |
| Praetor disposition | Merge `core` + `payments` + `mcp` source into `mnemopay-sdk/src/governance/`. Rename `mnemopay/praetor` repo → `mnemopay/praetor-toolkit`. Keep `@kpanks/*` packages alive. |
| Compliance positioning | Two front doors: self-serve SDK + enterprise "talk to us" pilot. NOT compliance-first headline. |
| Pricing for compliance pilot | $25K-$60K mid-market, $100K+ enterprise. Not $999/mo. |
| MCP Hive priority | TIME-CRITICAL — apply by end of week 2026-05-10. |
| BizSuite visibility plan | Three Tier-1 plays: dogfood case studies (1/week), plugin marketplace listings, public proof page with real numbers. |

## Files drafted this session

- [`docs/strategy-2026-05-06/mcp-hive-application.md`](./mcp-hive-application.md) — Founding-100 application long-form + email short-form
- [`docs/strategy-2026-05-06/praetor-split-execution-plan.md`](./praetor-split-execution-plan.md) — Phase 0-4 git/npm/Fly operations plan
- `mnemopay-site/_drafts/hero-copy-revision.md` — proposed `index.html` hero changes (HTML diff form)
- `mnemopay-site/_drafts/thesis-post-portable-trust-layer.md` — ~1100-word thesis blog post
- `mnemopay-site/_drafts/compliance-landing.html` — `/compliance` enterprise page (full HTML)
- `bizsuite-site/_drafts/case-study-template.md` — case-study template + first filled example
- `bizsuite-site/_drafts/proof-page.md` — `/proof` real-numbers page

## What needs explicit sign-off before next action

1. **Tagline** — "Portable trust layer for agents that handle money." Approve / edit.
2. **MCP Hive application** — review draft, approve before submission via mcp-hive.com/register and email to info@mcp-hive.com.
3. **Praetor naming** — option A (rename to `praetor-toolkit`, recommended), B (new GitHub org), or C (freeze in place).
4. **Compliance pricing tier** — $25K-$60K mid-market is the research-recommended floor. Approve / change.
5. **BizSuite case-study customer** — confirm whether Greg / Sonova will agree to be quoted, or stick with internal-dogfood case studies until they do.
6. **Sequencing** — proposed: MCP Hive application TODAY → hero + thesis post by May 10 → MCP Hive launch day publish on May 11 → Praetor Phase 1 (governance source extraction) the following week.

## What was explicitly NOT done (per careful-with-destructive-ops + verify-before-act rules)

- No edits to live `mnemopay-site/index.html`.
- No edits to live `mnemopay-sdk/README.md`.
- No commits, pushes, or deploys.
- No social media posts.
- No emails sent.
- No `gh repo rename` or any GitHub destructive op.
- No `npm publish`.
- No edits to `biz-plugins/portal/` or any customer-facing plugin code.

## Memory entries this session would justify (next session can persist if Jeremiah agrees)

- `feedback_strategic_pivot_portable_trust.md` — captures the new tagline + the why
- `project_mnemopay_pivot_2026_05_06.md` — captures the merge decision + the research findings
- `reference_mcp_hive.md` — capture launch date, founding-100 program, application URL/email, fee model
- `reference_asqav_competitor.md` — direct positioning competitor flagged this session
- `reference_stripe_agentic_commerce_suite.md` — biggest existential threat + what they shipped at Sessions 2026
