# mnemopay-sdk status — 2026-05-06

## Shipped today
- **`@mnemopay/sdk` v1.5.0 PUBLISHED to npm** — verified live via `npm view @mnemopay/sdk version` → `1.5.0`. Git tag `v1.5.0` pushed to `origin` (commit `c20267b`).
- **Praetor governance fold (Phase 1) — COMPLETE** — branch `feat/governance-module` merged into release pipeline
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
- mnemopay.com production redeploy — local edits ready (hero pivot + portable section + compliance.html), gated on user/senior sign-off
- Merge `feat/governance-module` → `master` — branch shipped, master still on `d4e6b04`

## Blocked
- Phase 2+ of Praetor consolidation (toolkit republish, BizSuite source moves, personal-project handoff, praetor.mnemopay.com sunset, mnemopay.com Praetor section update) — gated on senior sign-off per `project_mnemopay_platform_2026_05_06.md`
- E2E haiku-goal silent failure in praetor master (separate session) — needs CLI-source-level investigation, not blocking the fold

## Next session
- Senior reviews `feedback_senior_review_2026_05_06.md` + `project_mnemopay_platform_2026_05_06.md` from shared memory; answers the 5 open questions (toolkit shape, BizSuite integration shape, personal-project name, sequencing, @kpanks/* deprecation tone)
- Once cleared: npm publish `@mnemopay/sdk@1.5.0`
- Phase 2 toolkit rename: 14 packages republish under `@mnemopay/*`, create `@mnemopay/toolkit` meta
- Production redeploy of mnemopay.com (hero pivot + compliance.html + portable section)
- Update mnemopay.com `#praetor` section to remove Praetor brand entirely (currently still says "Mission runtime · $99/mo")
- Recall-edge test timeout — re-run on fresh machine to confirm flaky vs real
