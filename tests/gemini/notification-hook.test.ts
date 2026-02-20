/**
 * Unit tests for the Gemini CLI notification-hook script.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/gemini/hook/discode-notification-hook.js');

function runHook(env: Record<string, string>, stdinJson: unknown): Promise<{ calls: Array<{ url: string; body: unknown }>; stdout: string }> {
  return new Promise((resolve) => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    let stdoutData = '';

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
        stdout: {
          write: (data: string) => { stdoutData += data; },
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

    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      setTimeout(() => resolve({ calls: fetchCalls, stdout: stdoutData }), 50);
    }, 10);
  });
}

describe('gemini discode-notification-hook', () => {
  it('posts session.notification event with ToolPermission type', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
      { message: 'Allow running npm install?', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    const payload = result.calls[0].body as Record<string, unknown>;
    expect(payload.type).toBe('session.notification');
    expect(payload.projectName).toBe('myproject');
    expect(payload.agentType).toBe('gemini');
    expect(payload.notificationType).toBe('ToolPermission');
    expect(payload.text).toBe('Allow running npm install?');
  });

  it('outputs {} to stdout', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'test', notification_type: 'ToolPermission' },
    );

    expect(result.stdout).toBe('{}');
  });

  it('includes instanceId when set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: 'inst-1' },
      { message: 'test', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBe('inst-1');
  });

  it('omits instanceId when AGENT_DISCORD_INSTANCE is empty', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: '' },
      { message: 'test', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBeUndefined();
  });

  it('uses custom AGENT_DISCORD_AGENT', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_AGENT: 'custom' },
      { message: 'test', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('custom');
  });

  it('uses custom AGENT_DISCORD_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '9999', AGENT_DISCORD_HOSTNAME: 'host.docker.internal' },
      { message: 'test', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://host.docker.internal:9999/opencode-event');
  });

  it('does nothing when AGENT_DISCORD_PROJECT is not set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { message: 'test', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('handles missing notification_type gracefully', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'some notification' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).notificationType).toBe('unknown');
  });

  it('handles missing message field', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('trims whitespace from message', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: '  some message  ', notification_type: 'ToolPermission' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('some message');
  });

  it('silently ignores fetch failure', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ message: 'test', notification_type: 'ToolPermission' });
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
        stdout: { write: () => {} },
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
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
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
        stdout: { write: () => {} },
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

    // Malformed JSON → input={} → still posts with defaults
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).notificationType).toBe('unknown');
    expect((fetchCalls[0].body as any).text).toBe('');
  });
});
