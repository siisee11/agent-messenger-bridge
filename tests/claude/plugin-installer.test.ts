import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_PLUGIN_NAME,
  getPluginSourceDir,
  installClaudePlugin,
} from '../../src/claude/plugin-installer.js';

const CLAUDE_STOP_HOOK_FILENAME = 'discode-stop-hook.js';
const CLAUDE_NOTIFICATION_HOOK_FILENAME = 'discode-notification-hook.js';
const CLAUDE_SESSION_HOOK_FILENAME = 'discode-session-hook.js';

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
    expect(existsSync(join(sourceDir, 'scripts', CLAUDE_NOTIFICATION_HOOK_FILENAME))).toBe(true);
    expect(existsSync(join(sourceDir, 'scripts', CLAUDE_SESSION_HOOK_FILENAME))).toBe(true);
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

  it('hooks.json references notification and session hooks with async', () => {
    const sourceDir = getPluginSourceDir();
    const hooks = JSON.parse(readFileSync(join(sourceDir, 'hooks', 'hooks.json'), 'utf-8'));

    expect(hooks.hooks.Notification[0].hooks[0]).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/discode-notification-hook.js',
      async: true,
    });

    expect(hooks.hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/discode-session-hook.js',
      async: true,
    });

    expect(hooks.hooks.SessionEnd[0].hooks[0]).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/discode-session-hook.js',
      async: true,
    });
  });

  it('stop hook script contains expected bridge logic', () => {
    const sourceDir = getPluginSourceDir();
    const source = readFileSync(join(sourceDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME), 'utf-8');
    expect(source).toContain('/opencode-event');
    expect(source).toContain('process.env.AGENT_DISCORD_AGENT || "claude"');
    expect(source).toContain('type: "session.idle"');
  });

  it('notification hook script contains expected bridge logic', () => {
    const sourceDir = getPluginSourceDir();
    const source = readFileSync(join(sourceDir, 'scripts', CLAUDE_NOTIFICATION_HOOK_FILENAME), 'utf-8');
    expect(source).toContain('/opencode-event');
    expect(source).toContain('process.env.AGENT_DISCORD_AGENT || "claude"');
    expect(source).toContain('type: "session.notification"');
    expect(source).toContain('notificationType');
    expect(source).toContain('input.notification_type');
  });

  it('session hook script contains expected bridge logic', () => {
    const sourceDir = getPluginSourceDir();
    const source = readFileSync(join(sourceDir, 'scripts', CLAUDE_SESSION_HOOK_FILENAME), 'utf-8');
    expect(source).toContain('/opencode-event');
    expect(source).toContain('process.env.AGENT_DISCORD_AGENT || "claude"');
    expect(source).toContain('type: "session.start"');
    expect(source).toContain('type: "session.end"');
    expect(source).toContain('hook_event_name');
    expect(source).toContain('input.source');
    expect(source).toContain('input.reason');
  });

  it('installClaudePlugin copies files to target directory', () => {
    const pluginDir = join(tempDir, CLAUDE_PLUGIN_NAME);

    const result = installClaudePlugin(undefined, pluginDir);
    expect(result).toBe(pluginDir);

    // Verify files were copied
    expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(pluginDir, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(join(pluginDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME))).toBe(true);
    expect(existsSync(join(pluginDir, 'scripts', CLAUDE_NOTIFICATION_HOOK_FILENAME))).toBe(true);
    expect(existsSync(join(pluginDir, 'scripts', CLAUDE_SESSION_HOOK_FILENAME))).toBe(true);

    // Verify all hook scripts are executable
    for (const script of [CLAUDE_STOP_HOOK_FILENAME, CLAUDE_NOTIFICATION_HOOK_FILENAME, CLAUDE_SESSION_HOOK_FILENAME]) {
      const stats = statSync(join(pluginDir, 'scripts', script));
      expect(stats.mode & 0o755).toBe(0o755);
    }
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

  describe('compiled binary resource resolution', () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      process.execPath = originalExecPath;
    });

    it('resolves plugin source from process.execPath-based resources path', () => {
      // Simulate compiled binary layout: bin/discode + resources/claude-plugin/
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'claude-plugin');

      mkdirSync(binDir, { recursive: true });
      cpSync(getPluginSourceDir(), resourcesDir, { recursive: true });
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      // Verify the process.execPath-based candidate resolves correctly
      const candidate = join(dirname(process.execPath), '..', 'resources', 'claude-plugin');
      expect(existsSync(candidate)).toBe(true);
      expect(existsSync(join(candidate, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(candidate, 'hooks', 'hooks.json'))).toBe(true);
      expect(existsSync(join(candidate, 'scripts', CLAUDE_STOP_HOOK_FILENAME))).toBe(true);
    });

    it('installClaudePlugin works from binary resources layout', () => {
      // Create binary layout with plugin resources
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'claude-plugin');
      const pluginDir = join(tempDir, 'installed-plugin');

      mkdirSync(binDir, { recursive: true });
      cpSync(getPluginSourceDir(), resourcesDir, { recursive: true });
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      // Install from the binary resources path
      const result = installClaudePlugin(undefined, pluginDir);
      expect(result).toBe(pluginDir);
      expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(pluginDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME))).toBe(true);

      const stats = statSync(join(pluginDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME));
      expect(stats.mode & 0o755).toBe(0o755);
    });
  });
});
