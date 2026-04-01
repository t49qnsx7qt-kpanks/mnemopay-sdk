/**
 * MnemoPay Unified MCP Server
 *
 * Exposes all MnemoPay SDK methods as MCP tools. Any MCP-compatible
 * client (Claude Desktop, Cursor, Windsurf, OpenClaw, Hermes) gets
 * agent memory + wallet capabilities instantly.
 *
 * Usage:
 *   npx @mnemopay/mcp-server                    # stdio mode (default)
 *   npx @mnemopay/mcp-server --http --port 3200 # HTTP/SSE mode
 *
 * Environment:
 *   MNEMOPAY_AGENT_ID   — Agent identifier (default: "mcp-agent")
 *   MNEMOPAY_MODE       — "quick" or "production" (default: "quick")
 *   MNEMO_URL           — Mnemosyne API URL (production mode)
 *   AGENTPAY_URL        — AgentPay API URL (production mode)
 *   MNEMO_API_KEY       — Mnemosyne API key (production mode)
 *   AGENTPAY_API_KEY    — AgentPay API key (production mode)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MnemoPay, MnemoPayLite } from "../index.js";

type Agent = MnemoPayLite | MnemoPay;

// ─── Agent initialization ───────────────────────────────────────────────────

function createAgent(): Agent {
  const agentId = process.env.MNEMOPAY_AGENT_ID || "mcp-agent";
  const mode = process.env.MNEMOPAY_MODE || "quick";

  if (mode === "production") {
    return MnemoPay.create({
      agentId,
      mnemoUrl: process.env.MNEMO_URL || "http://localhost:8100",
      agentpayUrl: process.env.AGENTPAY_URL || "http://localhost:3100",
      mnemoApiKey: process.env.MNEMO_API_KEY,
      agentpayApiKey: process.env.AGENTPAY_API_KEY,
      debug: process.env.DEBUG === "true",
    });
  }

  return MnemoPay.quick(agentId, { debug: process.env.DEBUG === "true" });
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory. The agent will remember this across sessions. " +
      "Importance is auto-scored from content if not provided. " +
      "Use for facts, preferences, decisions, and observations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "What to remember" },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Importance score (0-1). Auto-scored if omitted.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "Recall the most relevant memories, ranked by importance x recency x frequency. " +
      "Call this before making decisions or answering questions about past interactions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          default: 5,
          description: "Number of memories to recall (default: 5)",
        },
      },
    },
  },
  {
    name: "forget",
    description: "Permanently delete a memory by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Memory ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "reinforce",
    description:
      "Boost a memory's importance when external signals confirm it was valuable. " +
      "Use after a memory leads to a successful outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Memory ID to reinforce" },
        boost: {
          type: "number",
          minimum: 0.01,
          maximum: 0.5,
          default: 0.1,
          description: "Importance boost (default: 0.1)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "consolidate",
    description:
      "Prune stale memories whose composite score has decayed below threshold. " +
      "Run periodically to keep memory store clean.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "charge",
    description:
      "Create an escrow charge for work delivered. Held pending until settled. " +
      "Maximum charge = $500 x agent reputation. Only charge AFTER delivering value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: {
          type: "number",
          minimum: 0.01,
          maximum: 500,
          description: "Amount in USD",
        },
        reason: {
          type: "string",
          minLength: 5,
          description: "Clear description of value delivered",
        },
      },
      required: ["amount", "reason"],
    },
  },
  {
    name: "settle",
    description:
      "Finalize a pending escrow. Moves funds to wallet, boosts reputation +0.01, " +
      "and reinforces recently-accessed memories by +0.05 (the feedback loop).",
    inputSchema: {
      type: "object" as const,
      properties: {
        txId: { type: "string", description: "Transaction ID from charge" },
      },
      required: ["txId"],
    },
  },
  {
    name: "refund",
    description:
      "Refund a transaction. If already settled, withdraws funds and docks " +
      "reputation by -0.05. Takes 5 successful settlements to recover.",
    inputSchema: {
      type: "object" as const,
      properties: {
        txId: { type: "string", description: "Transaction ID to refund" },
      },
      required: ["txId"],
    },
  },
  {
    name: "balance",
    description: "Check wallet balance and reputation score.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "profile",
    description: "Full agent stats: reputation, wallet, memory count, transaction count.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "logs",
    description: "Immutable audit trail of all memory and payment actions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", default: 20, description: "Number of entries" },
      },
    },
  },
  {
    name: "history",
    description: "Transaction history, most recent first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", default: 10, description: "Number of transactions" },
      },
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────────────────────

async function executeTool(agent: Agent, name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "remember": {
      const opts: any = {};
      if (args.importance !== undefined) opts.importance = args.importance;
      if (args.tags) opts.tags = args.tags;
      const id = await agent.remember(args.content, Object.keys(opts).length ? opts : undefined);
      return JSON.stringify({ id, status: "stored" });
    }

    case "recall": {
      const memories = await agent.recall(args.limit ?? 5);
      if (memories.length === 0) return "No memories found.";
      return memories
        .map((m, i) => `${i + 1}. [score:${m.score.toFixed(2)}, importance:${m.importance.toFixed(2)}] ${m.content}`)
        .join("\n");
    }

    case "forget": {
      const deleted = await agent.forget(args.id);
      return deleted ? `Memory ${args.id} deleted.` : `Memory ${args.id} not found.`;
    }

    case "reinforce": {
      await agent.reinforce(args.id, args.boost ?? 0.1);
      return `Memory ${args.id} reinforced by +${args.boost ?? 0.1}`;
    }

    case "consolidate": {
      const pruned = await agent.consolidate();
      return `Consolidated: pruned ${pruned} stale memories.`;
    }

    case "charge": {
      const tx = await agent.charge(args.amount, args.reason);
      return JSON.stringify({ txId: tx.id, amount: tx.amount, status: tx.status, reason: tx.reason });
    }

    case "settle": {
      const tx = await agent.settle(args.txId);
      return JSON.stringify({ txId: tx.id, amount: tx.amount, status: tx.status });
    }

    case "refund": {
      const tx = await agent.refund(args.txId);
      return JSON.stringify({ txId: tx.id, status: tx.status });
    }

    case "balance": {
      const bal = await agent.balance();
      return `Wallet: $${bal.wallet.toFixed(2)} | Reputation: ${bal.reputation.toFixed(2)}`;
    }

    case "profile": {
      const p = await agent.profile();
      return JSON.stringify(p, null, 2);
    }

    case "logs": {
      const entries = await agent.logs(args.limit ?? 20);
      return entries.map((e) => `[${e.createdAt.toISOString()}] ${e.action}: ${JSON.stringify(e.details)}`).join("\n");
    }

    case "history": {
      const txns = await agent.history(args.limit ?? 10);
      if (txns.length === 0) return "No transactions yet.";
      return txns.map((t) => `$${t.amount.toFixed(2)} — ${t.status} — ${t.reason}`).join("\n");
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Server setup ───────────────────────────────────────────────────────────

export async function startServer(): Promise<void> {
  const agent = createAgent();

  const server = new Server(
    { name: "mnemopay", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // ── Tools ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeTool(agent, name, args ?? {});
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ── Resources ───────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "mnemopay://health",
        name: "Agent Health",
        description: "Current agent profile, wallet, reputation, and memory stats",
        mimeType: "application/json",
      },
      {
        uri: "mnemopay://memories",
        name: "All Memories",
        description: "Top 20 memories ranked by composite score",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "mnemopay://health") {
      const profile = await agent.profile();
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(profile, null, 2) }],
      };
    }

    if (uri === "mnemopay://memories") {
      const memories = await agent.recall(20);
      const text = memories.length === 0
        ? "No memories stored."
        : memories
            .map((m, i) => `${i + 1}. [${m.importance.toFixed(2)}] ${m.content}`)
            .join("\n");
      return { contents: [{ uri, mimeType: "text/plain", text }] };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // ── Prompts ─────────────────────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "recall-and-decide",
        description:
          "Recall all relevant memories, analyze them, and make a decision. " +
          "Includes the agent's current reputation and wallet status.",
        arguments: [
          { name: "question", description: "The decision or question to address", required: true },
        ],
      },
      {
        name: "agent-status-report",
        description: "Generate a full status report of the agent's memory health and financial state.",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "recall-and-decide") {
      const memories = await agent.recall(10);
      const profile = await agent.profile();
      const memoryBlock = memories.length === 0
        ? "No memories available."
        : memories.map((m, i) => `${i + 1}. [${m.score.toFixed(2)}] ${m.content}`).join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Question: ${args?.question || "What should I do next?"}`,
                "",
                "## Agent Status",
                `Reputation: ${profile.reputation} | Wallet: $${profile.wallet} | Memories: ${profile.memoriesCount}`,
                "",
                "## Relevant Memories",
                memoryBlock,
                "",
                "Based on these memories and the agent's current state, provide your analysis and recommendation.",
                "If you take an action that delivers value, use the charge tool to invoice for it.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    if (name === "agent-status-report") {
      const profile = await agent.profile();
      const memories = await agent.recall(10);
      const recent = await agent.history(5);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "## Agent Status Report",
                "",
                `Agent: ${profile.id}`,
                `Reputation: ${profile.reputation.toFixed(2)}`,
                `Wallet: $${profile.wallet.toFixed(2)}`,
                `Memories: ${profile.memoriesCount}`,
                `Transactions: ${profile.transactionsCount}`,
                "",
                "## Top Memories",
                ...memories.map((m, i) => `${i + 1}. [${m.importance.toFixed(2)}] ${m.content}`),
                "",
                "## Recent Transactions",
                ...(recent.length === 0
                  ? ["No transactions yet."]
                  : recent.map((t) => `$${t.amount.toFixed(2)} — ${t.status} — ${t.reason}`)),
                "",
                "Analyze this agent's health: memory quality, financial performance, reputation trajectory.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // ── Start ───────────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mnemopay-mcp] Server started (stdio mode)");
}

// Auto-start when run directly
const isDirectRun = process.argv[1]?.includes("mcp") || process.argv.includes("--start");
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
