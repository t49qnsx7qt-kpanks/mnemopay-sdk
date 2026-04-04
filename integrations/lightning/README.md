# MnemoPay x Lightning Network

Bridge MnemoPay's memory and trust layer with Lightning Network payments.

Lightning Agent Tools gives AI agents the ability to pay. MnemoPay gives them the ability to *remember* and *trust*. Together: agents that pay intelligently.

## The Gap

> "AI agents transacting on Bitcoin is largely unexplored but obvious." — Jack Dorsey

Lightning Agent Tools can pay for L402 API resources, but:
- No memory of which endpoints delivered value
- No trust scoring for counterparties
- No fraud detection on agent-initiated payments
- No learning from payment outcomes

MnemoPay fills every one of these gaps.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  AI Agent                    │
│         (Goose, Claude, any MCP host)        │
├──────────────────┬──────────────────────────┤
│   MnemoPay MCP   │   Lightning MCP          │
│   ─────────────  │   ──────────────         │
│   remember       │   lnd (node ops)         │
│   recall         │   lnget (L402 client)    │
│   charge/settle  │   macaroon-bakery        │
│   fraud guard    │   lightning-mcp-server    │
│   trust scoring  │   aperture (L402 proxy)  │
└──────────────────┴──────────────────────────┘
```

## Setup

### Both extensions in Goose

```yaml
extensions:
  mnemopay:
    type: stdio
    cmd: npx
    args: ["-y", "@mnemopay/sdk"]
    env:
      MNEMOPAY_AGENT_ID: "lightning-agent"
  lightning:
    type: stdio
    cmd: npx
    args: ["-y", "@lightninglabs/lightning-mcp-server"]
```

### Both extensions in Claude Desktop

```json
{
  "mcpServers": {
    "mnemopay": {
      "command": "npx",
      "args": ["-y", "@mnemopay/sdk"],
      "env": { "MNEMOPAY_AGENT_ID": "lightning-agent" }
    },
    "lightning": {
      "command": "npx",
      "args": ["-y", "@lightninglabs/lightning-mcp-server"]
    }
  }
}
```

## Usage Patterns

### 1. Remember L402 Endpoint Quality

```
Agent pays for API via Lightning (lnget)
  → Agent evaluates response quality
  → remember("L402 endpoint api.example.com returned accurate data, 200ms latency, cost 100 sats", importance: 0.8, tags: ["l402", "api-quality"])
  → Next time: recall("reliable L402 endpoints") before paying
```

### 2. Trust-Gated Lightning Payments

```
Agent wants to pay a new counterparty
  → recall("counterparty:xyz") — any prior interactions?
  → If unknown: charge small test amount via MnemoPay escrow
  → If payment settles successfully: settle() → reputation boost
  → remember("counterparty:xyz delivered value, settled $X")
  → Next time: larger amounts allowed (rep-gated)
```

### 3. Fraud Prevention on Lightning

```
Agent receives rapid payment requests
  → MnemoPay's FraudGuard checks velocity (5/min, 30/hr, 100/day)
  → Anomaly detection flags unusual amounts
  → Agent declines suspicious requests
  → remember("blocked suspicious payment pattern from endpoint Y", importance: 0.9, tags: ["fraud", "blocked"])
```

### 4. Multi-Agent Lightning Commerce

```
Buyer agent → charge(amount, "data analysis") → MnemoPay escrow
  → Seller agent delivers via Lightning-paid API
  → Buyer evaluates quality
  → settle(txId) — releases funds, boosts both reputations
  → Both agents remember the interaction
  → reinforce() memories that led to successful trades
```

## The Feedback Loop with Lightning

```
recall("best L402 endpoints") → choose endpoint
  → pay via Lightning (lnget) → evaluate response
  → charge(cost, "API access") → settle(txId)
  → memories of this endpoint get +0.05 importance boost
  → next recall() ranks this endpoint higher
  → agent converges on best-value endpoints automatically
```

## Environment Variables

All MnemoPay variables apply. Lightning-specific:

| Variable | Description |
|----------|-------------|
| `LNC_PAIRING_PHRASE` | Lightning Node Connect pairing (for lnget) |
| `LND_CONNECT_URI` | Direct LND connection URI |

## Limitations

- Lightning Agent Tools requires Go 1.24+ for source builds (use npx for zero-install)
- Lightning node must be funded for outgoing payments
- L402 is request-response; MnemoPay's memory layer is what makes it persistent
- Both MCP servers run as separate processes; the AI agent orchestrates between them

## License

MIT
