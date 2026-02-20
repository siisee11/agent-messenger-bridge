/**
 * Unit tests for the Gemini CLI session-hook script.
 *
 * Handles both SessionStart and SessionEnd events via hook_event_name.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/gemini/hook/discode-session-hook.js');

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

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      setTimeout(() => resolve({ calls: fetchCalls, stdout: stdoutData }), 50);
    }, 10);
  });
}

describe('gemini discode-session-hook', () => {
  describe('SessionStart', () => {
    it('posts session.start event with source', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.start');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('gemini');
      expect(payload.source).toBe('startup');
      expect(payload.model).toBe('');
    });

    it('outputs {} to stdout', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.stdout).toBe('{}');
    });

    it('handles resume source', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'resume' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('resume');
    });

    it('handles clear source', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'clear' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('clear');
    });

    it('handles missing source field', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('unknown');
    });

    it('includes instanceId when set', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: 'inst-2' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBe('inst-2');
    });

    it('omits instanceId when AGENT_DISCORD_INSTANCE is empty', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: '' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBeUndefined();
    });
  });

  describe('SessionEnd', () => {
    it('posts session.end event with reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'logout' },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.end');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('gemini');
      expect(payload.reason).toBe('logout');
    });

    it('handles exit reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'exit' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('exit');
    });

    it('handles prompt_input_exit reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('prompt_input_exit');
    });

    it('handles missing reason field', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('unknown');
    });

    it('includes instanceId when set', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: 'inst-3' },
        { hook_event_name: 'SessionEnd', reason: 'logout' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBe('inst-3');
    });
  });

  it('does nothing when AGENT_DISCORD_PROJECT is not set (SessionStart)', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'SessionStart', source: 'startup' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('does nothing when AGENT_DISCORD_PROJECT is not set (SessionEnd)', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'SessionEnd', reason: 'logout' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('does nothing for unknown hook_event_name', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'UnknownEvent' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('does nothing for missing hook_event_name', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { source: 'startup' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('uses custom AGENT_DISCORD_AGENT', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_AGENT: 'custom' },
      { hook_event_name: 'SessionStart', source: 'startup' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('custom');
  });

  it('uses custom AGENT_DISCORD_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '9999', AGENT_DISCORD_HOSTNAME: 'host.docker.internal' },
      { hook_event_name: 'SessionEnd', reason: 'logout' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://host.docker.internal:9999/opencode-event');
  });

  it('silently ignores fetch failure for SessionStart', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });
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

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData(stdinData);
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
  });

  it('silently ignores fetch failure for SessionEnd', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'logout' });
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

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

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

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Malformed JSON → hook_event_name empty → does nothing
    expect(fetchCalls).toHaveLength(0);
  });
});
