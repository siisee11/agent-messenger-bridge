import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { escapeShellArg } from '../infra/shell-escape.js';

export const GEMINI_HOOK_NAME = 'discode-gemini-after-agent';
export const GEMINI_AFTER_AGENT_HOOK_FILENAME = 'discode-after-agent-hook.js';

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

function ensureHookEntry(settings: Record<string, unknown>, hookPath: string): boolean {
  const hooksRoot = asObject(settings.hooks) || {};
  const existingAfterAgent = Array.isArray(hooksRoot.AfterAgent)
    ? [...hooksRoot.AfterAgent]
    : [];
  const hookCommand = getHookCommand(hookPath);

  let changed = false;
  let matchedGroup = false;

  const updatedAfterAgent = existingAfterAgent.map((entry) => {
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
      if (typeof hook.name === 'string' && hook.name === GEMINI_HOOK_NAME) return true;
      if (typeof hook.command === 'string' && hook.command === hookCommand) return true;
      return false;
    });

    if (!hasExisting) {
      groupHooks.push({
        name: GEMINI_HOOK_NAME,
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
    updatedAfterAgent.push({
      matcher: '*',
      hooks: [
        {
          name: GEMINI_HOOK_NAME,
          type: 'command',
          command: hookCommand,
        },
      ],
    });
    changed = true;
  }

  if (!changed) return false;

  hooksRoot.AfterAgent = updatedAfterAgent;
  settings.hooks = hooksRoot;
  return true;
}

function pruneHookEntry(settings: Record<string, unknown>, hookPath: string): boolean {
  const hooksRoot = asObject(settings.hooks);
  if (!hooksRoot) return false;
  if (!Array.isArray(hooksRoot.AfterAgent)) return false;

  let changed = false;
  const nextGroups: Record<string, unknown>[] = [];
  for (const groupEntry of hooksRoot.AfterAgent) {
    const group = asObject(groupEntry);
    if (!group) {
      nextGroups.push(groupEntry as Record<string, unknown>);
      continue;
    }

    const groupHooks = Array.isArray(group.hooks) ? group.hooks : [];
    const nextHooks = groupHooks.filter((hookEntry) => {
      const hook = asObject(hookEntry);
      if (!hook) return true;

      const byName = typeof hook.name === 'string' && hook.name === GEMINI_HOOK_NAME;
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
  hooksRoot.AfterAgent = nextGroups;
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

export function getGeminiHookSourcePath(): string {
  const candidates = [
    join(import.meta.dirname, 'hook', GEMINI_AFTER_AGENT_HOOK_FILENAME),             // source layout: src/gemini/
    join(import.meta.dirname, 'gemini', 'hook', GEMINI_AFTER_AGENT_HOOK_FILENAME),   // bundled chunk in dist/
    join(import.meta.dirname, '../gemini', 'hook', GEMINI_AFTER_AGENT_HOOK_FILENAME), // bundled entry in dist/src/
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

export function installGeminiHook(_projectPath?: string, targetGeminiDir?: string): string {
  const hookDir = getGeminiHookDir(targetGeminiDir);
  const hookPath = join(hookDir, GEMINI_AFTER_AGENT_HOOK_FILENAME);
  const sourcePath = getGeminiHookSourcePath();
  const settingsPath = getGeminiSettingsPath(targetGeminiDir);

  mkdirSync(hookDir, { recursive: true });
  copyFileSync(sourcePath, hookPath);
  chmodSync(hookPath, 0o755);

  const settings = parseSettings(settingsPath);
  const changed = ensureHookEntry(settings, hookPath);
  if (changed) {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  } else if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  }

  return hookPath;
}

export function removeGeminiHook(targetGeminiDir?: string): boolean {
  const hookDir = getGeminiHookDir(targetGeminiDir);
  const hookPath = join(hookDir, GEMINI_AFTER_AGENT_HOOK_FILENAME);
  const settingsPath = getGeminiSettingsPath(targetGeminiDir);

  let changed = false;
  if (existsSync(hookPath)) {
    rmSync(hookPath, { force: true });
    changed = true;
  }

  if (existsSync(settingsPath)) {
    const settings = parseSettings(settingsPath);
    if (pruneHookEntry(settings, hookPath)) {
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
