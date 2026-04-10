---
name: charge
description: Charge an AI agent for a service or tool invocation. Use when the user wants to bill for API calls, tool usage, or any metered service.
---

# Charge

Use the MnemoPay MCP `charge` tool to bill an agent for a service.

When the user asks to charge, bill, or meter usage:
1. Call the `charge` MCP tool with the amount and description
2. Report the transaction result including the new balance
3. If the charge fails due to insufficient funds or credit score, explain why

Example: "charge 0.50 for API call" → calls charge with amount=0.50, description="API call"

$ARGUMENTS contains the amount and description (e.g., "0.50 for image generation").
