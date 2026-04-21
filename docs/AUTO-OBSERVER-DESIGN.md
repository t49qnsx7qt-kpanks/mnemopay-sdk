# Auto-Observer Middleware — Design Note

**Status:** Proposed
**Created:** 2026-04-18
**Trigger:** Session 2026-04-18 shipped three production sites (wemetwmeet, bizsuite-site, mnemopay.com) with zero `remember()` calls. Full context was lost between sessions and had to be reconstructed from git + Fly release history.

## Problem

The SDK exposes `remember(content, {importance, tags})` as an explicit write. Agents that forget to call it leave no trace. Transactions (`charge`, `settle`, `refund`) are safe because the write IS the operation — but *narrative* memory is not.

`onSessionEnd(summary)` exists (`src/index.ts:1560`) but still requires the caller to pass a summary string. If the caller crashes, closes abruptly, or just forgets, nothing is saved.

## Proposal

A passive observer layer that writes low-importance memories on significant agent actions — without the agent having to call `remember()`.

### Triggers (opt-in via config)

- **Tool-call observer:** every Nth MCP tool call (default: every 10), write a rolling summary of the last N calls as one memory. Importance 0.3.
- **File-write observer:** for agent harnesses that expose file-write events (Claude Code, Cursor), write one memory per burst of N file writes in T seconds. Importance 0.4.
- **Ledger observer:** after every `charge`, `settle`, `refund`, `payout`, auto-write a memory summarizing the transaction (counter-party, amount, purpose if present). Importance 0.5. De-dup against the ledger row — this is context, not state.
- **Session-heartbeat:** if no memory has been written for T minutes (default 30), auto-write a heartbeat memory containing the last tool calls + timestamps. Importance 0.2.

### API sketch

```ts
const mp = new MnemoPay({
  apiKey: process.env.MNEMOPAY_API_KEY,
  observer: {
    enabled: true,
    toolCallEvery: 10,
    fileWriteBurst: { count: 5, windowSec: 60 },
    heartbeatMinutes: 30,
    ledgerEvents: true,
  },
});

// Wrap any tool call to feed the observer:
await mp.observer.record({ kind: "tool-call", name: "WebFetch", args: {...} });
```

For MCP: the MCP server (`src/mcp/server.ts`) intercepts every tool call and feeds the observer automatically. Zero wiring for the agent.

### Storage cost guardrails

- All auto-observer memories tagged `auto-observer`.
- `consolidate()` should down-weight or collapse these into a single daily summary after 24h.
- Hard cap: N auto-observer memories per hour (default 12). Overage is silently dropped.
- Configurable off by default for Free tier (cost); on by default for Pro/Enterprise.

### Failure mode

Observer writes must be fire-and-forget (`.catch(() => {})`). If the observer fails, the agent's actual work is never blocked. Same pattern as GridStamp's elephant memory hooks.

## What this does NOT fix

- An agent that writes *bad* memories (wrong importance, noise). Observer can't judge quality — that's still the agent's job for the important stuff.
- Cross-agent memory (agent A's observer doesn't know about agent B). Observer is per-agent by design; cross-agent consolidation is a separate problem.

## Implementation checklist

- [ ] `src/observer/index.ts` — Observer class, ring buffer, heartbeat timer
- [ ] Integration point in `src/index.ts` MnemoPay constructor
- [ ] Integration point in `src/mcp/server.ts` around tool dispatch
- [ ] Integration points in ledger ops (`charge`, `settle`, `refund`, `payout`)
- [ ] Tests — observer fires at expected intervals, respects cap, fails silent
- [ ] `consolidate()` update — collapse `auto-observer` tagged memories older than 24h
- [ ] Changelog entry, version bump (v1.0.0-beta.2 or v1.0.0-rc.1)

## Estimated scope

~1 day focused work. Small surface, well-defined. Ship before any more multi-site sessions.
