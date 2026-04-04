#!/usr/bin/env node
/**
 * npx @mnemopay/sdk setup
 *
 * Auto-configures Claude Code hooks for MnemoPay session lifecycle:
 *   - Stop hook: blocks exit once, prompts Claude to save session summary
 *   - UserPromptSubmit hook: injects recall reminder on each message
 *
 * Works on Windows, macOS, and Linux.
 */

import fs from "fs";
import path from "path";
import os from "os";

const STOP_HOOK_CONTENT = `#!/bin/bash
MARKER="$HOME/.claude/hooks/.mnemo-stop"

if [ ! -f "$MARKER" ]; then
    touch "$MARKER"
    printf '{"decision":"block","reason":"Before stopping: call mcp__mnemopay__remember with a concise summary of this session (what was accomplished, decisions made, follow-up needed). Use importance 0.85 and tags [\\"session-summary\\"]."}\n'
else
    rm "$MARKER"
    printf '{}\n'
fi
`;

const USER_PROMPT_HOOK_COMMAND =
  `bash -c "echo '{\\"systemMessage\\":\\"You have persistent memory via MnemoPay MCP. ` +
  `If this is the start of a new topic or session, call mcp__mnemopay__recall to load relevant context. ` +
  `Store any important new facts or decisions with mcp__mnemopay__remember.\\"}'"\n`.trimEnd();

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function err(msg: string) {
  process.stderr.write("✗ " + msg + "\n");
}

function claudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

function hooksDir(): string {
  return path.join(claudeDir(), "hooks");
}

function settingsPath(): string {
  return path.join(claudeDir(), "settings.json");
}

function stopHookPath(): string {
  return path.join(hooksDir(), "stop-hook.sh");
}

function stopHookCommand(): string {
  // On Windows, bash is invoked via Git Bash or WSL — use forward-slash path
  const p = stopHookPath().replace(/\\/g, "/");
  return `bash ${p}`;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log(`  created ${dir}`);
  }
}

function writeStopHook() {
  const p = stopHookPath();
  fs.writeFileSync(p, STOP_HOOK_CONTENT, { encoding: "utf8" });
  // Make executable on Unix
  if (process.platform !== "win32") {
    fs.chmodSync(p, 0o755);
  }
  log(`  wrote   ${p}`);
}

type HookEntry = {
  type: string;
  command: string;
  timeout: number;
};

type HookGroup = {
  matcher: string;
  hooks: HookEntry[];
};

type Settings = {
  hooks?: {
    Stop?: HookGroup[];
    UserPromptSubmit?: HookGroup[];
    [key: string]: HookGroup[] | undefined;
  };
  [key: string]: unknown;
};

function readSettings(): Settings {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Settings;
  } catch {
    err(`Could not parse ${p} — backing up and starting fresh`);
    fs.copyFileSync(p, p + ".bak");
    return {};
  }
}

function hasHook(groups: HookGroup[] | undefined, matcher: string): boolean {
  if (!groups) return false;
  return groups.some((g) => g.matcher === matcher);
}

function injectHooks(settings: Settings): { settings: Settings; changed: boolean } {
  let changed = false;

  if (!settings.hooks) {
    settings.hooks = {};
    changed = true;
  }

  // Stop hook
  if (!hasHook(settings.hooks.Stop, "")) {
    settings.hooks.Stop = [
      ...(settings.hooks.Stop ?? []),
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: stopHookCommand(),
            timeout: 10000,
          },
        ],
      },
    ];
    changed = true;
    log("  injected Stop hook");
  } else {
    log("  Stop hook already present — skipped");
  }

  // UserPromptSubmit hook
  if (!hasHook(settings.hooks.UserPromptSubmit, "")) {
    settings.hooks.UserPromptSubmit = [
      ...(settings.hooks.UserPromptSubmit ?? []),
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: USER_PROMPT_HOOK_COMMAND,
            timeout: 5000,
          },
        ],
      },
    ];
    changed = true;
    log("  injected UserPromptSubmit hook");
  } else {
    log("  UserPromptSubmit hook already present — skipped");
  }

  return { settings, changed };
}

function main() {
  log("\nMnemoPay Claude Code Setup\n");

  // 1. Ensure directories
  ensureDir(claudeDir());
  ensureDir(hooksDir());

  // 2. Write stop-hook.sh
  writeStopHook();

  // 3. Read + patch settings.json
  const raw = readSettings();
  const { settings, changed } = injectHooks(raw);

  if (changed) {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
    log(`  saved   ${settingsPath()}`);
  }

  log("\nDone! Claude Code hooks are configured for MnemoPay.\n");
  log("What happens now:");
  log("  • On session end   — Claude is prompted to save a session summary");
  log("  • On each message  — Claude is reminded to recall relevant memories\n");
  log("Make sure MnemoPay MCP is connected:");
  log("  claude mcp add mnemopay -s user -- npx -y @mnemopay/sdk\n");
}

main();
