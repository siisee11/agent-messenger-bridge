import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CODEX_HOOK_FILENAME = 'discode-notify-hook.js';

/**
 * Build a regex that matches `key = [...]` only in the top-level scope of a
 * TOML file (i.e. before the first `[section]` header).  Returns a RegExp
 * whose first capture group is the contents between the brackets.
 */
function buildTopLevelKeyPattern(key: string): RegExp {
  // We search line-by-line so we can stop at the first section header.
  // The returned regex operates on the *top-level slice* of the file.
  return new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm');
}

/**
 * Extract the top-level portion of a TOML string (everything before the first
 * `[section]` header).  Returns the full string if there are no sections.
 */
function topLevelSlice(content: string): string {
  const idx = content.search(/^\[/m);
  return idx >= 0 ? content.slice(0, idx) : content;
}

function resolveHome(): string {
  return process.env.HOME || homedir();
}

export function getCodexHookDir(home?: string): string {
  return join(home || resolveHome(), '.codex', 'hooks');
}

export function getCodexConfigPath(home?: string): string {
  return join(home || resolveHome(), '.codex', 'config.toml');
}

export function getCodexHookSource(): string {
  return `#!/usr/bin/env node
const http = require("http");

function main() {
  const args = process.argv.slice(2);
  const lastArg = args[args.length - 1] || "";

  let event;
  try {
    event = JSON.parse(lastArg);
  } catch {
    return;
  }

  if (!event || typeof event !== "object") return;
  if (event.type !== "agent-turn-complete") return;

  const message = event["last-assistant-message"];
  const text = typeof message === "string" ? message.trim() : "";

  const projectName = process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  const port = process.env.AGENT_DISCORD_PORT || "18470";

  const payload = JSON.stringify({
    projectName,
    agentType: "codex",
    type: "session.idle",
    text,
  });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: Number(port),
      path: "/opencode-event",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    },
    () => {}
  );
  req.on("error", () => {});
  req.end(payload);
}

main();
`;
}

export function installCodexHook(home?: string): string {
  const h = home || resolveHome();
  const hookDir = getCodexHookDir(h);
  const hookPath = join(hookDir, CODEX_HOOK_FILENAME);

  // Write hook script
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(hookPath, getCodexHookSource(), 'utf-8');
  chmodSync(hookPath, 0o755);

  // Update config.toml
  const configPath = getCodexConfigPath(h);
  const configDir = join(h, '.codex');
  mkdirSync(configDir, { recursive: true });

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `notify = ["${hookPath}"]\n`, 'utf-8');
    return hookPath;
  }

  let content = readFileSync(configPath, 'utf-8');

  // Check if our hook is already registered
  if (content.includes(CODEX_HOOK_FILENAME)) {
    return hookPath;
  }

  // Check if a top-level notify key exists (before any [section] header).
  // We must only match top-level keys, not keys inside TOML sections.
  const topLevel = topLevelSlice(content);
  const topLevelNotifyPattern = buildTopLevelKeyPattern('notify');
  const topLevelMatch = topLevelNotifyPattern.exec(topLevel);

  if (topLevelMatch) {
    // Append our hook to the existing notify array
    const existingItems = topLevelMatch[1].trim();
    const separator = existingItems.length > 0 ? ', ' : '';
    const newValue = `notify = [${existingItems}${separator}"${hookPath}"]`;
    content = content.slice(0, topLevelMatch.index) + newValue + content.slice(topLevelMatch.index + topLevelMatch[0].length);
    writeFileSync(configPath, content, 'utf-8');
  } else {
    // Insert notify as a top-level key (before the first [section] header
    // so it doesn't end up inside a TOML section).
    const firstSection = content.search(/^\[/m);
    if (firstSection > 0) {
      content = content.slice(0, firstSection) + `notify = ["${hookPath}"]\n` + content.slice(firstSection);
    } else if (firstSection === 0) {
      content = `notify = ["${hookPath}"]\n` + content;
    } else {
      // No sections at all, safe to append
      const suffix = content.endsWith('\n') ? '' : '\n';
      content += `${suffix}notify = ["${hookPath}"]\n`;
    }
    writeFileSync(configPath, content, 'utf-8');
  }

  return hookPath;
}
