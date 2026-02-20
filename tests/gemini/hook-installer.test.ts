import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GEMINI_AFTER_AGENT_HOOK_FILENAME,
  GEMINI_NOTIFICATION_HOOK_FILENAME,
  GEMINI_SESSION_HOOK_FILENAME,
  GEMINI_HOOK_NAME,
  GEMINI_NOTIFICATION_HOOK_NAME,
  GEMINI_SESSION_HOOK_NAME,
  getGeminiHookSourcePath,
  installGeminiHook,
  removeGeminiHook,
} from '../../src/gemini/hook-installer.js';

describe('gemini hook installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-gemini-hook-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source hook file exists', () => {
    expect(existsSync(getGeminiHookSourcePath())).toBe(true);
  });

  it('hook source respects AGENT_DISCORD_HOSTNAME for container mode', () => {
    const content = readFileSync(getGeminiHookSourcePath(), 'utf-8');
    expect(content).toContain('AGENT_DISCORD_HOSTNAME');
    expect(content).not.toMatch(/fetch\(['"]http:\/\/127\.0\.0\.1/);
  });

  it('installGeminiHook copies hook and updates settings.json', () => {
    const hookPath = installGeminiHook(undefined, tempDir);
    const settingsPath = join(tempDir, 'settings.json');

    expect(hookPath).toBe(join(tempDir, 'discode-hooks', GEMINI_AFTER_AGENT_HOOK_FILENAME));
    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const mode = statSync(hookPath).mode & 0o755;
    expect(mode).toBe(0o755);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ matcher?: string; hooks?: Array<{ name?: string; command?: string }> }>;
      };
    };

    const groups = settings.hooks?.AfterAgent || [];
    const wildcardGroup = groups.find((group) => group.matcher === '*' || group.matcher === '');
    expect(wildcardGroup).toBeDefined();
    expect(wildcardGroup?.hooks).toContainEqual(
      expect.objectContaining({
        name: GEMINI_HOOK_NAME,
        type: 'command',
        command: `'${hookPath}'`,
      })
    );
  });

  it('installGeminiHook is idempotent for settings hook entry', () => {
    const firstPath = installGeminiHook(undefined, tempDir);
    const secondPath = installGeminiHook(undefined, tempDir);
    expect(secondPath).toBe(firstPath);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ hooks?: Array<{ name?: string }> }>;
      };
    };

    const entries = (settings.hooks?.AfterAgent || [])
      .flatMap((group) => group.hooks || [])
      .filter((hook) => hook.name === GEMINI_HOOK_NAME);
    expect(entries).toHaveLength(1);
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
      // Simulate compiled binary layout: bin/discode + resources/gemini-hook/
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'gemini-hook');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getGeminiHookSourcePath(), join(resourcesDir, GEMINI_AFTER_AGENT_HOOK_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const candidate = join(dirname(process.execPath), '..', 'resources', 'gemini-hook', GEMINI_AFTER_AGENT_HOOK_FILENAME);
      expect(existsSync(candidate)).toBe(true);

      const content = readFileSync(candidate, 'utf-8');
      expect(content).toContain('/opencode-event');
    });

    it('installGeminiHook works from binary resources layout', () => {
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'gemini-hook');
      const targetDir = join(tempDir, 'gemini-config');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getGeminiHookSourcePath(), join(resourcesDir, GEMINI_AFTER_AGENT_HOOK_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const hookPath = installGeminiHook(undefined, targetDir);
      expect(existsSync(hookPath)).toBe(true);

      const mode = statSync(hookPath).mode & 0o755;
      expect(mode).toBe(0o755);

      const settingsPath = join(targetDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
    });
  });

  it('removeGeminiHook removes hook file and settings entry', () => {
    const hookPath = installGeminiHook(undefined, tempDir);
    const removed = removeGeminiHook(tempDir);

    expect(removed).toBe(true);
    expect(existsSync(hookPath)).toBe(false);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ hooks?: Array<{ name?: string }> }>;
      };
    };

    const hasHook = (settings.hooks?.AfterAgent || [])
      .flatMap((group) => group.hooks || [])
      .some((hook) => hook.name === GEMINI_HOOK_NAME);
    expect(hasHook).toBe(false);
  });

  it('source notification hook file exists', () => {
    expect(existsSync(getGeminiHookSourcePath(GEMINI_NOTIFICATION_HOOK_FILENAME))).toBe(true);
  });

  it('source session hook file exists', () => {
    expect(existsSync(getGeminiHookSourcePath(GEMINI_SESSION_HOOK_FILENAME))).toBe(true);
  });

  it('notification hook source contains expected bridge logic', () => {
    const source = readFileSync(getGeminiHookSourcePath(GEMINI_NOTIFICATION_HOOK_FILENAME), 'utf-8');
    expect(source).toContain('/opencode-event');
    expect(source).toContain("process.env.AGENT_DISCORD_AGENT || 'gemini'");
    expect(source).toContain("type: 'session.notification'");
    expect(source).toContain('notification_type');
  });

  it('session hook source contains expected bridge logic', () => {
    const source = readFileSync(getGeminiHookSourcePath(GEMINI_SESSION_HOOK_FILENAME), 'utf-8');
    expect(source).toContain('/opencode-event');
    expect(source).toContain("process.env.AGENT_DISCORD_AGENT || 'gemini'");
    expect(source).toContain("type: 'session.start'");
    expect(source).toContain("type: 'session.end'");
    expect(source).toContain('hook_event_name');
  });

  it('installGeminiHook copies all hook scripts', () => {
    installGeminiHook(undefined, tempDir);
    const hookDir = join(tempDir, 'discode-hooks');

    expect(existsSync(join(hookDir, GEMINI_AFTER_AGENT_HOOK_FILENAME))).toBe(true);
    expect(existsSync(join(hookDir, GEMINI_NOTIFICATION_HOOK_FILENAME))).toBe(true);
    expect(existsSync(join(hookDir, GEMINI_SESSION_HOOK_FILENAME))).toBe(true);

    // All scripts should be executable
    for (const file of [GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME]) {
      const mode = statSync(join(hookDir, file)).mode & 0o755;
      expect(mode).toBe(0o755);
    }
  });

  it('installGeminiHook registers Notification hook in settings.json', () => {
    installGeminiHook(undefined, tempDir);
    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;

    const groups = settings.hooks?.Notification || [];
    const hooks = groups.flatMap((g: any) => g.hooks || []);
    expect(hooks).toContainEqual(
      expect.objectContaining({ name: GEMINI_NOTIFICATION_HOOK_NAME, type: 'command' }),
    );
  });

  it('installGeminiHook registers SessionStart hook in settings.json', () => {
    installGeminiHook(undefined, tempDir);
    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;

    const groups = settings.hooks?.SessionStart || [];
    const hooks = groups.flatMap((g: any) => g.hooks || []);
    expect(hooks).toContainEqual(
      expect.objectContaining({ name: GEMINI_SESSION_HOOK_NAME, type: 'command' }),
    );
  });

  it('installGeminiHook registers SessionEnd hook in settings.json', () => {
    installGeminiHook(undefined, tempDir);
    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;

    const groups = settings.hooks?.SessionEnd || [];
    const hooks = groups.flatMap((g: any) => g.hooks || []);
    expect(hooks).toContainEqual(
      expect.objectContaining({ name: GEMINI_SESSION_HOOK_NAME, type: 'command' }),
    );
  });

  it('installGeminiHook is idempotent for all hook entries', () => {
    installGeminiHook(undefined, tempDir);
    installGeminiHook(undefined, tempDir);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;

    for (const [eventName, hookName] of [
      ['AfterAgent', GEMINI_HOOK_NAME],
      ['Notification', GEMINI_NOTIFICATION_HOOK_NAME],
      ['SessionStart', GEMINI_SESSION_HOOK_NAME],
      ['SessionEnd', GEMINI_SESSION_HOOK_NAME],
    ]) {
      const entries = (settings.hooks?.[eventName] || [])
        .flatMap((g: any) => g.hooks || [])
        .filter((h: any) => h.name === hookName);
      expect(entries).toHaveLength(1);
    }
  });

  it('removeGeminiHook removes all hook files and settings entries', () => {
    installGeminiHook(undefined, tempDir);
    const removed = removeGeminiHook(tempDir);

    expect(removed).toBe(true);

    const hookDir = join(tempDir, 'discode-hooks');
    expect(existsSync(join(hookDir, GEMINI_AFTER_AGENT_HOOK_FILENAME))).toBe(false);
    expect(existsSync(join(hookDir, GEMINI_NOTIFICATION_HOOK_FILENAME))).toBe(false);
    expect(existsSync(join(hookDir, GEMINI_SESSION_HOOK_FILENAME))).toBe(false);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;

    for (const eventName of ['AfterAgent', 'Notification', 'SessionStart', 'SessionEnd']) {
      const hooks = (settings.hooks?.[eventName] || [])
        .flatMap((g: any) => g.hooks || []);
      expect(hooks).toHaveLength(0);
    }
  });

  it('removeGeminiHook returns false when nothing to remove', () => {
    const removed = removeGeminiHook(tempDir);
    expect(removed).toBe(false);
  });

  describe('settings.json edge cases', () => {
    it('installGeminiHook handles malformed settings.json gracefully', () => {
      const settingsPath = join(tempDir, 'settings.json');
      writeFileSync(settingsPath, 'not valid json {{');

      const hookPath = installGeminiHook(undefined, tempDir);
      expect(existsSync(hookPath)).toBe(true);

      // Should have overwritten with valid settings
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
      expect(settings.hooks).toBeDefined();
    });

    it('installGeminiHook preserves existing settings entries', () => {
      const settingsPath = join(tempDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        theme: 'dark',
        hooks: {
          AfterAgent: [{
            matcher: '*',
            hooks: [{ name: 'other-hook', type: 'command', command: '/usr/bin/other' }],
          }],
        },
      }, null, 2));

      installGeminiHook(undefined, tempDir);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
      expect(settings.theme).toBe('dark');

      // Should have both hooks in the AfterAgent group
      const afterAgentHooks = (settings.hooks?.AfterAgent || [])
        .flatMap((g: any) => g.hooks || []);
      expect(afterAgentHooks).toContainEqual(
        expect.objectContaining({ name: 'other-hook' }),
      );
      expect(afterAgentHooks).toContainEqual(
        expect.objectContaining({ name: GEMINI_HOOK_NAME }),
      );
    });

    it('installGeminiHook detects existing hook by command match', () => {
      const hookDir = join(tempDir, 'discode-hooks');
      mkdirSync(hookDir, { recursive: true });
      const hookPath = join(hookDir, GEMINI_AFTER_AGENT_HOOK_FILENAME);
      const hookCommand = `'${hookPath}'`;

      const settingsPath = join(tempDir, 'settings.json');
      // Pre-populate with hook entry that has the command but a different name
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          AfterAgent: [{
            matcher: '*',
            hooks: [{ name: 'renamed-hook', type: 'command', command: hookCommand }],
          }],
        },
      }, null, 2));

      installGeminiHook(undefined, tempDir);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
      const afterAgentHooks = (settings.hooks?.AfterAgent || [])
        .flatMap((g: any) => g.hooks || []);

      // Should not duplicate — command match should prevent adding again
      const matchingHooks = afterAgentHooks.filter(
        (h: any) => h.command === hookCommand || h.name === GEMINI_HOOK_NAME,
      );
      expect(matchingHooks).toHaveLength(1);
    });

    it('installGeminiHook creates wildcard group when no matching group exists', () => {
      const settingsPath = join(tempDir, 'settings.json');
      // Settings with a non-wildcard matcher
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          AfterAgent: [{
            matcher: 'specific-model',
            hooks: [{ name: 'model-hook', type: 'command', command: '/bin/model-hook' }],
          }],
        },
      }, null, 2));

      installGeminiHook(undefined, tempDir);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
      const groups = settings.hooks?.AfterAgent || [];

      // Should have preserved the specific matcher group
      expect(groups).toContainEqual(
        expect.objectContaining({ matcher: 'specific-model' }),
      );

      // Should have added a wildcard group
      const wildcardGroup = groups.find((g: any) => g.matcher === '*');
      expect(wildcardGroup).toBeDefined();
      expect(wildcardGroup.hooks).toContainEqual(
        expect.objectContaining({ name: GEMINI_HOOK_NAME }),
      );
    });

    it('installGeminiHook handles settings with non-array hooks entries', () => {
      const settingsPath = join(tempDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          AfterAgent: 'not an array',
        },
      }, null, 2));

      installGeminiHook(undefined, tempDir);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
      const groups = settings.hooks?.AfterAgent || [];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBeGreaterThan(0);
    });
  });
});
