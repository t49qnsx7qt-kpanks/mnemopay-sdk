"""
Tool schemas for LLM function-calling.
Each schema describes one MnemoPay tool in the format Hermes expects.
"""

TOOLS = [
    {
        "name": "mnemopay_remember",
        "description": (
            "Store a memory. The agent will remember this across sessions. "
            "Importance is auto-scored from content if not provided. "
            "Use for facts, preferences, decisions, and observations."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "What to remember",
                },
                "importance": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "description": "Importance score (0-1). Auto-scored if omitted.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional tags for categorization",
                },
            },
            "required": ["content"],
        },
    },
    {
        "name": "mnemopay_recall",
        "description": (
            "Recall the most relevant memories. Supports semantic search "
            "when a query is provided. Call before making decisions or "
            "answering questions about past interactions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Semantic search query (optional).",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 5,
                    "description": "Number of memories to recall (default: 5)",
                },
            },
        },
    },
    {
        "name": "mnemopay_forget",
        "description": "Permanently delete a memory by ID.",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Memory ID to delete"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "mnemopay_reinforce",
        "description": (
            "Boost a memory's importance when external signals confirm it "
            "was valuable. Use after a memory leads to a successful outcome."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Memory ID to reinforce"},
                "boost": {
                    "type": "number",
                    "minimum": 0.01,
                    "maximum": 0.5,
                    "default": 0.1,
                    "description": "Importance boost (default: 0.1)",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "mnemopay_consolidate",
        "description": (
            "Prune stale memories whose composite score has decayed below "
            "threshold. Run periodically to keep memory store clean."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "mnemopay_charge",
        "description": (
            "Create an escrow charge for work delivered. Held pending until "
            "settled. Maximum charge = $500 x agent reputation. "
            "Only charge AFTER delivering value."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "amount": {
                    "type": "number",
                    "minimum": 0.01,
                    "maximum": 500,
                    "description": "Amount in USD",
                },
                "reason": {
                    "type": "string",
                    "minLength": 5,
                    "description": "Clear description of value delivered",
                },
            },
            "required": ["amount", "reason"],
        },
    },
    {
        "name": "mnemopay_settle",
        "description": (
            "Finalize a pending escrow. Moves funds to wallet, boosts "
            "reputation +0.01, reinforces recently-accessed memories +0.05."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "txId": {"type": "string", "description": "Transaction ID from charge"},
            },
            "required": ["txId"],
        },
    },
    {
        "name": "mnemopay_refund",
        "description": (
            "Refund a transaction. If already settled, withdraws funds and "
            "docks reputation by -0.05."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "txId": {"type": "string", "description": "Transaction ID to refund"},
            },
            "required": ["txId"],
        },
    },
    {
        "name": "mnemopay_balance",
        "description": "Check wallet balance and reputation score.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "mnemopay_profile",
        "description": "Full agent stats: reputation, wallet, memory count, transaction count.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "mnemopay_logs",
        "description": "Immutable audit trail of all memory and payment actions.",
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "default": 20,
                    "description": "Number of entries",
                },
            },
        },
    },
    {
        "name": "mnemopay_history",
        "description": "Transaction history, most recent first.",
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "default": 10,
                    "description": "Number of transactions",
                },
            },
        },
    },
]
