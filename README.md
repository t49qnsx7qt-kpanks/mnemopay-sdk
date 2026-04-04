# @mnemopay/sdk

**Session memory for Claude on AWS Bedrock, Google Vertex AI, Anthropic API, and Foundry.**

MIT-licensed. Self-hostable. Works in 30 seconds via `npx`.

---

## The Problem

Anthropic's built-in Session Memory and Auto Dream features are **Pro/Max subscription only**. If your team accesses Claude through:

- AWS Bedrock
- Google Vertex AI
- Anthropic API directly
- Foundry or any third-party host

...you get **zero native memory**. Every session starts cold. Context has to be rebuilt by hand, crammed into prompts, or managed with brittle custom code.

MnemoPay is the only MIT-licensed, self-hostable MCP server that gives those deployments persistent session memory — plus an optional micropayment wallet for agent-to-agent transactions.

---

## Quickstart

```bash
npx @mnemopay/sdk init
```

That registers MnemoPay as an MCP server. Works with Claude Code, Cursor, Windsurf, or any MCP-compatible client. No Claude Pro required.

Or install as a package dependency:

```bash
npm install @mnemopay/sdk
```

```typescript
import { MnemoPay } from "@mnemopay/sdk";

const agent = MnemoPay.quick("agent-001");
await agent.remember("User prefers TypeScript over Python");
const memories = await agent.recall();
// Optional: payment rails
const tx = await agent.charge(5.00, "Built analytics dashboard");
await agent.settle(tx.id);
```

---

## Why Not the Alternatives?

| | MnemoPay | claude-mem | claude-brain | Anthropic built-in | Minolith |
|---|---|---|---|---|---|
| **License** | MIT | AGPL-3.0 | MIT | Proprietary | Paid/closed |
| **Enterprise-safe** | Yes | **No** (AGPL) | Yes | N/A | Vendor lock-in |
| **Works on Bedrock/Vertex/API** | Yes | No | No | **No (Pro/Max only)** | Unknown |
| **MCP — any client** | Yes | Claude Code only | Claude Code only | Claude Code only | No |
| **Semantic search** | Yes | No | No | Yes | Unknown |
| **Importance decay** | Yes | No | No | Unknown | Unknown |
| **Self-hostable** | Yes | Yes | Yes | No | No |
| **Payment rails** | Yes | No | No | No | No |
| **Runaway API spend risk** | No | Yes (worker daemon) | Unknown | N/A | Unknown |

**The short version:** claude-mem is AGPL, which means enterprise legal teams will reject it on sight. The Anthropic built-in solution is excellent — but it only works if your team pays for Pro or Max subscriptions. MnemoPay fills the gap for everyone else.

---

## Two Modes, One API

| Mode | Constructor | Dependencies | Persistence | Use Case |
|------|------------|-------------|-------------|----------|
| **Prototype** | `MnemoPay.quick("id")` | None | In-memory | Development, testing, demos |
| **Production** | `MnemoPay.create({...})` | Postgres + Redis | Durable | Deployed agents |

Switch by changing one line. No code rewrites.

---

## API Reference

### Memory Methods

| Method | Description |
|--------|-------------|
| `agent.remember(content, opts?)` | Store a memory. Auto-scored by importance if not specified. |
| `agent.recall(limit?)` | Recall top memories ranked by importance × recency × frequency. |
| `agent.forget(id)` | Delete a memory. |
| `agent.reinforce(id, boost?)` | Boost a memory's importance score. |
| `agent.consolidate()` | Prune stale memories below score threshold. |

### Payment Methods (Optional)

| Method | Description |
|--------|-------------|
| `agent.charge(amount, reason)` | Create an escrow transaction. Reputation-gated. |
| `agent.settle(txId)` | Finalize escrow. Moves funds, boosts reputation, reinforces memories. |
| `agent.refund(txId)` | Refund a transaction. Docks reputation by -0.05. |
| `agent.balance()` | Get wallet balance and reputation score. |

### Observability

| Method | Description |
|--------|-------------|
| `agent.profile()` | Full agent stats (reputation, wallet, memory count, tx count). |
| `agent.logs(limit?)` | Immutable audit trail of all actions. |
| `agent.history(limit?)` | Transaction history, most recent first. |

---

## Provider Middlewares

### Anthropic (invisible memory)

Drop-in wrapper for `@anthropic-ai/sdk`. Works with Bedrock and Vertex clients too — anything that uses the same interface.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { MnemoPay } from "@mnemopay/sdk";
import { AnthropicMiddleware } from "@mnemopay/sdk/middleware/anthropic";

const agent = MnemoPay.quick("claude-agent");
const ai = AnthropicMiddleware.wrap(new Anthropic(), agent);

// Memory is auto-injected into context and auto-stored after each response
const res = await ai.messages.create({
  model: "claude-opus-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What do you remember?" }],
});
```

### OpenAI (invisible memory)

```typescript
import OpenAI from "openai";
import { MnemoPay } from "@mnemopay/sdk";
import { MnemoPayMiddleware } from "@mnemopay/sdk/middleware/openai";

const agent = MnemoPay.quick("assistant");
const ai = MnemoPayMiddleware.wrap(new OpenAI(), agent);

const res = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What do you remember?" }],
});
```

---

## LangGraph Tools

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MnemoPay } from "@mnemopay/sdk";
import { mnemoTools, agentPayTools } from "@mnemopay/sdk/langgraph";

const agent = MnemoPay.quick("langgraph-agent");
const graph = createReactAgent({
  llm,
  tools: [...mnemoTools(agent), ...agentPayTools(agent)],
});
```

6 tools with full Zod schemas: `recall_memories`, `store_memory`, `reinforce_memory`, `charge_user`, `settle_payment`, `check_balance`.

---

## The Memory-Payment Feedback Loop

The payment rails are optional, but they unlock a core differentiator: payment outcomes reinforce the memories that led to successful decisions.

```
Agent recalls memories → Makes decision → Delivers value → Charges user
                                                              ↓
                                                      Payment settles
                                                              ↓
                        Memories accessed in the last hour get +0.05 importance
                                                              ↓
                                    Agent makes better decisions next time
```

Memories associated with successful transactions rise in recall priority. Memories associated with refunds decay faster. Over time, the agent's judgment improves without any fine-tuning.

### Agents Hiring Agents

```typescript
const manager = MnemoPay.quick("manager");
const coder = MnemoPay.quick("coder");

await manager.remember("coder delivered fast but had 2 bugs last time");
const memories = await manager.recall(); // Informs hiring decision

const job = await manager.charge(5.00, "Code sorting algorithm");
await manager.settle(job.id);
await manager.remember("coder delivered clean code this time");
// Next round: manager's recall reflects the updated track record
```

---

## Production Setup

```bash
docker compose up -d  # Starts Mnemosyne + AgentPay + Postgres + Redis
```

```typescript
const agent = MnemoPay.create({
  agentId: "prod-agent",
  mnemoUrl: "http://localhost:8100",
  agentpayUrl: "http://localhost:3100",
  debug: true,
});

// Same API — backed by Hopfield networks, Bayesian trust, AIS fraud detection
await agent.remember("Production memory");
const tx = await agent.charge(10.00, "Premium service");
await agent.settle(tx.id);
```

Optional peer dependencies — install only what you use:

```bash
npm install openai                  # For OpenAI middleware
npm install @anthropic-ai/sdk       # For Anthropic middleware
npm install @langchain/langgraph @langchain/core @langchain/openai  # For LangGraph tools
```

---

## Architecture

```
Your code
    ↓
@mnemopay/sdk ←── Single import, 12 methods
    ↓              ↓
Mnemosyne API    AgentPay API ←── Separate services (unchanged)
(12 models)      (14 models)
    ↓              ↓
  Redis Streams Bridge ←── Payment outcomes reinforce memories
```

- **Mnemosyne**: Hopfield associative recall, FSRS spaced repetition, Merkle integrity, Dream consolidation
- **AgentPay**: Bayesian trust (Beta distributions), AIS fraud detection, behavioral economics, escrow

---

## Integration Support

| Platform | Status | Notes |
|---|---|---|
| Claude Code | Stable | MCP server via `npx @mnemopay/sdk init` |
| Cursor | Stable | Same MCP config |
| Windsurf | Stable | Same MCP config |
| AWS Bedrock | Stable | Use `AnthropicMiddleware` with Bedrock client |
| Google Vertex AI | Stable | Use `AnthropicMiddleware` with Vertex client |
| Anthropic API | Stable | Drop-in with `AnthropicMiddleware` |
| LangGraph | Stable | 6 native tools with Zod schemas |
| OpenAI-compatible | Stable | `MnemoPayMiddleware` wrapper |
| Mastra | In progress | Native MCP — no plugin needed |

---

## Pricing

MnemoPay SDK is free and MIT-licensed. Self-hosting is always free.

For teams that want managed hosting, SLA support, or enterprise onboarding:

| Tier | Price | Includes |
|---|---|---|
| **Self-hosted** | Free | Full SDK, unlimited agents, you manage infra |
| **Team** | $99/month | Managed hosting, up to 10 agents, email support |
| **Business** | $299/month | Managed hosting, up to 50 agents, priority support, SSO |
| **Enterprise** | $499+/month | Unlimited agents, SLA, dedicated support, custom deployment |

Contact: [github.com/mnemopay](https://github.com/mnemopay)

---

## Tests

```bash
npm test  # 143 tests covering memory, payments, feedback loop, security, concurrency
```

---

## License

**MIT** — use it in commercial products, enterprise deployments, forks, anything. No AGPL restrictions.

Built by [J&B Enterprise LLC](https://github.com/mnemopay)
