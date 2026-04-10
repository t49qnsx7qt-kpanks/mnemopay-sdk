# MnemoPay Claude Code Plugin

Payment infrastructure for AI agents. Gives Claude Code a full financial stack: charge for services, manage balances, shop autonomously with escrow, track credit scores, and persist memories with cryptographic integrity.

## Skills

| Skill | Command | What it does |
|-------|---------|-------------|
| charge | `/mnemopay:charge` | Bill agents for API calls or tool usage |
| balance | `/mnemopay:balance` | Check agent balance and financial status |
| shop | `/mnemopay:shop` | Search products, buy with escrow protection |
| fico | `/mnemopay:fico` | Agent Credit Score (300-850) and reputation |
| remember | `/mnemopay:remember` | Store data in hash-chained persistent memory |
| recall | `/mnemopay:recall` | Search and retrieve stored memories |
| history | `/mnemopay:history` | View transaction history and spending |
| settle | `/mnemopay:settle` | Finalize pending transactions, release escrow |

## Setup

The plugin bundles the MnemoPay MCP server. No additional configuration needed — install the plugin and the server runs automatically via `npx @mnemopay/sdk`.

### Optional environment variables

For real payment rails (defaults to mock/sandbox):

- `STRIPE_SECRET_KEY` — Stripe payments
- `PAYSTACK_SECRET_KEY` — Paystack payments (NGN)
- `MNEMOPAY_PAYMENT_RAIL` — `stripe`, `paystack`, or `mock`
- `MNEMOPAY_COMMERCE_PROVIDER` — `firecrawl`, `shopify`, or `mock`

## Examples

```
/mnemopay:charge 0.50 for image generation
/mnemopay:balance
/mnemopay:shop wireless headphones under $50
/mnemopay:fico
/mnemopay:remember Jerry prefers Paystack for NGN transactions
/mnemopay:recall payment preferences
/mnemopay:history last 7 days
/mnemopay:settle
```

## License

Apache-2.0
