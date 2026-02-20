/**
 * Unit tests for the Gemini CLI after-agent-hook script.
 *
 * Covers: stop_hook_active early return, hook_event_name filtering,
 * prompt_response extraction, bridge POST, instanceId, fetch error handling.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/gemini/hook/discode-after-agent-hook.js');

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
      Math,
      fetch: async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return {};
      },
    });

    new Script(raw, { filename: 'discode-after-agent-hook.js' }).runInContext(ctx);

    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      setTimeout(() => resolve({ calls: fetchCalls, stdout: stdoutData }), 50);
    }, 10);
  });
}

describe('gemini discode-after-agent-hook', () => {
  it('posts session.idle with prompt_response text', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
      { prompt_response: 'Task completed successfully' },
    );

    expect(result.calls).toHaveLength(1);
    const payload = result.calls[0].body as Record<string, unknown>;
    expect(payload.type).toBe('session.idle');
    expect(payload.projectName).toBe('myproject');
    expect(payload.agentType).toBe('gemini');
    expect(payload.text).toBe('Task completed successfully');
  });

  it('outputs {} to stdout', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { prompt_response: 'hello' },
    );

    expect(result.stdout).toBe('{}');
  });

  it('trims prompt_response text', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { prompt_response: '  trimmed text  ' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('trimmed text');
  });

  it('handles missing prompt_response (sends empty text)', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      {},
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('handles non-string prompt_response', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { prompt_response: 42 },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('');
  });

  it('returns early when stop_hook_active is true', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { stop_hook_active: true, prompt_response: 'should not send' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('does not return early when stop_hook_active is false', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { stop_hook_active: false, prompt_response: 'should send' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('should send');
  });

  it('does not return early when stop_hook_active is truthy but not true', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { stop_hook_active: 'yes', prompt_response: 'should send' },
    );

    expect(result.calls).toHaveLength(1);
  });

  it('returns early when hook_event_name is not AfterAgent', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'SessionStart', prompt_response: 'should not send' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('proceeds when hook_event_name is AfterAgent', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'AfterAgent', prompt_response: 'ok' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).text).toBe('ok');
  });

  it('proceeds when hook_event_name is not set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { prompt_response: 'no event name' },
    );

    expect(result.calls).toHaveLength(1);
  });

  it('does nothing when AGENT_DISCORD_PROJECT is not set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { prompt_response: 'should not send' },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toBe('{}');
  });

  it('includes instanceId when set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: 'inst-1' },
      { prompt_response: 'hello' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBe('inst-1');
  });

  it('omits instanceId when AGENT_DISCORD_INSTANCE is empty', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_INSTANCE: '' },
      { prompt_response: 'hello' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).instanceId).toBeUndefined();
  });

  it('uses custom AGENT_DISCORD_AGENT', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_AGENT: 'custom' },
      { prompt_response: 'hello' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('custom');
  });

  it('uses custom AGENT_DISCORD_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '9999', AGENT_DISCORD_HOSTNAME: 'host.docker.internal' },
      { prompt_response: 'hello' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://host.docker.internal:9999/opencode-event');
  });

  it('silently ignores fetch failure', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ prompt_response: 'hello' });
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
      Math,
      fetch: async () => { throw new Error('network error'); },
    });

    new Script(raw, { filename: 'discode-after-agent-hook.js' }).runInContext(ctx);

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
      Math,
      fetch: async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return {};
      },
    });

    new Script(raw, { filename: 'discode-after-agent-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Malformed JSON → input={} → posts with empty text
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).text).toBe('');
  });

  it('returns {} from isTTY stdin', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    let stdoutData = '';

    const ctx = createContext({
      require: () => ({}),
      process: {
        env: { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        stdin: {
          isTTY: true,
          setEncoding: () => {},
          on: () => {},
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
      Math,
      fetch: async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) });
        return {};
      },
    });

    new Script(raw, { filename: 'discode-after-agent-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    // isTTY → readStdin returns '' → input={} → posts with empty text
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0].body as any).text).toBe('');
    expect(stdoutData).toBe('{}');
  });
});
