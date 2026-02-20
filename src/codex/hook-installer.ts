import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const CODEX_HOOK_FILENAME = 'discode-codex-notify.js';

/**
 * Get the Codex config directory (~/.codex).
 */
export function getCodexConfigDir(): string {
  return join(homedir(), '.codex');
}

export function getCodexHookDir(targetCodexDir?: string): string {
  const codexDir = targetCodexDir ?? getCodexConfigDir();
  return join(codexDir, 'discode-hooks');
}

export function getCodexConfigPath(targetCodexDir?: string): string {
  const codexDir = targetCodexDir ?? getCodexConfigDir();
  return join(codexDir, 'config.toml');
}

export function getCodexHookSourcePath(): string {
  const candidates = [
    join(import.meta.dirname, 'hook', CODEX_HOOK_FILENAME),             // source layout: src/codex/
    join(import.meta.dirname, 'codex', 'hook', CODEX_HOOK_FILENAME),    // bundled chunk in dist/
    join(import.meta.dirname, '../codex', 'hook', CODEX_HOOK_FILENAME), // bundled entry in dist/src/
    join(dirname(process.execPath), '..', 'resources', 'codex-hook', CODEX_HOOK_FILENAME), // compiled binary
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

/**
 * Minimal TOML line-based manipulation for the `notify` key.
 *
 * Codex config.toml supports a single `notify` command:
 *   notify = ["/path/to/hook.js"]
 *
 * Strategy:
 * - If a `notify = [...]` line exists, replace it.
 * - Otherwise insert before the first `[section]` header, or append at end.
 */
function setNotifyLine(lines: string[], hookPath: string): { lines: string[]; changed: boolean } {
  const notifyValue = `notify = ["${hookPath}"]`;
  const notifyPattern = /^\s*notify\s*=/;

  const existingIdx = lines.findIndex(l => notifyPattern.test(l));
  if (existingIdx !== -1) {
    if (lines[existingIdx].trim() === notifyValue) {
      return { lines, changed: false };
    }
    const updated = [...lines];
    updated[existingIdx] = notifyValue;
    return { lines: updated, changed: true };
  }

  // Insert before first [section] or append
  const sectionIdx = lines.findIndex(l => /^\s*\[/.test(l));
  const updated = [...lines];
  if (sectionIdx !== -1) {
    updated.splice(sectionIdx, 0, notifyValue, '');
  } else {
    // Append with blank line separator
    if (updated.length > 0 && updated[updated.length - 1].trim() !== '') {
      updated.push('');
    }
    updated.push(notifyValue);
  }
  return { lines: updated, changed: true };
}

/**
 * Remove the `notify` line from config lines.
 */
function removeNotifyLine(lines: string[], hookPath: string): { lines: string[]; changed: boolean } {
  const notifyPattern = /^\s*notify\s*=/;
  const idx = lines.findIndex(l => notifyPattern.test(l) && l.includes(hookPath));
  if (idx === -1) return { lines, changed: false };

  const updated = [...lines];
  updated.splice(idx, 1);
  // Remove trailing blank line if one was left
  if (idx < updated.length && updated[idx]?.trim() === '' &&
      (idx === 0 || updated[idx - 1]?.trim() === '')) {
    updated.splice(idx, 1);
  }
  return { lines: updated, changed: true };
}

/**
 * Install the Codex notify hook.
 *
 * 1. Copy hook script to ~/.codex/discode-hooks/
 * 2. Update config.toml with `notify` pointing to the hook
 */
export function installCodexHook(_projectPath?: string, targetCodexDir?: string): string {
  const hookDir = getCodexHookDir(targetCodexDir);
  const hookPath = join(hookDir, CODEX_HOOK_FILENAME);
  const sourcePath = getCodexHookSourcePath();
  const configPath = getCodexConfigPath(targetCodexDir);

  // 1. Copy hook script
  mkdirSync(hookDir, { recursive: true });
  copyFileSync(sourcePath, hookPath);
  chmodSync(hookPath, 0o755);

  // 2. Update config.toml
  const codexDir = targetCodexDir ?? getCodexConfigDir();
  mkdirSync(codexDir, { recursive: true });

  let lines: string[] = [];
  if (existsSync(configPath)) {
    lines = readFileSync(configPath, 'utf-8').split('\n');
  }

  const result = setNotifyLine(lines, hookPath);
  if (result.changed || !existsSync(configPath)) {
    writeFileSync(configPath, result.lines.join('\n'), 'utf-8');
  }

  return hookPath;
}

/**
 * Remove the Codex notify hook.
 *
 * 1. Remove notify line from config.toml
 * 2. Delete hook script file
 */
export function removeCodexHook(targetCodexDir?: string): boolean {
  const hookDir = getCodexHookDir(targetCodexDir);
  const hookPath = join(hookDir, CODEX_HOOK_FILENAME);
  const configPath = getCodexConfigPath(targetCodexDir);

  let changed = false;

  // Remove hook file
  if (existsSync(hookPath)) {
    rmSync(hookPath, { force: true });
    changed = true;
  }

  // Remove notify line from config.toml
  if (existsSync(configPath)) {
    const lines = readFileSync(configPath, 'utf-8').split('\n');
    const result = removeNotifyLine(lines, hookPath);
    if (result.changed) {
      writeFileSync(configPath, result.lines.join('\n'), 'utf-8');
      changed = true;
    }
  }

  // Try to remove empty hook directory
  try {
    rmSync(hookDir, { recursive: false });
  } catch {
    // ignore non-empty/missing directory
  }

  return changed;
}
