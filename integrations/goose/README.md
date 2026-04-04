# MnemoPay for Goose

Give any [Goose](https://github.com/block/goose) agent persistent memory, micropayments, and fraud-aware trust scoring.

Goose is MCP-native — MnemoPay plugs in as a standard extension. No custom code required.

## Quick Start

### Option A: One-line CLI setup

```bash
goose configure extensions --add mnemopay -- npx -y @mnemopay/sdk
```

### Option B: Config file

Add to your `~/.config/goose/config.yaml`:

```yaml
extensions:
  mnemopay:
    type: stdio
    cmd: npx
    args: ["-y", "@mnemopay/sdk"]
    env:
      MNEMOPAY_AGENT_ID: "goose-agent"
      MNEMOPAY_MODE: "quick"
```

### Option C: Remote server (SSE)

```yaml
extensions:
  mnemopay:
    type: sse
    uri: https://your-mnemopay-server.fly.dev/mcp
    env:
      MNEMOPAY_AGENT_ID: "goose-agent"
```

## What Goose Gets

### Memory (5 tools)
- **remember** — Store findings, decisions, user preferences (auto-scored by importance)
- **recall** — Semantic search over memories ranked by importance x recency x frequency
- **forget** — Delete a memory
- **reinforce** — Boost memory importance after a positive outcome
- **consolidate** — Prune stale memories below decay threshold

### Payments (4 tools)
- **charge** — Create escrow (fraud-checked, reputation-gated: max $500 x rep)
- **settle** — Finalize payment (wallet += amount, rep += 0.01, memories reinforced +0.05)
- **refund** — Refund transaction (rep -= 0.05)
- **balance** — Check wallet and reputation

### Observability (4 tools)
- **profile** — Full agent stats
- **reputation** — Detailed trust report with tier and settlement rate
- **logs** — Immutable audit trail
- **history** — Transaction history

## The Feedback Loop

This is what makes MnemoPay different from generic memory or payment tools:

```
recall() → agent uses memories to make decisions
    → charge(amount, reason) → settle(txId)
        → memories used in last hour get +0.05 importance boost
            → agent literally improves over time
```

Successful payments reinforce the memories that led to them. The agent learns what works.

## Recipes

Goose supports [recipes](https://block.github.io/goose/docs/guides/using-recipes) for reusable workflows. See `recipe.yaml` in this directory.

### Use the recipe

```bash
goose session --recipe integrations/goose/recipe.yaml
```

## Pairing with Lightning

MnemoPay pairs naturally with [Lightning Agent Tools](https://github.com/nicklayerth/lightning-agent-tools). Lightning handles L402 payments; MnemoPay remembers which endpoints are reliable and scores trust:

```yaml
extensions:
  mnemopay:
    type: stdio
    cmd: npx
    args: ["-y", "@mnemopay/sdk"]
  lightning:
    type: stdio
    cmd: npx
    args: ["-y", "@lightninglabs/lightning-mcp-server"]
```

The agent can now pay for API resources via Lightning AND remember which resources delivered value.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMOPAY_AGENT_ID` | `mcp-agent` | Unique agent identifier |
| `MNEMOPAY_MODE` | `quick` | `quick` (in-memory) or `production` (Postgres/Redis) |
| `MNEMOPAY_PERSIST_DIR` | `~/.mnemopay/data` | File persistence location |
| `MNEMOPAY_RECALL` | `score` | Recall strategy: `score`, `vector`, or `hybrid` |
| `OPENAI_API_KEY` | — | For semantic vector embeddings (optional) |

## License

MIT
