---
name: history
description: View transaction history and financial records. Use when the user asks about past transactions, spending, or payment history.
---

# Transaction History

Use the MnemoPay MCP `history` tool to view past transactions.

When the user asks about transaction history or past spending:
1. Call `history` to get the transaction log
2. Present transactions in a clear, chronological format
3. If the user asks for analysis, use `behavioral_analysis` for spending pattern insights
4. Use `fraud_stats` to check for any flagged transactions

$ARGUMENTS can specify a time range or filter (e.g., "last 7 days" or "refunds only").
