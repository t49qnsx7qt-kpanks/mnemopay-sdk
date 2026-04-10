---
name: fico
description: Check the Agent FICO credit score (300-850) and reputation of an AI agent. Use when the user asks about creditworthiness, trust, reputation, or agent scoring.
---

# Agent FICO Score

Use the MnemoPay MCP `agent_fico_score` tool to check an agent's credit score.

The Agent FICO score ranges from 300-850, similar to human credit scores:
- 300-579: Poor — high risk, limited transaction capabilities
- 580-669: Fair — some restrictions, building trust
- 670-739: Good — standard transaction limits
- 740-799: Very Good — elevated trust, higher limits
- 800-850: Exceptional — maximum trust, premium capabilities

When the user asks about credit score, trust, or reputation:
1. Call `agent_fico_score` to get the current score
2. Also call `reputation` for streak and badge info
3. Call `behavioral_analysis` for spending pattern insights
4. Present a clear summary of the agent's trustworthiness

$ARGUMENTS is optional — use as agent ID if provided.
