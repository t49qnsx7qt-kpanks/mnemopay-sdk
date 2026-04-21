# mnemopay-sdk status — 2026-04-17

## Shipped today
- Neon persistence adapter (pgvector + HNSW auto-bootstrap) → `src/recall/persistence/neon.ts`
- Memory adapter + PersistenceAdapter interface → `src/recall/persistence/{memory,types}.ts`
- `MnemoPay.quick(id, { persist: { type: "neon", url } })` wired into engine
- 11/11 persistence parity tests → `tests/persistence.spec.ts` (771/773 overall; 2 pre-existing flakes unrelated)
- FU2 breakup emails: 13/13 sent (was blocked by stale-env bug in loadEnv)
- Bug class fix: `marketing/email-followup.js` + `marketing/linkedin-auth.js` loadEnv no longer guards on pre-existing env vars
- Dev.to weekly cron → `marketing/cron-devto.js` (idempotent, queue-based)
- Windows Task Scheduler: `MnemoPayDailyMarketing` daily 9:05 AM → runs `schedule-daily.bat`
- Karpathy work pattern added to CLAUDE.md + reusable snippet at `docs/CLAUDE-WORK-PATTERN.md`
- Maileroo key added to `.env` (MAILEROO_API_KEY + MAILEROO_FROM + MAILEROO_API_URL)
- **Playground deployed:** https://mnemopay-playground.fly.dev/ — Fly.io shared-cpu-1x, auto-stop on idle, /healthz returns 200
- **YouTube Shorts scheduled (all 4 uploaded, spaced 24h):**
  - AgentsMoney → https://youtube.com/shorts/23UFYfLhteo (publish 2026-04-18 19:00 UTC)
  - MemoryComparison → https://youtube.com/shorts/j0Xj7qWYOMw (publish 2026-04-19 19:00 UTC)
  - VoxCoreDemo → https://youtube.com/shorts/bi4SQ9qBa18 (publish 2026-04-21 19:00 UTC)
  - AfricaRideHailing → https://youtube.com/shorts/sJED3nAwuGA (publish 2026-04-22 19:00 UTC)
- AfricaRideHailing composition added + rendered (`src/Root.tsx`)
- Batch uploader → `dele-video/scripts/upload-all-pending.py` (24h spacing, resumable)

## Also shipped today
- `docs/pitch/investor-deck.md` — 12-slide seed deck, speaker notes included
- `docs/pitch/one-pager.md` — single-page investor leave-behind
- `docs/pitch/eu-ai-act-pitch.md` — 6-slide compliance pitch + cold email template for 6 verified prospects
- `docs/pitch/claude-design-prompts.md` — 5 paste-ready prompts for Claude Design (deck, one-pager, EU pitch, hero, social cards)
- `playground/` — Express + static HTML live demo (`npm install`, `npm start`), abuse controls wired, Neon-aware

## Also shipped today (late batch)
- **EU AI Act cold send** → `marketing/send-eu-ai-act.js` (Maileroo primary, Resend fallback, idempotent via `data/eu-ai-act-sent.json`)
  - 7 verified prospects: Saidot (x2), trail-ml, DataGuard, Pleias, FlixBus data protection, Mistral legal
  - Per-prospect opener personalization, HTML + plaintext parts, auto-registers into drip-log for Day-3/Day-7 follow-ups
  - Dry-run verified
- **Windows Task Scheduler:** `MnemoPayEUAIActMonday` ONCE on 2026-04-20 09:00 CT → runs the EU AI Act send + appends to `marketing/logs/eu-ai-act.log`
- **Linux Foundation reply draft** → `docs/pitch/linux-foundation-reply.md` (cordial/warm, technical brief, cc Matt White; flags "verify Christina address from thread" before sending)
- **Neon adapter scope decision:** Mobile SDK stays on SQLite (offline-first by design, `sqlite-vec`); GridStamp's ElephantMemory already wraps MnemoPay SDK so it inherits the Neon persistence layer for free. No new adapters needed; spatial memory stays local by design.

## In progress
- WeMeetWeMet production hardening for 2026-04-20 Apple submit (subagent running: 8 blockers, audit put readiness at ~20%)

## Blocked
- LinkedIn production posting: app verification pending
- CLARA proposal: dropped per 2026-04-17 decision
- AAIF next step: waiting on Matt White reply (memory rule: do NOT cold-follow-up; draft is pre-staged)

## Next session
- First `MnemoPayDailyMarketing` scheduled run tomorrow 9:05 AM → verify `marketing/logs/daily.log`
- Monday 09:00 CT: `MnemoPayEUAIActMonday` fires → verify sends in `marketing/logs/eu-ai-act.log` + `data/eu-ai-act-sent.json`
- Paste Claude Design prompts into Anthropic Labs → export PDFs to `docs/pitch/rendered/`
- WeMeetWeMet: complete whatever the subagent couldn't finish autonomously (screenshots, EAS credentials, App Store Connect record, TestFlight build)
- Decide concentration vs breadth: EU AI Act wedge or MCP author wedge for week of 04-20
