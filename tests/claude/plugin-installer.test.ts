import { existsSync, mkdtempSync, readFileSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_PLUGIN_NAME,
  CLAUDE_STOP_HOOK_FILENAME,
  getPluginSourceDir,
  installClaudePlugin,
} from '../../src/claude/plugin-installer.js';

describe('claude plugin installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-plugin-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source plugin directory contains required files', () => {
    const sourceDir = getPluginSourceDir();
    expect(existsSync(join(sourceDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(sourceDir, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(join(sourceDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME))).toBe(true);
  });

  it('plugin.json has correct name and no hooks', () => {
    const sourceDir = getPluginSourceDir();
    const manifest = JSON.parse(readFileSync(join(sourceDir, '.claude-plugin', 'plugin.json'), 'utf-8'));
    expect(manifest.name).toBe(CLAUDE_PLUGIN_NAME);
    expect(manifest.hooks).toBeUndefined();
  });

  it('hooks.json references the stop hook script', () => {
    const sourceDir = getPluginSourceDir();
    const hooks = JSON.parse(readFileSync(join(sourceDir, 'hooks', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/discode-stop-hook.js',
    });
  });

  it('stop hook script contains expected bridge logic', () => {
    const sourceDir = getPluginSourceDir();
    const source = readFileSync(join(sourceDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME), 'utf-8');
    expect(source).toContain('/opencode-event');
    expect(source).toContain('process.env.AGENT_DISCORD_AGENT || "claude"');
    expect(source).toContain('type: "session.idle"');
  });

  it('installClaudePlugin copies files to target directory', () => {
    const pluginDir = join(tempDir, CLAUDE_PLUGIN_NAME);

    const result = installClaudePlugin(undefined, pluginDir);
    expect(result).toBe(pluginDir);

    // Verify files were copied
    expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(pluginDir, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(join(pluginDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME))).toBe(true);

    // Verify hook script is executable
    const stats = statSync(join(pluginDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME));
    expect(stats.mode & 0o755).toBe(0o755);
  });

  it('source plugin directory contains discode-send skill', () => {
    const sourceDir = getPluginSourceDir();
    const skillPath = join(sourceDir, 'skills', 'discode-send', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('name: discode-send');
    expect(content).toContain('discode-send');
    expect(content).toContain('allowed-tools: Bash');
    expect(content).toContain('Do NOT explore');
  });

  it('installClaudePlugin copies skill to target directory', () => {
    const pluginDir = join(tempDir, CLAUDE_PLUGIN_NAME);
    installClaudePlugin(undefined, pluginDir);

    const skillPath = join(pluginDir, 'skills', 'discode-send', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
  });
});
