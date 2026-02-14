import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CODEX_HOOK_FILENAME,
  getCodexHookSource,
  installCodexHook,
} from '../../src/codex/plugin-installer.js';

describe('codex plugin installer', () => {
  describe('getCodexHookSource', () => {
    it('includes codex agent type', () => {
      const source = getCodexHookSource();
      expect(source).toContain('agentType: "codex"');
    });

    it('posts to /opencode-event endpoint', () => {
      const source = getCodexHookSource();
      expect(source).toContain('/opencode-event');
    });

    it('sends session.idle event type', () => {
      const source = getCodexHookSource();
      expect(source).toContain('type: "session.idle"');
    });

    it('reads JSON from process.argv', () => {
      const source = getCodexHookSource();
      expect(source).toContain('process.argv');
      expect(source).toContain('JSON.parse');
    });

    it('checks for agent-turn-complete event type', () => {
      const source = getCodexHookSource();
      expect(source).toContain('agent-turn-complete');
    });

    it('extracts last-assistant-message', () => {
      const source = getCodexHookSource();
      expect(source).toContain('last-assistant-message');
    });
  });

  describe('installCodexHook', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'codex-hook-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('creates config.toml when none exists', () => {
      const hookPath = installCodexHook(tempDir);
      expect(hookPath).toContain(CODEX_HOOK_FILENAME);

      const configPath = join(tempDir, '.codex', 'config.toml');
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('notify = [');
      expect(content).toContain(CODEX_HOOK_FILENAME);
    });

    it('adds notify to existing config without notify key', () => {
      const codexDir = join(tempDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-4o"\n', 'utf-8');

      installCodexHook(tempDir);

      const content = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(content).toContain('model = "gpt-4o"');
      expect(content).toContain('notify = [');
      expect(content).toContain(CODEX_HOOK_FILENAME);
    });

    it('appends to existing notify array', () => {
      const codexDir = join(tempDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        join(codexDir, 'config.toml'),
        'notify = ["/usr/local/bin/other-hook.sh"]\n',
        'utf-8',
      );

      installCodexHook(tempDir);

      const content = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(content).toContain('/usr/local/bin/other-hook.sh');
      expect(content).toContain(CODEX_HOOK_FILENAME);
      // Both should be in the same notify array
      const match = content.match(/^notify\s*=\s*\[([^\]]*)\]/m);
      expect(match).toBeTruthy();
      expect(match![1]).toContain('other-hook.sh');
      expect(match![1]).toContain(CODEX_HOOK_FILENAME);
    });

    it('is idempotent (no-op when already registered)', () => {
      installCodexHook(tempDir);

      const codexDir = join(tempDir, '.codex');
      const contentBefore = readFileSync(join(codexDir, 'config.toml'), 'utf-8');

      installCodexHook(tempDir);

      const contentAfter = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(contentAfter).toBe(contentBefore);
    });

    it('does not insert notify inside a TOML section', () => {
      const codexDir = join(tempDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      // Config has only a section, no top-level notify
      writeFileSync(
        join(codexDir, 'config.toml'),
        'model = "gpt-4o"\n\n[notice.model_migrations]\ngpt-4 = "gpt-4o"\n',
        'utf-8',
      );

      installCodexHook(tempDir);

      const content = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      // notify should appear before the first [section]
      const notifyIdx = content.indexOf('notify = [');
      const sectionIdx = content.indexOf('[notice.');
      expect(notifyIdx).toBeGreaterThanOrEqual(0);
      expect(notifyIdx).toBeLessThan(sectionIdx);
    });

    it('inserts notify before first section header', () => {
      const codexDir = join(tempDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        join(codexDir, 'config.toml'),
        '[projects."/some/path"]\ntrust_level = "trusted"\n',
        'utf-8',
      );

      installCodexHook(tempDir);

      const content = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      const notifyIdx = content.indexOf('notify = "');
      const sectionIdx = content.indexOf('[projects.');
      // notify should be before the section
      expect(notifyIdx).toBeLessThan(sectionIdx);
    });

    it('writes executable hook script', () => {
      const hookPath = installCodexHook(tempDir);
      const content = readFileSync(hookPath, 'utf-8');
      expect(content).toContain('#!/usr/bin/env node');
      expect(content).toContain('agent-turn-complete');
    });
  });
});
