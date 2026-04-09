# MnemoPay SDK

AI agent banking SDK — memory + payments + identity + credit scoring in one package.

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
| `fico.ts` | Agent FICO credit scoring (300-850) |
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
| `mcp/server.ts` | MCP server (12 tools, 2 prompts) |
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
- **FICO:** 5 components weighted: payment 35%, utilization 20%, age 15%, diversity 15%, fraud 15%
- **Fee tiers:** 1.0% (FICO 800+) → 2.5% (FICO <580, requires HITL)

## MCP Server

12 tools: remember, recall, forget, reinforce, consolidate, charge, settle, refund, balance, profile, logs, history
Entry: `src/mcp/server.ts` | Binary: `mnemopay-mcp`

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
