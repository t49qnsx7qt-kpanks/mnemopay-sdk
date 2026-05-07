# mnemopay-sdk status — 2026-05-06

## Shipped today
- **Praetor consolidation Phases 1, 2, 5, 7, 8 — COMPLETE.** Phase 6 staged (deploy needed). Phases 3, 4 held on senior/user decisions.
- **`@mnemopay/sdk@1.5.0` PUBLISHED** — governance fold (Charter, FiscalGate, runMission, Article 12, MerkleAudit). Git tag `v1.5.0`, commit `c20267b`, merged to master (`950fc9a`), pushed.
- **`@mnemopay/toolkit@0.1.0` PUBLISHED** — meta-package depending on 14 `@kpanks/*` packages. New repo scaffold at `~/Projects/mnemopay-toolkit/`.
- **mnemopay.com index.html updated** — Praetor section killed, replaced with Toolkit section (14 packages grid, install.sh code, npm-install CTA). Footer trademark dropped Praetor. Schema.org + ai:description + section spine + top nav + footer column all migrated.
- **mnemopay.com/toolkit** — new full-polish landing page (toolkit.html). Curtain, particles, Lenis, mask-hero, tilt cards. Hero: "Capabilities for agents that handle money."
- **mnemopay.com/compliance** — already shipped earlier today.
- **vercel.json** — added redirects: `praetor.mnemopay.com/*` → `mnemopay.com/governance` (host-based 301), `/praetor`+`/praetor.html` → `/toolkit`, plus clean-URL rules for compliance.html and toolkit.html.
- **sitemap.xml** — added `/toolkit` and `/compliance` entries.
  - `src/governance/{audit,charter,runtime,article12,payments,index}.ts` — 6 files folded from `praetor/packages/{core,payments}`
  - `tests/governance.spec.ts` — 11 tests, all passing
  - `src/index.ts` — additive exports appended (no breaking changes)
  - Full suite: 886/887 (1 pre-existing flake in `recall-edge.test.ts` timeout, unrelated)
- **mnemopay.com narrative pivot** to "portable trust layer for agents that handle money" (live in `index.html`, not yet redeployed)
  - Hero `data-mask-hero` text + meta tags + chip + right-column tagline
  - New `#portable` section between Manifesto and Stack with Today/Roadmap chip rows (honesty per senior review)
  - Section spine + nav + footer updated
- **`mnemopay-site/compliance.html`** — new full-polish enterprise compliance page with Article 12 audit-bundle JSON example, regulations mapping, pilot pricing
- **Strategic pivot research + handoff doc** — `docs/strategy-2026-05-06/{mcp-hive-application,praetor-split-execution-plan,session-summary}.md`
- **MCP Hive Founding-100 application** sent to `info@mcp-hive.com` (Resend, status 200, Maileroo schema bug discovered & fixed)
- **Maileroo schema bug fixed** in `marketing/send-strategic-2026-05-06.js` — `to: [{address: x}]`. Existing send-eu-ai-act.js + send-day4-followups.js verified already correct.

## In progress
- mnemopay.com production redeploy — local edits ready (Phase 6 redirects + Phase 7 toolkit.html + Phase 8 brand kill on index.html + sitemap update), gated on Vercel deploy

## Blocked
- **Phase 3 (BizSuite content packages):** senior decision needed on integration shape — plugins under `biz-plugins/plugin-*` vs new `@bizsuite/*` npm scope
- **Phase 4 (personal-project handoff):** Jeremiah's call needed on name + npm scope for `3d`/`world-gen`/`game`/`game-assets`
- **mnemopay.com Vercel deploy:** local files staged, awaiting `vercel --prod` or git push trigger
- E2E haiku-goal silent failure in praetor master (separate session)

## Next session
- Senior reviews `feedback_senior_review_2026_05_06.md` + `project_mnemopay_platform_2026_05_06.md` from shared memory; answers the 5 open questions (toolkit shape, BizSuite integration shape, personal-project name, sequencing, @kpanks/* deprecation tone)
- Once cleared: npm publish `@mnemopay/sdk@1.5.0`
- Phase 2 toolkit rename: 14 packages republish under `@mnemopay/*`, create `@mnemopay/toolkit` meta
- Production redeploy of mnemopay.com (hero pivot + compliance.html + portable section)
- Update mnemopay.com `#praetor` section to remove Praetor brand entirely (currently still says "Mission runtime · $99/mo")
- Recall-edge test timeout — re-run on fresh machine to confirm flaky vs real
