# Changelog

All notable changes to `@mnemopay/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [1.3.1] — 2026-04-16

### Security

- `cli/dashboard.ts`: `child_process.exec` → `execFile` so the
  browser-open URL can't be interpreted as shell input. Eliminates a command
  injection vector on any env that hands a user-controlled dashboard URL to
  the CLI.
- `commerce/checkout/executor.ts`: screenshot filenames are sanitized
  (`/`, `\`, `.` → `_`) before being written. Prevents path traversal when a
  caller passes an attacker-controlled name.
- `fraud.ts`, `fraud-ml.ts`: all `deserialize()` paths now validate JSON
  shape + cap array sizes (edges ≤100k, agentStats ≤50k, trees ≤500, ips
  per agent ≤1k, etc.) before populating Maps/Sets. Silent `catch {}` blocks
  replaced with logged errors so persistence corruption is observable.
- `mcp/server.ts webhook_register`: webhook URLs now require `https://` and
  reject private/link-local hosts (`localhost`, `127.*`, `10.*`, `192.168.*`,
  `169.254.*`, `::1`). Closes an SSRF hole where a registered webhook could
  be used to probe the local network.
- `mcp/server.ts startServer`: `PORTAL_URL` is validated at boot; a non-HTTPS
  value in production exits immediately instead of silently downgrading portal
  auth.
- `MnemoPayLite` persistence: removed dead-code path that double-deserialized
  `fraudGuard` and partially mutated the existing guard before replacing it.
  Restore is now a single atomic assignment.

### Removed

- `from-source` dependency (was pulled in transitively, no longer needed).

## [1.3.0] — 2026-04-15

### Breaking

- **MCP server default tool group is now `essentials` (not `all`).** Running
  `npx @mnemopay/sdk` or `npx @mnemopay/mcp-server` without a `--tools` flag now
  exposes 14 tools (~1K tokens of context) instead of 40 tools (~3.8K tokens).
  This makes MnemoPay one of the lightest MCP servers a user can install —
  most agent workloads only need memory + wallet + tx, and paying 3.8K tokens
  of tool schemas on every turn for unused commerce/webhook/security surface
  area was the single biggest complaint from early adopters.

  **`essentials` includes:**
  - `memory`: `remember`, `recall`, `forget`, `reinforce`, `consolidate`
  - `wallet`: `balance`, `profile`, `history`, `logs`
  - `tx`: `charge`, `settle`, `refund`, `dispute`, `receipt_get`

  **To restore the previous behavior** (all 40 tools), pass `--tools=all` or
  set `MNEMOPAY_TOOLS=all`:

  ```bash
  npx @mnemopay/sdk --tools=all
  # or in claude_desktop_config.json / mcp.json:
  { "mnemopay": { "command": "npx", "args": ["-y", "@mnemopay/sdk", "--tools=all"] } }
  # or via env:
  MNEMOPAY_TOOLS=all npx @mnemopay/sdk
  ```

  **Other presets:**
  - `--tools=agent` — essentials + commerce + hitl + payments + webhooks (agent workloads)
  - `--tools=memory,wallet` — mix-and-match individual groups by name
  - `--tools=fico,security` — FICO scoring + integrity tooling only

  Available groups: `memory`, `wallet`, `tx`, `commerce`, `hitl`, `payments`,
  `webhooks`, `fico`, `security`. Aliases: `essentials`, `agent`, `all`.

### Why the default changed

Context is the scarcest resource in an agent loop. Every tool schema MnemoPay
registers is a token the model pays on every turn, whether the tool is called
or not. At 40 tools MnemoPay was a tax on context budgets; at 14 it's
negligible. Users who need the full surface can opt in explicitly — but
defaulting to "everything" punished the 80% of installs that just want memory
and a wallet.

### Migration

| Previous behavior                       | v1.3.0 equivalent                |
|-----------------------------------------|----------------------------------|
| `npx @mnemopay/sdk`                     | `npx @mnemopay/sdk --tools=all`  |
| Using `commerce`/`hitl` tools by default | Add `--tools=agent`              |
| Using `webhook_register` by default     | Add `--tools=essentials,webhooks`|

No SDK API changes. TypeScript types, middleware, and REST client are
untouched. This release only rescopes the MCP server's default tool
exposure.

---

## [1.2.0] — prior

Agent FICO (300–850), Merkle integrity, behavioral finance, EWMA anomaly
detection, canary honeypots, HMAC-SHA256 signing, full payment rails
(Stripe / Paystack / Lightning), autonomous shopping with escrow, HITL
approval, 716 tests.
