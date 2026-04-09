---
name: mnemopay
description: |
  Persistent session memory and wallet for AI agents — works on Bedrock, Vertex, API, and Foundry where Anthropic's built-in memory doesn't.
  Auto-captures git commits, publishes, and file writes without manual remember() calls.
  Apache 2.0 licensed, self-hostable, MCP-native.
  15 MCP tools: remember, recall, forget, reinforce, consolidate, charge, settle, refund, balance, profile, reputation, logs, history, dispute, fraud_stats.
  4 prompts: recall-and-decide, agent-status-report, session-start, session-end.
  3 Claude Code hooks: Stop (session summary), UserPromptSubmit (recall injection), PostToolUse (auto-capture).
  Trigger: "remember", "recall", "charge", "settle", "balance", "mnemopay", "agent memory", "wallet", "reputation", "bedrock memory", "vertex memory", "session memory"
version: 1.4.0
homepage: https://github.com/mnemopay/mnemopay-sdk
metadata:
  openclaw:
    requires:
      bins:
        - npx
    emoji: "\U0001F9E0"
    homepage: https://github.com/mnemopay/mnemopay-sdk
---

# MnemoPay — Agent Memory + Wallet

Give any AI agent persistent memory and a micropayment wallet. MnemoPay unifies cognitive memory (Mnemosyne) and escrow economics (AgentPay) into a single MCP server. The core innovation: payment outcomes reinforce the memories that led to successful decisions.

## Setup

Auto-configure Claude Code hooks (session lifecycle, recall injection, auto-capture):

```bash
npx @mnemopay/sdk setup
```

Add the MnemoPay MCP server:

```bash
openclaw mcp set mnemopay '{"command":"npx","args":["-y","@mnemopay/sdk"],"env":{"MNEMOPAY_AGENT_ID":"openclaw-agent","MNEMOPAY_MODE":"quick"}}'
```

For production mode (persistent Postgres + Redis storage):

```bash
openclaw mcp set mnemopay '{"command":"npx","args":["-y","@mnemopay/sdk"],"env":{"MNEMOPAY_AGENT_ID":"openclaw-agent","MNEMOPAY_MODE":"production","MNEMO_URL":"http://localhost:8100","AGENTPAY_URL":"http://localhost:3100"}}'
```

Verify tools are available:

```bash
openclaw mcp list-tools mnemopay
```

## Tools Reference

### Memory Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `mcp__mnemopay__remember` | Store a memory with optional importance score and tags | When you learn something worth keeping across sessions — facts, preferences, decisions, observations |
| `mcp__mnemopay__recall` | Retrieve relevant memories. Supports semantic search via query parameter | Before making decisions, answering questions about past interactions, or when context from previous sessions would help |
| `mcp__mnemopay__forget` | Permanently delete a memory by ID | When a memory is outdated, incorrect, or the user requests deletion |
| `mcp__mnemopay__reinforce` | Boost a memory's importance score (+0.01 to +0.5) | After a memory leads to a successful outcome — positive feedback signal |
| `mcp__mnemopay__consolidate` | Prune stale memories below decay threshold | Periodically, to keep the memory store clean and relevant |

### Payment Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `mcp__mnemopay__charge` | Create an escrow charge for work delivered (max $500 x reputation) | ONLY after delivering value — never charge speculatively |
| `mcp__mnemopay__settle` | Finalize a pending charge. Moves funds to wallet, boosts reputation +0.01, reinforces recent memories +0.05 | When the user confirms satisfaction with delivered work |
| `mcp__mnemopay__refund` | Refund a transaction. Docks reputation -0.05 if already settled | When work was unsatisfactory or the user requests a refund |

### Status Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `mcp__mnemopay__balance` | Check wallet balance and reputation score | Before charging (to verify max charge limit) or when user asks about agent status |
| `mcp__mnemopay__profile` | Full agent stats: reputation, wallet, memory count, transaction count | For comprehensive status reports |
| `mcp__mnemopay__reputation` | Full reputation report: score, tier, settlement rate, total value settled | To prove trustworthiness to users and other agents |
| `mcp__mnemopay__logs` | Immutable audit trail of all memory and payment actions | For accountability and debugging |
| `mcp__mnemopay__history` | Transaction history, most recent first | When reviewing past charges, settlements, and refunds |

## Workflows

### Workflow 1: Remember and Recall

When you learn something important during a conversation:

1. Call `mcp__mnemopay__remember` with the content, optionally setting importance (0-1) and tags
2. In future sessions, call `mcp__mnemopay__recall` with a semantic query to retrieve relevant memories
3. Use recalled memories to provide personalized, context-aware responses

### Workflow 2: Charge for Value Delivered

When you complete a task that delivers measurable value:

1. Call `mcp__mnemopay__balance` to check current reputation and max charge limit
2. Deliver the work
3. Call `mcp__mnemopay__charge` with amount and clear description of value delivered
4. When user confirms satisfaction, call `mcp__mnemopay__settle` with the transaction ID
5. Settlement automatically reinforces recently-accessed memories (the feedback loop)

### Workflow 3: Session Start Protocol

At the beginning of every conversation:

1. Call `mcp__mnemopay__recall` with a query related to the user's first message (or no query for top memories)
2. Use recalled memories to greet the user with context from previous sessions
3. Call `mcp__mnemopay__profile` to check agent health

### Workflow 4: Memory Maintenance

Periodically (every 10-20 interactions):

1. Call `mcp__mnemopay__consolidate` to prune stale memories
2. Review top memories with `mcp__mnemopay__recall` (limit: 20)
3. Call `mcp__mnemopay__reinforce` on memories that are still actively useful

## The Feedback Loop

MnemoPay's core innovation is connecting memory to economics:

```
Remember → Recall → Act → Charge → Settle
                                      ↓
                              Reinforce memories (+0.05)
                              Boost reputation (+0.01)
```

Successful payments automatically strengthen the memories that led to good decisions. Over time, the agent gets better at remembering what matters. Failed transactions (refunds) dock reputation, creating accountability.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMOPAY_AGENT_ID` | `"mcp-agent"` | Agent identifier |
| `MNEMOPAY_MODE` | `"quick"` | `"quick"` (in-memory) or `"production"` (Postgres+Redis) |
| `MNEMO_URL` | `"http://localhost:8100"` | Mnemosyne API URL (production only) |
| `AGENTPAY_URL` | `"http://localhost:3100"` | AgentPay API URL (production only) |
| `MNEMO_API_KEY` | — | Mnemosyne API key (production only) |
| `AGENTPAY_API_KEY` | — | AgentPay API key (production only) |
| `OPENAI_API_KEY` | — | For semantic recall via embeddings (optional) |
| `DEBUG` | `"false"` | Enable debug logging |

## Error Handling

- If a tool call fails, the error message is returned as text. Do not retry immediately — diagnose the issue first.
- `charge` will fail if amount exceeds $500 x current reputation score. Check `balance` first.
- `settle` and `refund` require a valid transaction ID from a prior `charge`.
- `forget` returns whether the memory existed. A "not found" response is not an error.

## Links

- **SDK:** https://github.com/mnemopay/mnemopay-sdk
- **npm:** https://www.npmjs.com/package/@mnemopay/sdk
- **Docs:** https://github.com/mnemopay/mnemopay-sdk#readme
