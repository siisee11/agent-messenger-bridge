import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_FILENAME,
  getCodexHookSourcePath,
  installCodexHook,
  removeCodexHook,
} from '../../src/codex/hook-installer.js';

describe('codex hook installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-codex-hook-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source hook file exists', () => {
    expect(existsSync(getCodexHookSourcePath())).toBe(true);
  });

  it('installCodexHook copies hook and creates config.toml', () => {
    const hookPath = installCodexHook(undefined, tempDir);
    const configPath = join(tempDir, 'config.toml');

    expect(hookPath).toBe(join(tempDir, 'discode-hooks', CODEX_HOOK_FILENAME));
    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);

    const mode = statSync(hookPath).mode & 0o755;
    expect(mode).toBe(0o755);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain(`notify = ["${hookPath}"]`);
  });

  it('installCodexHook is idempotent', () => {
    const firstPath = installCodexHook(undefined, tempDir);
    const secondPath = installCodexHook(undefined, tempDir);
    expect(secondPath).toBe(firstPath);

    const configPath = join(tempDir, 'config.toml');
    const config = readFileSync(configPath, 'utf-8');

    // Should only contain one notify line
    const notifyMatches = config.match(/notify\s*=/g);
    expect(notifyMatches).toHaveLength(1);
  });

  it('installCodexHook preserves existing config content', () => {
    const configPath = join(tempDir, 'config.toml');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, 'model = "o3"\n\n[mcp_servers.existing]\ncommand = "test"\n');

    const hookPath = installCodexHook(undefined, tempDir);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain('model = "o3"');
    expect(config).toContain('[mcp_servers.existing]');
    expect(config).toContain(`notify = ["${hookPath}"]`);
  });

  it('installCodexHook replaces existing notify line', () => {
    const configPath = join(tempDir, 'config.toml');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, 'notify = ["/old/hook.js"]\nmodel = "o3"\n');

    const hookPath = installCodexHook(undefined, tempDir);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).not.toContain('/old/hook.js');
    expect(config).toContain(`notify = ["${hookPath}"]`);
    expect(config).toContain('model = "o3"');
  });

  it('installCodexHook inserts notify before first section header', () => {
    const configPath = join(tempDir, 'config.toml');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, '[mcp_servers.existing]\ncommand = "test"\n');

    const hookPath = installCodexHook(undefined, tempDir);

    const config = readFileSync(configPath, 'utf-8');
    const notifyIdx = config.indexOf('notify');
    const sectionIdx = config.indexOf('[mcp_servers.existing]');
    expect(notifyIdx).toBeLessThan(sectionIdx);
  });

  describe('compiled binary resource resolution', () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      process.execPath = originalExecPath;
    });

    it('resolves hook source from process.execPath-based resources path', () => {
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'codex-hook');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getCodexHookSourcePath(), join(resourcesDir, CODEX_HOOK_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const candidate = join(dirname(process.execPath), '..', 'resources', 'codex-hook', CODEX_HOOK_FILENAME);
      expect(existsSync(candidate)).toBe(true);

      const content = readFileSync(candidate, 'utf-8');
      expect(content).toContain('/opencode-event');
    });

    it('installCodexHook works from binary resources layout', () => {
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'codex-hook');
      const targetDir = join(tempDir, 'codex-config');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getCodexHookSourcePath(), join(resourcesDir, CODEX_HOOK_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const hookPath = installCodexHook(undefined, targetDir);
      expect(existsSync(hookPath)).toBe(true);

      const mode = statSync(hookPath).mode & 0o755;
      expect(mode).toBe(0o755);

      const configPath = join(targetDir, 'config.toml');
      expect(existsSync(configPath)).toBe(true);
    });
  });

  it('removeCodexHook removes hook file and notify line', () => {
    const hookPath = installCodexHook(undefined, tempDir);
    const removed = removeCodexHook(tempDir);

    expect(removed).toBe(true);
    expect(existsSync(hookPath)).toBe(false);

    const configPath = join(tempDir, 'config.toml');
    const config = readFileSync(configPath, 'utf-8');
    expect(config).not.toContain('notify');
  });

  it('removeCodexHook returns false when nothing to remove', () => {
    const removed = removeCodexHook(tempDir);
    expect(removed).toBe(false);
  });

  it('removeCodexHook preserves other config content', () => {
    const configPath = join(tempDir, 'config.toml');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, 'model = "o3"\n\n[mcp_servers.existing]\ncommand = "test"\n');

    installCodexHook(undefined, tempDir);
    removeCodexHook(tempDir);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain('model = "o3"');
    expect(config).toContain('[mcp_servers.existing]');
    expect(config).not.toContain('notify');
  });

  it('handles config.toml with only comments', () => {
    const configPath = join(tempDir, 'config.toml');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, '# Codex config\n# model = "o3"\n');

    const hookPath = installCodexHook(undefined, tempDir);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain('# Codex config');
    expect(config).toContain(`notify = ["${hookPath}"]`);
  });

  it('handles config.toml with inline notify and different spacing', () => {
    const configPath = join(tempDir, 'config.toml');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, '  notify  = ["/old/path.js"]\nmodel = "o3"\n');

    const hookPath = installCodexHook(undefined, tempDir);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain(`notify = ["${hookPath}"]`);
    expect(config).not.toContain('/old/path.js');
    // Only one notify line
    const notifyMatches = config.match(/notify\s*=/g);
    expect(notifyMatches).toHaveLength(1);
  });

  it('installCodexHook creates codex config dir if it does not exist', () => {
    const targetDir = join(tempDir, 'nonexistent', 'nested');

    const hookPath = installCodexHook(undefined, targetDir);

    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(join(targetDir, 'config.toml'))).toBe(true);
  });
});
