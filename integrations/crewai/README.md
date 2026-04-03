# MnemoPay for CrewAI

Give any CrewAI crew persistent cognitive memory and micropayment capabilities.

## Install

```bash
pip install mnemopay-crewai
```

## Usage

```python
from crewai import Agent, Crew, Task
from mnemopay_crewai import mnemopay_tools

# Local MCP server (spawns automatically)
tools = mnemopay_tools()

# Or connect to remote server
tools = mnemopay_tools(server_url="https://mnemopay-mcp.fly.dev")

agent = Agent(
    role="Research Assistant",
    goal="Help users with research and remember findings across sessions",
    tools=tools,
)

task = Task(
    description="Research AI agent infrastructure and remember key findings",
    agent=agent,
)

crew = Crew(agents=[agent], tasks=[task])
crew.kickoff()
```

## Tools (13)

### Memory
- **remember** — Store a memory (auto-scored importance)
- **recall** — Semantic search over memories
- **forget** — Delete a memory by ID
- **reinforce** — Boost memory importance after positive outcome
- **consolidate** — Prune stale memories

### Payments
- **charge** — Create escrow for value delivered
- **settle** — Finalize payment (boosts reputation, reinforces memories)
- **refund** — Refund transaction (docks reputation)
- **balance** — Check wallet and reputation

### Observability
- **profile** — Full agent stats
- **reputation** — Detailed reputation report with tier and settlement rate
- **logs** — Audit trail
- **history** — Transaction history

## License

MIT
