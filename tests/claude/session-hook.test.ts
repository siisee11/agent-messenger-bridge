/**
 * Unit tests for the Claude Code session-hook script.
 *
 * Handles both SessionStart and SessionEnd events via hook_event_name.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/claude/plugin/scripts/discode-session-hook.js');

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

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    // Simulate stdin delivery
    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      // Wait for async main() to complete
      setTimeout(() => resolve({ calls: fetchCalls }), 50);
    }, 10);
  });
}

describe('discode-session-hook', () => {
  describe('SessionStart', () => {
    it('posts session.start event with source and model', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.start');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('claude');
      expect(payload.source).toBe('startup');
      expect(payload.model).toBe('claude-sonnet-4-6');
    });

    it('handles resume source', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'resume', model: 'claude-opus-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('resume');
      expect((result.calls[0].body as any).model).toBe('claude-opus-4-6');
    });

    it('handles clear source', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'clear', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('clear');
    });

    it('handles compact source', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'compact', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('compact');
    });

    it('handles missing model field', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).model).toBe('');
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
        { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-6' },
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
      expect(payload.agentType).toBe('claude');
      expect(payload.reason).toBe('logout');
    });

    it('handles prompt_input_exit reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('prompt_input_exit');
    });

    it('handles clear reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'clear' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('clear');
    });

    it('handles bypass_permissions_disabled reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'bypass_permissions_disabled' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('bypass_permissions_disabled');
    });

    it('handles other reason', async () => {
      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'other' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('other');
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

  it('does nothing when AGENT_DISCORD_PROJECT is not set', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'SessionStart', source: 'startup' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('does nothing for unknown hook_event_name', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'UnknownEvent' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('does nothing for missing hook_event_name', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { source: 'startup' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('uses custom AGENT_DISCORD_AGENT', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470', AGENT_DISCORD_AGENT: 'codex' },
      { hook_event_name: 'SessionStart', source: 'startup' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('codex');
  });

  it('uses custom AGENT_DISCORD_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '9999', AGENT_DISCORD_HOSTNAME: '10.0.0.1' },
      { hook_event_name: 'SessionEnd', reason: 'logout' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://10.0.0.1:9999/opencode-event');
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

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // With malformed JSON, hook_event_name is empty -> does nothing
    expect(fetchCalls).toHaveLength(0);
  });

  it('does nothing when AGENT_DISCORD_PROJECT is not set (SessionEnd)', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { hook_event_name: 'SessionEnd', reason: 'logout' },
    );

    expect(result.calls).toHaveLength(0);
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
});
