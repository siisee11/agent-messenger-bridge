import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { escapeShellArg } from '../infra/shell-escape.js';

export const GEMINI_HOOK_NAME = 'discode-gemini-after-agent';
export const GEMINI_AFTER_AGENT_HOOK_FILENAME = 'discode-after-agent-hook.js';
export const GEMINI_NOTIFICATION_HOOK_FILENAME = 'discode-notification-hook.js';
export const GEMINI_SESSION_HOOK_FILENAME = 'discode-session-hook.js';
export const GEMINI_NOTIFICATION_HOOK_NAME = 'discode-gemini-notification';
export const GEMINI_SESSION_HOOK_NAME = 'discode-gemini-session';

/** All hook registrations: [eventName, hookName, filename] */
const HOOK_REGISTRATIONS: Array<[string, string, string]> = [
  ['AfterAgent', GEMINI_HOOK_NAME, GEMINI_AFTER_AGENT_HOOK_FILENAME],
  ['Notification', GEMINI_NOTIFICATION_HOOK_NAME, GEMINI_NOTIFICATION_HOOK_FILENAME],
  ['SessionStart', GEMINI_SESSION_HOOK_NAME, GEMINI_SESSION_HOOK_FILENAME],
  ['SessionEnd', GEMINI_SESSION_HOOK_NAME, GEMINI_SESSION_HOOK_FILENAME],
];

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return asObject(parsed) || {};
  } catch {
    return {};
  }
}

function getHookCommand(hookPath: string): string {
  return escapeShellArg(hookPath);
}

function ensureHookEntry(settings: Record<string, unknown>, eventName: string, hookName: string, hookPath: string): boolean {
  const hooksRoot = asObject(settings.hooks) || {};
  const existingEntries = Array.isArray(hooksRoot[eventName])
    ? [...hooksRoot[eventName]]
    : [];
  const hookCommand = getHookCommand(hookPath);

  let changed = false;
  let matchedGroup = false;

  const updatedEntries = existingEntries.map((entry) => {
    const group = asObject(entry);
    if (!group) return entry;

    const matcher = typeof group.matcher === 'string' ? group.matcher : '';
    if (matcher !== '*' && matcher !== '') return entry;
    if (matchedGroup) return entry;

    matchedGroup = true;

    const groupHooks = Array.isArray(group.hooks)
      ? group.hooks.filter((item) => asObject(item) !== null)
      : [];

    const hasExisting = groupHooks.some((item) => {
      const hook = asObject(item);
      if (!hook) return false;
      if (typeof hook.name === 'string' && hook.name === hookName) return true;
      if (typeof hook.command === 'string' && hook.command === hookCommand) return true;
      return false;
    });

    if (!hasExisting) {
      groupHooks.push({
        name: hookName,
        type: 'command',
        command: hookCommand,
      });
      changed = true;
    }

    return {
      ...group,
      matcher: matcher || '*',
      hooks: groupHooks,
    };
  });

  if (!matchedGroup) {
    updatedEntries.push({
      matcher: '*',
      hooks: [
        {
          name: hookName,
          type: 'command',
          command: hookCommand,
        },
      ],
    });
    changed = true;
  }

  if (!changed) return false;

  hooksRoot[eventName] = updatedEntries;
  settings.hooks = hooksRoot;
  return true;
}

function pruneHookEntry(settings: Record<string, unknown>, eventName: string, hookName: string, hookPath: string): boolean {
  const hooksRoot = asObject(settings.hooks);
  if (!hooksRoot) return false;
  if (!Array.isArray(hooksRoot[eventName])) return false;

  let changed = false;
  const nextGroups: Record<string, unknown>[] = [];
  for (const groupEntry of hooksRoot[eventName]) {
    const group = asObject(groupEntry);
    if (!group) {
      nextGroups.push(groupEntry as Record<string, unknown>);
      continue;
    }

    const groupHooks = Array.isArray(group.hooks) ? group.hooks : [];
    const nextHooks = groupHooks.filter((hookEntry) => {
      const hook = asObject(hookEntry);
      if (!hook) return true;

      const byName = typeof hook.name === 'string' && hook.name === hookName;
      const byCommand = typeof hook.command === 'string' && hook.command === hookPath;
      if (byName || byCommand) {
        changed = true;
        return false;
      }
      return true;
    });

    if (nextHooks.length === 0) {
      changed = true;
      continue;
    }

    nextGroups.push({
      ...group,
      hooks: nextHooks,
    });
  }

  if (!changed) return false;
  hooksRoot[eventName] = nextGroups;
  settings.hooks = hooksRoot;
  return true;
}

export function getGeminiConfigDir(): string {
  return join(homedir(), '.gemini');
}

export function getGeminiHookDir(targetGeminiDir?: string): string {
  const geminiDir = targetGeminiDir ?? getGeminiConfigDir();
  return join(geminiDir, 'discode-hooks');
}

export function getGeminiSettingsPath(targetGeminiDir?: string): string {
  const geminiDir = targetGeminiDir ?? getGeminiConfigDir();
  return join(geminiDir, 'settings.json');
}

export function getGeminiHookSourcePath(filename?: string): string {
  const hookFile = filename ?? GEMINI_AFTER_AGENT_HOOK_FILENAME;
  const candidates = [
    join(import.meta.dirname, 'hook', hookFile),             // source layout: src/gemini/
    join(import.meta.dirname, 'gemini', 'hook', hookFile),   // bundled chunk in dist/
    join(import.meta.dirname, '../gemini', 'hook', hookFile), // bundled entry in dist/src/
    join(dirname(process.execPath), '..', 'resources', 'gemini-hook', hookFile), // compiled binary
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

export function installGeminiHook(_projectPath?: string, targetGeminiDir?: string): string {
  const hookDir = getGeminiHookDir(targetGeminiDir);
  const settingsPath = getGeminiSettingsPath(targetGeminiDir);

  mkdirSync(hookDir, { recursive: true });

  // Copy all hook scripts and make them executable
  const hookFiles = [GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME];
  for (const filename of hookFiles) {
    const sourcePath = getGeminiHookSourcePath(filename);
    const destPath = join(hookDir, filename);
    copyFileSync(sourcePath, destPath);
    chmodSync(destPath, 0o755);
  }

  // Register all hooks in settings.json
  const settings = parseSettings(settingsPath);
  let changed = false;
  for (const [eventName, hookName, filename] of HOOK_REGISTRATIONS) {
    const hookPath = join(hookDir, filename);
    if (ensureHookEntry(settings, eventName, hookName, hookPath)) {
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  } else if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  }

  return join(hookDir, GEMINI_AFTER_AGENT_HOOK_FILENAME);
}

export function removeGeminiHook(targetGeminiDir?: string): boolean {
  const hookDir = getGeminiHookDir(targetGeminiDir);
  const settingsPath = getGeminiSettingsPath(targetGeminiDir);

  let changed = false;

  // Remove all hook script files
  const hookFiles = [GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME];
  for (const filename of hookFiles) {
    const hookPath = join(hookDir, filename);
    if (existsSync(hookPath)) {
      rmSync(hookPath, { force: true });
      changed = true;
    }
  }

  // Remove all hook entries from settings.json
  if (existsSync(settingsPath)) {
    const settings = parseSettings(settingsPath);
    let settingsChanged = false;
    for (const [eventName, hookName, filename] of HOOK_REGISTRATIONS) {
      const hookPath = join(hookDir, filename);
      if (pruneHookEntry(settings, eventName, hookName, hookPath)) {
        settingsChanged = true;
      }
    }
    if (settingsChanged) {
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
      changed = true;
    }
  }

  try {
    rmSync(hookDir, { recursive: false });
  } catch {
    // ignore non-empty/missing directory
  }

  return changed;
}
