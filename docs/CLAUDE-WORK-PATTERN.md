# Work Pattern (reusable)

Paste this block into any repo's `CLAUDE.md` to install the research → build → automate discipline. Jerry wants this across every project.

---

## Work Pattern (Karpathy-style: research → build → automate)

Before every non-trivial task, spend 10 min on research, then build, then automate one adjacent thing.

1. **Research first.** Check what exists: existing code in this repo (Grep/Read), prior session memory, competitor patterns, npm packages, recent papers or tweets. If the user asks for X, first verify X doesn't already exist here. If it does, extend it instead of rebuilding.
2. **Build the minimum.** Ship the smallest useful version. No speculative abstractions, no future-proofing, no "while I'm here" refactors.
3. **Automate one adjacent thing.** Every manual task you just did — turn it into a cron, a script, a test, or a note in `status.md`. Do not ship the same manual task twice.
4. **Verify before claiming done.** Run tests. For UI, actually load it. For marketing scripts, dry-run before live-run. "Tests pass" ≠ "it works."
5. **Update memory.** Non-obvious facts (vendor tier changes, bug classes, API quirks) go to `~/.claude/projects/C--WINDOWS-system32/memory/`.

Checklist before marking a task complete:
- [ ] I grepped the repo for prior art.
- [ ] I ran the tests that cover what I changed.
- [ ] I removed the hardest manual step from this task for next time (or noted why I can't).
- [ ] `status.md` reflects what shipped and what's still open.

## status.md convention

Every repo root gets a `status.md`. It's the first file read at session start and the last file updated at session end.

```markdown
# <repo> status — <YYYY-MM-DD>

## Shipped today
- <one line per thing that's live/merged/deployed>

## In progress
- <what's mid-flight; include file paths>

## Blocked
- <what's waiting; on whom/what; since when>

## Next session
- <concrete next action, not a goal>
```

Rules:
- Keep under 60 lines. Archive older entries to `status-archive.md`.
- "Shipped today" means deployed/merged/sent, not just committed.
- "Blocked" must name the dependency (person, API limit, missing asset) and the date it started blocking.
- "Next session" is a command or file path, not a theme.
