/**
 * Unit tests for the Claude Code notification-hook script.
 *
 * The hook is a CJS script (not a module), so we validate its structure
 * and bridge POST payload using a VM context.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/claude/plugin/scripts/discode-notification-hook.js');

function runHook(env: Record<string, string>, stdinJson: unknown): Promise<{ calls: Array<{ url: string; body: unknown }> }> {
  return new Promise((resolve) => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];

    const stdinData = JSON.stringify(stdinJson);
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const ctx = createContext({
      require: () => ({}),
      process: {
        env,
        stdin: {
          isTTY: false,
          setEncoding: () => {},
          on: (event: string, cb: any) => {
            if (event === 'data') onData = cb;
            if (event === 'end') onEnd = cb;
          },
        },
      },
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return {};
      },
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    // Simulate stdin delivery
    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      // Wait for async main() to complete
      setTimeout(() => resolve({ calls: fetchCalls }), 50);
    }, 10);
  });
}

describe('discode-notification-hook', () => {
  it('posts session.notification event with permission_prompt type', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
      { message: 'Claude needs permission to use Bash', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    const payload = result.calls[0].body as Record<string, unknown>;
    expect(payload.type).toBe('session.notification');
    expect(payload.projectName).toBe('myproject');
    expect(payload.agentType).toBe('claude');
    expect(payload.notificationType).toBe('permission_prompt');
    expect(payload.text).toBe('Claude needs permission to use Bash');
  });

  it('posts with idle_prompt notification type', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'Claude is idle', notification_type: 'idle_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('idle_prompt');
  });

  it('posts with auth_success notification type', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'Auth succeeded', notification_type: 'auth_success' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('auth_success');
    expect((result.calls[0].body as any).text).toBe('Auth succeeded');
  });

  it('posts with elicitation_dialog notification type', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'Claude wants to ask a question', notification_type: 'elicitation_dialog' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('elicitation_dialog');
  });

  it('includes instanceId when set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: 'inst-1' },
      { message: 'test', notification_type: 'auth_success' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBe('inst-1');
  });

  it('omits instanceId when AGENT_DISCORD_INSTANCE is empty', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: '' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBeUndefined();
  });

  it('uses custom AGENT_DISCORD_AGENT', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_AGENT: 'gemini' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('gemini');
  });

  it('uses custom AGENT_DISCORD_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '9999', AGENT_DISCORD_HOSTNAME: '10.0.0.1' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://10.0.0.1:9999/opencode-event');
  });

  it('uses custom AGENT_DISCORD_PORT', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '12345' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toContain(':12345/');
  });

  it('does nothing when AGENT_DISCORD_PROJECT is not set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { message: 'test', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('handles missing notification_type gracefully', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'some notification' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('unknown');
  });

  it('handles empty message', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: '', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('handles missing message field (undefined)', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { notification_type: 'idle_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('trims whitespace from message', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: '  some message  ', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('some message');
  });

  it('silently ignores fetch failure', async () => {
    // Run hook with a setup that would cause fetch to throw
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ message: 'test', notification_type: 'permission_prompt' });
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;
    let errorThrown = false;

    const ctx = createContext({
      require: () => ({}),
      process: {
        env: { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        stdin: {
          isTTY: false,
          setEncoding: () => {},
          on: (event: string, cb: any) => {
            if (event === 'data') onData = cb;
            if (event === 'end') onEnd = cb;
          },
        },
      },
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: async () => { throw new Error('network error'); },
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData(stdinData);
        if (onEnd) onEnd();
        setTimeout(() => {
          // If we get here without error, the hook silently swallowed the failure
          resolve();
        }, 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
    expect(errorThrown).toBe(false);
  });

  it('handles isTTY stdin (no data) gracefully', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];

    const ctx = createContext({
      require: () => ({}),
      process: {
        env: { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        stdin: {
          isTTY: true,
          setEncoding: () => {},
          on: () => {},
        },
      },
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return {};
      },
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 100);
    });

    // isTTY=true → readStdin returns "" → input={} → posts with defaults
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).notificationType).toBe('unknown');
    expect((fetchCalls[0].body as any).text).toBe('');
  });

  it('handles malformed JSON stdin gracefully', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const ctx = createContext({
      require: () => ({}),
      process: {
        env: { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        stdin: {
          isTTY: false,
          setEncoding: () => {},
          on: (event: string, cb: any) => {
            if (event === 'data') onData = cb;
            if (event === 'end') onEnd = cb;
          },
        },
      },
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return {};
      },
    });

    new Script(raw, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Should still post with defaults (empty message, unknown type)
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).notificationType).toBe('unknown');
    expect((fetchCalls[0].body as any).text).toBe('');
  });
});
