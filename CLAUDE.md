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

- npm: `@mnemopay/sdk` v1.0.0-beta.1
- PyPI: `mnemopay` v1.0.0b1 (separate Python SDK)
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
