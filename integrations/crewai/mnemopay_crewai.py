"""
MnemoPay tools for CrewAI.

Give any CrewAI crew persistent cognitive memory and micropayment capabilities
via the MnemoPay MCP server.

Usage:
    from mnemopay_crewai import mnemopay_tools

    agent = Agent(
        role="Research Assistant",
        tools=mnemopay_tools(),
    )

Or connect to a remote MnemoPay server:
    tools = mnemopay_tools(server_url="https://mnemopay-mcp.fly.dev")
"""

import json
import subprocess
import sys
from typing import Optional

from crewai.tools import BaseTool
from pydantic import BaseModel, Field


class MCPClient:
    """Lightweight MCP client that communicates via stdio JSON-RPC."""

    def __init__(self, server_url: Optional[str] = None):
        self.server_url = server_url
        self._process = None
        self._request_id = 0

    def _ensure_started(self):
        if self._process is not None and self._process.poll() is None:
            return
        self._process = subprocess.Popen(
            [sys.executable, "-c",
             "import subprocess; subprocess.run(['node', '-e', "
             "'require(\"@mnemopay/sdk/mcp\").startServer()'], check=True)"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def call_tool(self, name: str, arguments: dict) -> str:
        """Call an MCP tool and return the result as a string."""
        if self.server_url:
            return self._call_http(name, arguments)
        return self._call_stdio(name, arguments)

    def _call_http(self, name: str, arguments: dict) -> str:
        import urllib.request
        import urllib.error

        # Establish SSE session
        try:
            req = urllib.request.Request(
                f"{self.server_url}/mcp",
                method="GET",
            )
            # For HTTP mode, use a simple POST to messages endpoint
            # First get session via SSE, then post
            data = json.dumps({
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }).encode()
            req = urllib.request.Request(
                f"{self.server_url}/messages",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode())
                if "result" in result:
                    content = result["result"].get("content", [])
                    return content[0].get("text", str(content)) if content else "OK"
                if "error" in result:
                    return f"Error: {result['error'].get('message', str(result['error']))}"
                return str(result)
        except Exception as e:
            return f"MCP call failed: {e}"

    def _call_stdio(self, name: str, arguments: dict) -> str:
        self._ensure_started()
        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        try:
            self._process.stdin.write(json.dumps(request).encode() + b"\n")
            self._process.stdin.flush()
            line = self._process.stdout.readline()
            result = json.loads(line)
            if "result" in result:
                content = result["result"].get("content", [])
                return content[0].get("text", str(content)) if content else "OK"
            return str(result)
        except Exception as e:
            return f"MCP call failed: {e}"

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def close(self):
        if self._process and self._process.poll() is None:
            self._process.terminate()


# Shared client instance
_client: Optional[MCPClient] = None


def _get_client(server_url: Optional[str] = None) -> MCPClient:
    global _client
    if _client is None:
        _client = MCPClient(server_url)
    return _client


# ─── Tool Input Schemas ──────────────────────────────────────────────────────

class RememberInput(BaseModel):
    content: str = Field(description="What to remember")
    importance: Optional[float] = Field(None, ge=0, le=1, description="Importance 0-1")

class RecallInput(BaseModel):
    query: Optional[str] = Field(None, description="Semantic search query")
    limit: int = Field(5, ge=1, le=50, description="Number of memories")

class ForgetInput(BaseModel):
    id: str = Field(description="Memory ID to delete")

class ReinforceInput(BaseModel):
    id: str = Field(description="Memory ID to reinforce")
    boost: float = Field(0.1, ge=0.01, le=0.5, description="Importance boost")

class ChargeInput(BaseModel):
    amount: float = Field(ge=0.01, le=500, description="Amount in USD")
    reason: str = Field(min_length=5, description="Value delivered")

class SettleInput(BaseModel):
    txId: str = Field(description="Transaction ID")

class RefundInput(BaseModel):
    txId: str = Field(description="Transaction ID")

class EmptyInput(BaseModel):
    pass


# ─── CrewAI Tools ─────────────────────────────────────────────────────────────

class RememberTool(BaseTool):
    name: str = "remember"
    description: str = "Store a memory that persists across sessions. Use for facts, preferences, decisions."
    args_schema: type[BaseModel] = RememberInput

    def _run(self, content: str, importance: Optional[float] = None) -> str:
        args = {"content": content}
        if importance is not None:
            args["importance"] = importance
        return _get_client().call_tool("remember", args)


class RecallTool(BaseTool):
    name: str = "recall"
    description: str = "Recall relevant memories. Supports semantic search with a query."
    args_schema: type[BaseModel] = RecallInput

    def _run(self, query: Optional[str] = None, limit: int = 5) -> str:
        args = {"limit": limit}
        if query:
            args["query"] = query
        return _get_client().call_tool("recall", args)


class ForgetTool(BaseTool):
    name: str = "forget"
    description: str = "Permanently delete a memory by ID."
    args_schema: type[BaseModel] = ForgetInput

    def _run(self, id: str) -> str:
        return _get_client().call_tool("forget", {"id": id})


class ReinforceTool(BaseTool):
    name: str = "reinforce"
    description: str = "Boost a memory's importance after it proved valuable."
    args_schema: type[BaseModel] = ReinforceInput

    def _run(self, id: str, boost: float = 0.1) -> str:
        return _get_client().call_tool("reinforce", {"id": id, "boost": boost})


class ConsolidateTool(BaseTool):
    name: str = "consolidate"
    description: str = "Prune stale memories whose scores have decayed below threshold."
    args_schema: type[BaseModel] = EmptyInput

    def _run(self) -> str:
        return _get_client().call_tool("consolidate", {})


class ChargeTool(BaseTool):
    name: str = "charge"
    description: str = "Create an escrow charge for work delivered. Only charge AFTER delivering value."
    args_schema: type[BaseModel] = ChargeInput

    def _run(self, amount: float, reason: str) -> str:
        return _get_client().call_tool("charge", {"amount": amount, "reason": reason})


class SettleTool(BaseTool):
    name: str = "settle"
    description: str = "Finalize a pending escrow. Boosts reputation and reinforces recent memories."
    args_schema: type[BaseModel] = SettleInput

    def _run(self, txId: str) -> str:
        return _get_client().call_tool("settle", {"txId": txId})


class RefundTool(BaseTool):
    name: str = "refund"
    description: str = "Refund a transaction. Docks reputation by -0.05."
    args_schema: type[BaseModel] = RefundInput

    def _run(self, txId: str) -> str:
        return _get_client().call_tool("refund", {"txId": txId})


class BalanceTool(BaseTool):
    name: str = "balance"
    description: str = "Check wallet balance and reputation score."
    args_schema: type[BaseModel] = EmptyInput

    def _run(self) -> str:
        return _get_client().call_tool("balance", {})


class ProfileTool(BaseTool):
    name: str = "profile"
    description: str = "Full agent stats: reputation, wallet, memory count, transaction count."
    args_schema: type[BaseModel] = EmptyInput

    def _run(self) -> str:
        return _get_client().call_tool("profile", {})


class ReputationTool(BaseTool):
    name: str = "reputation"
    description: str = "Full reputation report: score, tier, settlement rate, total value. Proves trustworthiness."
    args_schema: type[BaseModel] = EmptyInput

    def _run(self) -> str:
        return _get_client().call_tool("reputation", {})


class LogsTool(BaseTool):
    name: str = "logs"
    description: str = "Immutable audit trail of all memory and payment actions."
    args_schema: type[BaseModel] = EmptyInput

    def _run(self) -> str:
        return _get_client().call_tool("logs", {"limit": 20})


class HistoryTool(BaseTool):
    name: str = "history"
    description: str = "Transaction history, most recent first."
    args_schema: type[BaseModel] = EmptyInput

    def _run(self) -> str:
        return _get_client().call_tool("history", {"limit": 10})


# ─── Convenience function ────────────────────────────────────────────────────

def mnemopay_tools(server_url: Optional[str] = None) -> list:
    """
    Returns all 13 MnemoPay tools ready for CrewAI agents.

    Args:
        server_url: Optional MnemoPay server URL (e.g. "https://mnemopay-mcp.fly.dev").
                    If not provided, spawns a local MCP server via stdio.
    """
    global _client
    _client = MCPClient(server_url)

    return [
        RememberTool(),
        RecallTool(),
        ForgetTool(),
        ReinforceTool(),
        ConsolidateTool(),
        ChargeTool(),
        SettleTool(),
        RefundTool(),
        BalanceTool(),
        ProfileTool(),
        ReputationTool(),
        LogsTool(),
        HistoryTool(),
    ]
