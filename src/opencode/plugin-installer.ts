import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const OPENCODE_PLUGIN_FILENAME = 'agent-opencode-bridge-plugin.ts';

export function getOpencodePluginDir(): string {
  return join(homedir(), '.opencode', 'plugins');
}

export function getPluginSourcePath(): string {
  const candidates = [
    join(import.meta.dirname, 'plugin', OPENCODE_PLUGIN_FILENAME),             // source layout: src/opencode/
    join(import.meta.dirname, 'opencode', 'plugin', OPENCODE_PLUGIN_FILENAME), // bundled chunk in dist/
    join(import.meta.dirname, '../opencode', 'plugin', OPENCODE_PLUGIN_FILENAME), // bundled entry in dist/src/
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

export function installOpencodePlugin(_projectPath?: string, targetDir?: string): string {
  const pluginDir = targetDir ?? getOpencodePluginDir();
  const pluginPath = join(pluginDir, OPENCODE_PLUGIN_FILENAME);
  const sourcePath = getPluginSourcePath();

  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(sourcePath, pluginPath);

  return pluginPath;
}
