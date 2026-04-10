---
name: settle
description: Settle pending transactions and release escrow. Use when the user wants to finalize payments, release held funds, or settle outstanding balances.
---

# Settle

Use the MnemoPay MCP `settle` tool to finalize pending transactions.

When the user asks to settle, finalize, or release funds:
1. Call `settle` to process pending settlements
2. Report which transactions were settled and the amounts
3. If there are disputes, mention them and suggest using `dispute` to resolve

For commerce orders, use `shop_confirm_delivery` first to release escrow before settling.

$ARGUMENTS can specify a transaction ID to settle a specific transaction.
