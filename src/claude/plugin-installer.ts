import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export const CLAUDE_PLUGIN_NAME = 'discode-claude-bridge';

export function getClaudePluginDir(): string {
  return join(homedir(), '.claude', 'plugins', CLAUDE_PLUGIN_NAME);
}

export function getPluginSourceDir(): string {
  const execDir = dirname(process.execPath);
  const candidates = [
    join(import.meta.dirname, 'plugin'),                        // source layout: src/claude/
    join(import.meta.dirname, 'claude', 'plugin'),              // bundled chunk in dist/
    join(import.meta.dirname, '../claude', 'plugin'),           // bundled entry in dist/src/
    join(execDir, '..', 'resources', 'claude-plugin'),          // compiled binary: bin/../resources/
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

export function installClaudePlugin(_projectPath?: string, targetDir?: string): string {
  const pluginDir = targetDir ?? getClaudePluginDir();
  const sourceDir = getPluginSourceDir();

  mkdirSync(pluginDir, { recursive: true });
  cpSync(sourceDir, pluginDir, { recursive: true });

  const scriptsDir = join(pluginDir, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const file of readdirSync(scriptsDir)) {
      if (file.endsWith('.js')) {
        chmodSync(join(scriptsDir, file), 0o755);
      }
    }
  }

  return pluginDir;
}
