# MnemoPay x x402 Trust Middleware

Add persistent memory, trust scoring, and fraud detection to [x402](https://x402.org) payments.

x402 is stateless by design — each payment is independent. MnemoPay adds the trust layer that makes agents confident enough to transact repeatedly.

## The Problem

```
Without MnemoPay:
  Agent → x402 payment → forget → next request starts from zero

With MnemoPay:
  Agent → recall(seller) → evaluate trust → x402 payment → remember outcome → learn
```

## Setup

### Install

```bash
npm install @mnemopay/sdk @x402/axios @x402/evm
```

### Configure Both

```typescript
import { MnemoPayLite } from '@mnemopay/sdk';
import { x402Client, wrapAxiosWithPayment } from '@x402/axios';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import { X402Bridge } from './bridge';

// MnemoPay agent
const agent = MnemoPayLite.quick('x402-agent');

// x402 client
const client = new x402Client();
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY),
});
const api = wrapAxiosWithPayment(axios.create(), client);

// Bridge
const bridge = new X402Bridge(agent);
```

## Usage Patterns

### 1. Trust-Gated API Calls

```typescript
// Before paying, check trust
const decision = bridge.evaluateSeller('https://api.example.com');

if (!decision.shouldPay) {
  console.log('Blocked:', decision.reason);
} else {
  const res = await api.get('https://api.example.com/data');
  // Record outcome
  bridge.recordPayment('https://api.example.com', 0.20, res.status === 200, res.data);
}
```

### 2. Smart Spending

```typescript
// Agent learns which APIs deliver best value per dollar
const bestAPIs = bridge.bestSellers(5);
// Returns top 5 x402 endpoints ranked by quality/cost ratio from memory
```

### 3. Fraud Detection on Outgoing Payments

```typescript
// MnemoPay's 10-signal fraud pipeline catches:
// - Rapid payment velocity (5/min, 30/hr, 100/day limits)
// - Anomalous amounts (z-score > 2.5σ)
// - Payments to previously-blocked sellers
// - Escalating payment patterns
```

## Architecture

```
┌──────────────────────────────────────┐
│            AI Agent                  │
├──────────────┬───────────────────────┤
│  MnemoPay    │     x402 Client       │
│  ──────────  │     ──────────        │
│  recall()    │     HTTP 402 handler  │
│  remember()  │     USDC on Base      │
│  charge()    │     Payment signing   │
│  settle()    │     On-chain settle   │
│  fraud guard │                       │
└──────────────┴───────────────────────┘
```

## MCP Server Setup

For MCP hosts (Claude, Goose, Cursor):

```json
{
  "mcpServers": {
    "mnemopay": {
      "command": "npx",
      "args": ["-y", "@mnemopay/sdk"],
      "env": { "MNEMOPAY_AGENT_ID": "x402-agent" }
    }
  }
}
```

The agent uses MnemoPay tools (recall, remember, charge, settle) alongside x402 HTTP client to create trust-aware payment flows.

## Why This Matters

x402 daily volume is ~$28K/day (as of March 2026). The demand gap exists because agents lack confidence in repeated transactions. MnemoPay's trust layer could drive adoption by:

1. Letting agents learn which endpoints are worth paying for
2. Blocking fraudulent or low-quality sellers automatically
3. Building reputation scores that persist across sessions
4. Creating a feedback loop where good payments reinforce good memories

## License

MIT
