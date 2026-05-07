# Praetor → MnemoPay merge + repo split — execution plan

**Status:** DRAFT — pending Jeremiah's sign-off on naming option (A/B/C from session synthesis).
**Date:** 2026-05-06.
**Blast radius:** medium — touches two npm namespaces (`@kpanks/*` stays alive, `@mnemopay/sdk` gets new modules), a Fly.io app (praetor-api.fly.dev), one DNS record, the praetor GitHub repo name, and the BizSuite portal product line. Every step is reversible until the GitHub repo rename.

## Decision needed before step 1

Naming for the renamed Praetor monorepo (current home: `github.com/mnemopay/praetor`):

- **Option A** (recommended): rename to `mnemopay/praetor-toolkit`. Keeps `@kpanks/*` npm packages alive and unchanged. Toolkit becomes "open-source agent toolkit by the MnemoPay team" — feeder/credibility play. Greg's `pt_live_*` keys stay valid because portal product line is independent of repo name.
- **Option B**: move to a new GitHub org (`praetor-tools/` or `jb-enterprise/praetor-toolkit`). Decouples brand. More work for less gain.
- **Option C**: freeze in place, no rename. New work goes only into mnemopay-sdk. Existing `@kpanks/*` packages stay published but stop shipping.

Recommendation: **A.** Rest of this plan assumes A. Substitute as needed if B or C is picked.

---

## Phase 0 — Pre-merge verification (no destructive ops, ~30 min)

1. **Inventory which `@kpanks/*` packages are published to npm vs only in monorepo.** Run `npm view @kpanks/<name> version` for all 30 packages. Flag any that are unpublished — those don't need migration logic.
2. **Inventory who depends on `@kpanks/core`, `@kpanks/payments`, `@kpanks/mcp` externally** (the three we're folding). Run `npm view @kpanks/<name> dependents` and `npm-link-checker` if available. Greg's plugins, the BizSuite portal, and praetor-api.fly.dev are the known consumers — verify nothing else.
3. **Snapshot the praetor repo state.** `git -C ~/Projects/praetor branch backup/pre-merge-2026-05-06 && git push origin backup/pre-merge-2026-05-06`. One-line safety net if we need to revert.
4. **Check Greg's KG Financial portal config.** Do his three plugins reference Praetor packages directly, or only via `pt_live_*` portal keys? Per session memory, they're credential overrides only — confirm by greping `biz-plugins/customers/*.creds` for any `@kpanks/*` import path.

## Phase 1 — Source extraction into mnemopay-sdk (~3-4 hours, reversible)

**Goal:** create a `governance` module inside mnemopay-sdk that contains FiscalGate + Article 12 audit bundle primitives. No public API breaking changes.

1. Branch: `git -C ~/Projects/mnemopay-sdk checkout -b feat/governance-module`
2. Create `mnemopay-sdk/src/governance/`:
   - `charter.ts` ← from `praetor/packages/core/src/charter.ts` (charter schema, validation)
   - `mission.ts` ← from `praetor/packages/core/src/mission.ts` (mission lifecycle states)
   - `audit.ts` ← from `praetor/packages/core/src/audit.ts` (Merkle audit chain)
   - `bundle.ts` ← from `praetor/packages/core/src/bundle.ts` (Article 12 export shape)
   - `fiscal-gate.ts` ← derived from `praetor/packages/payments/src/index.ts` (HoldId/Settle/Release wrapper bound to MnemoPay rails)
   - `index.ts` — barrel export
3. **Adapt imports.** Praetor's `@kpanks/payments` calls into `MnemoPay.hold/settle/release`. In mnemopay-sdk, these become direct internal imports of the existing `src/index.ts` exports. No SDK API changes — `governance/` is the new internal layer.
4. **Public exports** (additive, no breaking change):
   ```ts
   // mnemopay-sdk/src/index.ts — append, do not modify existing exports
   export { Charter, validateCharter } from "./governance/charter";
   export { Mission, MissionState } from "./governance/mission";
   export { AuditChain, AuditEvent } from "./governance/audit";
   export { exportArticle12Bundle } from "./governance/bundle";
   export { FiscalGate } from "./governance/fiscal-gate";
   ```
5. **Tests.** Port `praetor/packages/core/tests/*` → `mnemopay-sdk/tests/governance/*`. Run `npm test`. Target: keep total test count > current (672) + governance ports (~80 from praetor/core).
6. **Docs.** New section in `mnemopay-sdk/README.md`: "Governance: FiscalGate + Article 12 audit bundles." Add to the 14-modules table in `mnemopay-site/index.html` as items 15 + 16.
7. **CHANGELOG.** New entry: `1.5.0 — feat: governance module (FiscalGate, Article 12 audit bundle export). Folds in Praetor's compliance primitives. Backward compatible.`
8. **Verify before publishing:** `npm test`, `npm run lint`, then `npm pack --dry-run` and inspect the tarball.
9. **Stop here. Sign-off gate.** Do not publish to npm yet. Show Jeremiah the diff, the test count, the CHANGELOG entry. If approved → `npm publish` as v1.5.0 with the `latest` tag.

## Phase 2 — Praetor repo rename + repositioning (~1-2 hours, reversible up to GitHub rename)

1. **Update praetor README.md** before rename, so the rename target name appears already:
   - New positioning: "Praetor Toolkit — open-source agent runtime tooling by the MnemoPay team."
   - Add an "Inheriting governance" callout: "FiscalGate and Article 12 audit bundles now live in `@mnemopay/sdk`. The toolkit packages here remain Apache-2.0 and continue to ship; for production governance, install MnemoPay."
   - Link to mnemopay-sdk in the first paragraph.
2. **Update `package.json` of root + each `@kpanks/*` package** to reference the new repo URL (after rename, but draft the URL change now).
3. **GitHub rename:** `gh repo rename praetor-toolkit --repo mnemopay/praetor`. **REVERSIBLE only via another rename** — GitHub auto-redirects old URLs for ~30 days but consumers should update.
4. **Update Fly.io app:** `praetor-api.fly.dev` keeps running for now. Consider renaming to `praetor-toolkit-api.fly.dev` or sunsetting, but only after Greg's portal product line is verified independent.
5. **DNS check:** `praetor.mnemopay.com` already points at Vercel per earlier audit-session DNS fix — leave alone, it's correct for the toolkit landing page.

## Phase 3 — BizSuite portal product line decision (~1 hour, no urgent destructive ops)

1. **The Praetor product line in `biz-plugins/portal/`** uses `pt_live_*` keys. Two options:
   - **Keep it as "Praetor (toolkit-tier)"** — sells access to the OSS toolkit's hosted runtime. Cheaper tier than MnemoPay Pro. Different ICP (devs experimenting).
   - **Sunset it.** Refund any `pt_live_*` annual subscribers and migrate to `mp_live_*` MnemoPay keys with the governance module bundled.
2. Recommend: **keep it for 90 days post-merge, then evaluate.** If the toolkit gets >10 active `pt_live_*` users in 90 days, keep. If not, sunset.

## Phase 4 — Communications (~2 hours, public surfaces — explicit user permission required)

1. Blog post (mnemopay-site): "We folded Praetor's governance into MnemoPay" — explains the merge, what stays in the toolkit, what's now first-class in the SDK.
2. X thread: 3-5 tweet thread (drafted, NOT auto-posted).
3. Notify Greg directly (KG Financial): one-line email confirming his portal access is unchanged.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `@mnemopay/sdk` v1.5.0 has a regression in core SDK paths from refactoring imports | Phase 1 keeps existing `src/*` files untouched — governance is purely additive. Pre-publish test run is mandatory gate. |
| Greg's portal access breaks because of repo rename | Portal keys are independent of repo name (verified). Notification email is courtesy, not technical mitigation. |
| `@kpanks/*` consumers see broken README links during rename window | GitHub auto-redirects old URLs for ~30 days. Update package.json `repository` fields in the same PR as rename. |
| FiscalGate + audit bundle code in praetor still has the haiku-goal silent failure bug from session 2026-05-06 audit | Bug lives in Praetor's CLI agent loop (`packages/cli/src/index.ts`), not in `@kpanks/core/payments/mcp`. Source extraction skips the CLI entirely. Bug stays in praetor-toolkit, doesn't poison MnemoPay. |
| User does Phase 1, then changes mind — needs revert | `feat/governance-module` branch lives in mnemopay-sdk. Revert = delete branch. Pre-publish test gate means nothing went to npm. |

## What I will not do without explicit go-ahead per phase

- Phase 1: I will not `npm publish`. I will write code + run tests + show diff.
- Phase 2: I will not `gh repo rename` or push to praetor `main`. I will draft README + commit on a branch.
- Phase 3: I will not change anything in `biz-plugins/portal/` without Jeremiah's call.
- Phase 4: I will not auto-post to X or send the Greg email. I will draft both, leave for review.

## Estimated total time: 8-10 hours of execution (across 2-3 sessions)

Sequence:
- **Session A (today/tomorrow):** Phase 0 + Phase 1 up to and including pre-publish test run. Stop. Sign-off.
- **Session B:** Publish v1.5.0 → Phase 2 README update + branch → sign-off → rename.
- **Session C:** Phase 3 + Phase 4 drafts → sign-off → send.
