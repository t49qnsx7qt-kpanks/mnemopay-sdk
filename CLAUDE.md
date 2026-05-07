# MnemoPay SDK

AI agent trust & reputation SDK — memory + payments + identity + Agent Credit Score in one package.

## Quick Start

```bash
npm install        # install deps
npm run build      # compile TypeScript
npm test           # run 672+ vitest tests
npm run lint       # type-check without emit
```

## Architecture

14 modules in `src/`:

| Module | Purpose |
|--------|---------|
| `index.ts` | Main SDK: MnemoPay, MnemoPayLite, MnemoPayNetwork (~74KB) |
| `fico.ts` | Agent Credit Score (300-850); exports `AgentCreditScore`, legacy `AgentFICO` alias kept |
| `behavioral.ts` | Behavioral finance (prospect theory, cooling-off) |
| `integrity.ts` | Merkle tree memory integrity (SHA-256) |
| `anomaly.ts` | EWMA anomaly detection, BehaviorMonitor, CanarySystem |
| `adaptive.ts` | Adaptive AIMD, anti-gaming, circuit breaker, PSI drift |
| `commerce.ts` | CommerceEngine (autonomous shopping with mandates) |
| `fraud.ts` | Geo-enhanced fraud detection |
| `identity.ts` | IdentityRegistry, KYA, CapabilityTokens |
| `ledger.ts` | Double-entry ledger |
| `network.ts` | Multi-agent commerce network |
| `client.ts` | REST client |
| `mcp/server.ts` | MCP server (24 tools, 2 prompts) |
| `rails/` | Payment rails: Stripe, Paystack, Lightning |

## Two Modes

```typescript
// Dev (zero infra)
const agent = MnemoPay.quick("agent-1");

// Production (full config)
const agent = await MnemoPay.create({ agentId: "agent-1", storage: sqliteAdapter, rail: stripeRail });
```

## Key Flows

- **Payments:** charge() → settle() or refund() (two-phase)
- **Agent Credit Score:** 5 components weighted: payment 35%, utilization 20%, age 15%, diversity 15%, fraud 15%
- **Fee tiers:** 1.0% (score 800+) → 2.5% (score <580, requires HITL)

## MCP Server

24 tools: remember, recall, forget, reinforce, consolidate, charge, settle, refund, balance, profile, logs, history, reputation, dispute, fraud_stats, shop_set_mandate, shop_search, shop_buy, shop_confirm_delivery, shop_orders, agent_fico_score, behavioral_analysis, memory_integrity_check, anomaly_check
2 prompts: recall-and-decide, agent-status-report
Entry: `src/mcp/server.ts` | Binary: `mnemopay-mcp` | Rate limit: 60/min, 500/hr

## Tests

672+ tests in `tests/`. Run with `npm test` (vitest). Files mirror `src/` structure.

## Deployment

- npm: `@mnemopay/sdk` v1.5.0 (governance fold: Charter, FiscalGate, Article 12, MerkleAudit). Companion `@mnemopay/toolkit` v0.1.0 = capability layer (14 packages).
- PyPI: `mnemopay` v1.0.0b3 (separate Python SDK)
- MCP: Smithery registry
- Site: `site/index.html`
- Dashboard: `node dashboard/server.js` → localhost:3200
- Fly.io: mnemopay-mcp.fly.dev

## Marketing

Scripts in `marketing/`: autopost.js, pipeline.js, distribute.js, email-launch.js
Content ready: Show HN, Dev.to tutorial, 12 tweets, 3 LinkedIn posts

## Don't

- Break public API exports from index.ts
- Use string amounts (always numbers)
- Forget settle() after charge()
- Skip `npm test` before committing

## Work Pattern (Karpathy-style: research → build → automate)

Before every non-trivial task, spend 10 min on research, then build, then automate one adjacent thing.

1. **Research first.** Check what exists: existing code in this repo (Grep/Read), prior session memory, competitor patterns, npm packages, recent papers or tweets. If the user asks for X, first verify X doesn't already exist here. If it does, extend it instead of rebuilding.
2. **Build the minimum.** Ship the smallest useful version. No speculative abstractions, no future-proofing, no "while I'm here" refactors. Three similar lines beat a premature helper.
3. **Automate one adjacent thing.** Every manual task you just did — turn it into a cron, a script, a test, or a note in `status.md`. Do not ship the same manual task twice.
4. **Verify before claiming done.** Run `npm test`. For UI changes, actually load it. For marketing scripts, dry-run before live-run. "Tests pass" is not the same as "it works."
5. **Update memory.** If something non-obvious happened (new service tier, bug class, vendor policy change), save it to `~/.claude/projects/C--WINDOWS-system32/memory/` so the next session doesn't re-learn it.

Checklist before marking a task complete:
- [ ] I grepped the repo for prior art.
- [ ] I ran the tests that cover what I changed.
- [ ] I removed the hardest manual step from this task for next time (or noted why I can't).
- [ ] `status.md` reflects what shipped and what's still open.

**Status file pattern.** At session start, read `status.md` at repo root (it's the one-page dashboard of live work). At session end, update it. Format: `## Shipped today` / `## In progress` / `## Blocked` / `## Next session`. Keep it under 60 lines — if it's longer, archive old entries to `status-archive.md`.
