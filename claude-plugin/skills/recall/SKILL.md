---
name: recall
description: Search and retrieve information from the agent's persistent memory. Use when the user asks to recall, look up, or find previously stored information.
---

# Recall

Use the MnemoPay MCP `recall` tool to search persistent memory.

When the user asks to recall or find stored information:
1. Call `recall` with the query from "$ARGUMENTS"
2. Present the matching memories with their timestamps and tags
3. If no matches found, suggest the user store the information first with `/mnemopay:remember`

You can also use `memory_integrity_check` to verify the hash chain hasn't been tampered with.
