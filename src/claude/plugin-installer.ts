import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CLAUDE_PLUGIN_NAME = 'discode-claude-bridge';
export const CLAUDE_STOP_HOOK_FILENAME = 'discode-stop-hook.js';

export function getClaudePluginDir(): string {
  return join(homedir(), '.claude', 'plugins', CLAUDE_PLUGIN_NAME);
}

export function getClaudePluginManifestSource(): string {
  return JSON.stringify(
    {
      name: CLAUDE_PLUGIN_NAME,
      description: 'Bridge Claude Code stop events to discode',
      hooks: './hooks/hooks.json',
    },
    null,
    2
  );
}

export function getClaudePluginHooksSource(): string {
  return JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: '${CLAUDE_PLUGIN_ROOT}/scripts/discode-stop-hook.js',
              },
            ],
          },
        ],
      },
    },
    null,
    2
  );
}

export function getClaudeStopHookSource(): string {
  return `#!/usr/bin/env node
const { readFileSync } = require("fs");

function asObject(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  return node;
}

function textFromNode(node, depth = 0) {
  if (depth > 12 || node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);

  if (Array.isArray(node)) {
    return node
      .map((item) => textFromNode(item, depth + 1))
      .filter(Boolean)
      .join("\\n");
  }

  const obj = asObject(node);
  if (!obj) return "";

  if (obj.type === "text" && typeof obj.text === "string") {
    return obj.text;
  }

  return Object.values(obj)
    .map((value) => textFromNode(value, depth + 1))
    .filter(Boolean)
    .join("\\n");
}

function findAssistantText(node, depth = 0) {
  if (depth > 12 || node === undefined || node === null) return "";

  if (Array.isArray(node)) {
    for (const item of node) {
      const text = findAssistantText(item, depth + 1);
      if (text) return text;
    }
    return "";
  }

  const obj = asObject(node);
  if (!obj) return "";

  const role = typeof obj.role === "string" ? obj.role : "";
  const type = typeof obj.type === "string" ? obj.type : "";
  if (role === "assistant" || type === "assistant") {
    const text = textFromNode(obj.content ?? obj.message ?? obj);
    if (text.trim().length > 0) return text.trim();
  }

  const priorityKeys = ["message", "messages", "content", "response", "result", "output", "event", "data"];
  for (const key of priorityKeys) {
    if (!(key in obj)) continue;
    const text = findAssistantText(obj[key], depth + 1);
    if (text) return text;
  }

  for (const value of Object.values(obj)) {
    const text = findAssistantText(value, depth + 1);
    if (text) return text;
  }

  return "";
}

function parseLineJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";

  let raw = "";
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }

  const lines = raw.split("\\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLineJson(line);
    if (!entry) continue;

    const text = findAssistantText(entry).trim();
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      resolve(raw);
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}

async function postToBridge(port, payload) {
  await fetch("http://127.0.0.1:" + port + "/opencode-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const inputRaw = await readStdin();
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  if (input.stop_hook_active === true) return;

  const projectName = process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  const port = process.env.AGENT_DISCORD_PORT || "18470";
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const text = readLastAssistantText(transcriptPath);

  try {
    await postToBridge(port, {
      projectName,
      agentType: "claude",
      type: "session.idle",
      text,
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {
  // ignore
});
`;
}

export function installClaudePlugin(_projectPath?: string): string {
  const pluginDir = getClaudePluginDir();
  const manifestDir = join(pluginDir, '.claude-plugin');
  const hooksDir = join(pluginDir, 'hooks');
  const scriptsDir = join(pluginDir, 'scripts');
  const hookPath = join(scriptsDir, CLAUDE_STOP_HOOK_FILENAME);

  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });

  writeFileSync(join(manifestDir, 'plugin.json'), getClaudePluginManifestSource() + '\n', 'utf-8');
  writeFileSync(join(hooksDir, 'hooks.json'), getClaudePluginHooksSource() + '\n', 'utf-8');
  writeFileSync(hookPath, getClaudeStopHookSource(), 'utf-8');
  chmodSync(hookPath, 0o755);

  return pluginDir;
}
