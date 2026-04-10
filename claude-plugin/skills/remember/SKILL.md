---
name: remember
description: Store information in the agent's persistent memory. Use when the user wants to save facts, preferences, decisions, or any data for future recall.
---

# Remember

Use the MnemoPay MCP `remember` tool to store information in persistent memory.

Memory is hash-chained for integrity — every entry is cryptographically linked to the previous one, making tampering detectable.

When the user says "remember this" or wants to save information:
1. Call the `remember` tool with the content from "$ARGUMENTS"
2. Optionally add tags for categorization
3. Confirm what was stored

The agent's memory persists across sessions and can be recalled later with `/mnemopay:recall`.
