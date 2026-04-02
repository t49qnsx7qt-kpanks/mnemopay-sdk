"""
MnemoPay tool handlers + Hermes hooks.

This plugin wraps the MnemoPay MCP server as native Hermes tools and uses
the pre_llm_call hook to inject recalled memories into every LLM prompt.
"""

from __future__ import annotations

import json
import logging
import subprocess
import asyncio
from typing import Any

from .schemas import TOOLS

logger = logging.getLogger("mnemopay")

# ── MCP Client ──────────────────────────────────────────────────────────────
# Communicates with the MnemoPay MCP server via stdio JSON-RPC.


class MnemoPayMCPClient:
    """Lightweight MCP client that spawns the MnemoPay server as a subprocess."""

    def __init__(self, env: dict[str, str] | None = None):
        self._proc: subprocess.Popen | None = None
        self._env = env or {}
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def ensure_started(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        import os

        merged_env = {**os.environ, **self._env}
        self._proc = subprocess.Popen(
            ["npx", "-y", "@mnemopay/sdk"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=merged_env,
        )
        # Wait for server to be ready (read initial messages)
        await asyncio.sleep(1)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        """Send a tools/call JSON-RPC request and return the text result."""
        async with self._lock:
            await self.ensure_started()
            assert self._proc and self._proc.stdin and self._proc.stdout

            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }

            line = json.dumps(request) + "\n"
            self._proc.stdin.write(line.encode())
            self._proc.stdin.flush()

            # Read response line
            raw = self._proc.stdout.readline()
            if not raw:
                return "Error: MCP server closed connection"

            try:
                response = json.loads(raw.decode())
                result = response.get("result", {})
                content = result.get("content", [])
                if content and isinstance(content, list):
                    return content[0].get("text", str(content))
                return str(result)
            except (json.JSONDecodeError, KeyError) as e:
                return f"Error parsing MCP response: {e}"

    def shutdown(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            self._proc.wait(timeout=5)


# ── Global client ───────────────────────────────────────────────────────────

_client: MnemoPayMCPClient | None = None


def _get_client(env: dict[str, str] | None = None) -> MnemoPayMCPClient:
    global _client
    if _client is None:
        _client = MnemoPayMCPClient(env)
    return _client


# ── Tool name mapping ───────────────────────────────────────────────────────
# Hermes tool names use underscores; MCP server uses bare names.

_HERMES_TO_MCP = {
    "mnemopay_remember": "remember",
    "mnemopay_recall": "recall",
    "mnemopay_forget": "forget",
    "mnemopay_reinforce": "reinforce",
    "mnemopay_consolidate": "consolidate",
    "mnemopay_charge": "charge",
    "mnemopay_settle": "settle",
    "mnemopay_refund": "refund",
    "mnemopay_balance": "balance",
    "mnemopay_profile": "profile",
    "mnemopay_logs": "logs",
    "mnemopay_history": "history",
}


# ── Tool handler ────────────────────────────────────────────────────────────


async def handle_tool(name: str, args: dict[str, Any], ctx: Any) -> str:
    """Route a Hermes tool call to the MnemoPay MCP server."""
    mcp_name = _HERMES_TO_MCP.get(name)
    if not mcp_name:
        return f"Unknown MnemoPay tool: {name}"

    client = _get_client()
    try:
        return await client.call_tool(mcp_name, args)
    except Exception as e:
        logger.error("MnemoPay tool %s failed: %s", name, e)
        return f"Error: {e}"


# ── Hooks ───────────────────────────────────────────────────────────────────


async def on_session_start(ctx: Any) -> None:
    """Recall top memories at session start and log them."""
    client = _get_client()
    try:
        result = await client.call_tool("recall", {"limit": 5})
        if result and result != "No memories found.":
            logger.info("Session start — recalled memories:\n%s", result)
            # Store in context for pre_llm_call to use
            if hasattr(ctx, "session_data"):
                ctx.session_data["mnemopay_startup_memories"] = result
    except Exception as e:
        logger.warning("Failed to recall memories at session start: %s", e)


async def pre_llm_call(messages: list[dict], ctx: Any) -> list[dict]:
    """
    Inject recalled memories into the system prompt before every LLM call.

    This is the core hook — it ensures the agent always has relevant
    context from past sessions available when reasoning.
    """
    client = _get_client()

    # Extract the user's latest message for semantic search
    user_query = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                user_query = content[:200]  # Truncate for search
            break

    if not user_query:
        return messages

    try:
        result = await client.call_tool("recall", {"query": user_query, "limit": 5})
        if not result or result == "No memories found.":
            return messages
    except Exception:
        return messages

    # Inject memories into the system message
    memory_block = (
        "\n\n## MnemoPay Recalled Memories\n"
        "The following memories from past sessions may be relevant:\n\n"
        f"{result}\n\n"
        "Use these memories to provide context-aware responses. "
        "If a memory leads to a successful outcome, reinforce it with mnemopay_reinforce."
    )

    # Find or create system message
    if messages and messages[0].get("role") == "system":
        messages[0]["content"] = messages[0].get("content", "") + memory_block
    else:
        messages.insert(0, {"role": "system", "content": memory_block})

    return messages


async def on_session_end(ctx: Any) -> None:
    """Clean shutdown of MCP client."""
    global _client
    if _client:
        _client.shutdown()
        _client = None


async def post_tool_call(name: str, result: str, ctx: Any) -> None:
    """After any tool call, remember significant outcomes."""
    # Only auto-remember results from non-MnemoPay tools
    if name.startswith("mnemopay_"):
        return

    # If the result looks significant (>100 chars), store a condensed memory
    if len(result) > 100:
        client = _get_client()
        summary = f"Tool '{name}' returned: {result[:300]}"
        try:
            await client.call_tool(
                "remember",
                {"content": summary, "importance": 0.3, "tags": ["auto", "tool-result"]},
            )
        except Exception:
            pass  # Non-critical, don't break the session


# ── Registration ────────────────────────────────────────────────────────────


def register(ctx: Any) -> None:
    """
    Called by Hermes on plugin load.
    Registers all 12 MnemoPay tools and 4 lifecycle hooks.
    """
    # Register tools
    for schema in TOOLS:
        ctx.register_tool(
            name=schema["name"],
            description=schema["description"],
            parameters=schema["parameters"],
            handler=handle_tool,
        )

    # Register hooks
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("post_tool_call", post_tool_call)

    logger.info(
        "MnemoPay plugin loaded: 12 tools + 4 hooks (memory injection active)"
    )
