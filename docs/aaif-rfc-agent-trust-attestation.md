# RFC: Agent Trust Attestation Protocol (ATAP)

**Status:** Draft
**Author:** Jerry Omiagbo (MnemoPay)
**Target:** AAIF (Agentic AI Interoperability Foundation)
**Date:** April 2026

## Abstract

This RFC proposes Agent Trust Attestation Protocol (ATAP), a standard for AI agents to communicate trust scores, payment history, and behavioral reputation across frameworks and platforms. ATAP builds on MCP (Model Context Protocol) for transport and introduces a trust attestation layer that any agent framework can query before engaging in transactions or delegating tasks.

## Motivation

The AI agent ecosystem has payment protocols (x402, Lightning L402, Stripe MPP) and communication protocols (MCP, A2A, A2A-T). What's missing is a **trust layer** — a standard way for agents to answer:

- "Should I trust this agent with my task?"
- "Has this agent delivered value before?"
- "What's this agent's fraud risk?"

Without trust attestation, every agent-to-agent interaction starts from zero. This is inefficient, fraud-prone, and prevents the emergence of reliable agent marketplaces.

## Prior Art

| Protocol | What it solves | What's missing |
|----------|---------------|----------------|
| MCP | Tool communication | No trust model |
| x402 | HTTP-native payments | No memory, no reputation |
| A2A (Google) | Enterprise agent collaboration | No payment trust |
| A2A-T (Huawei) | Telecom agent orchestration | No cross-domain trust portability |
| Lightning L402 | Pay-per-request | No learning from outcomes |
| Stripe MPP | Machine payments | No decentralized trust |

ATAP fills the gap between communication and payment by providing the trust layer that makes both more reliable.

## Specification

### 1. Trust Attestation Object

```json
{
  "atap_version": "1.0",
  "agent_id": "agent-xyz",
  "attestation": {
    "reputation": 0.87,
    "tier": "trusted",
    "total_settlements": 142,
    "total_value_settled": 4250.00,
    "settlement_rate": 0.96,
    "dispute_rate": 0.02,
    "memory_count": 1847,
    "first_seen": "2026-01-15T00:00:00Z",
    "last_active": "2026-04-03T14:30:00Z"
  },
  "fraud_signals": {
    "risk_level": "low",
    "risk_score": 0.12,
    "flags": []
  },
  "signature": "base64-encoded-signature",
  "issued_by": "mnemopay-attestation-server",
  "issued_at": "2026-04-03T14:30:00Z",
  "expires_at": "2026-04-03T15:30:00Z"
}
```

### 2. MCP Resource Endpoint

Any MCP server implementing ATAP exposes a trust resource:

```
Resource URI: atap://{agent_id}/attestation
```

Querying this resource returns the Trust Attestation Object for the specified agent.

### 3. Trust Query Flow

```
Agent A wants to delegate task to Agent B:

1. Agent A queries: atap://agent-b/attestation
2. ATAP server returns Agent B's trust attestation
3. Agent A evaluates:
   - reputation >= minimum threshold?
   - settlement_rate acceptable?
   - risk_level within tolerance?
4. If trusted: proceed with task delegation
5. If untrusted: request escrow, reduce scope, or decline
```

### 4. Trust Accumulation

Trust is earned through the **payment-memory feedback loop**:

```
Agent delivers value → charge() → settle()
  → reputation += 0.01
  → memories reinforced += 0.05
  → attestation updated
  → next interaction: higher trust, higher limits
```

### 5. Cross-Platform Portability

ATAP attestations are portable across:
- MCP hosts (Claude, Goose, Cursor, custom)
- Payment protocols (x402, Lightning, Stripe MPP)
- Agent frameworks (CrewAI, AutoGen, LangGraph, AgentArts)

An agent's reputation earned in Goose is queryable from AgentArts. Trust is not siloed.

### 6. Fraud Signal Standard

ATAP standardizes fraud signals so platforms can share threat intelligence:

```json
{
  "signal": "velocity_exceeded",
  "severity": "medium",
  "details": "15 charges in 10 minutes",
  "timestamp": "2026-04-03T14:25:00Z"
}
```

Signal types: `velocity_exceeded`, `amount_anomaly`, `reputation_low`, `escalation_pattern`, `ip_hopping`, `rapid_cycle`, `pending_overflow`, `ml_anomaly`, `behavioral_drift`, `wash_trading`, `sybil_cluster`

## Security Considerations

- Attestations are signed and time-limited (1 hour default)
- Trust scores cannot be self-reported — must come from an attestation server
- Reputation penalties (refunds, disputes) are irreversible
- Fraud signals are append-only (tamper-evident log)

## Compatibility

ATAP is designed to work alongside, not replace:
- **MCP:** ATAP extends MCP with a trust resource type
- **x402:** ATAP attestations can gate x402 payment amounts
- **A2A-T:** ATAP provides the trust model for A2A-T's Registry Center
- **AAIF standards:** ATAP fits beneath AP2, UCP as the trust foundation

## Reference Implementation

MnemoPay SDK v0.4.1 implements a complete ATAP-compatible trust system:
- Bayesian reputation scoring
- 10-signal fraud detection pipeline
- ML-grade anomaly detection (optional)
- Payment-memory feedback loop
- MCP resources for trust queries

## Next Steps

1. Submit as AAIF RFC for community review
2. Implement reference attestation server
3. Propose integration with x402 and Stripe MPP
4. Partner with Lightning Labs for L402 + ATAP bridge
5. Collaborate with Huawei on A2A-T Registry Center integration
