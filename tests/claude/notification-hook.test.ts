/**
 * Unit tests for the Claude Code notification-hook script.
 *
 * The hook is a CJS script (not a module), so we validate its structure
 * and bridge POST payload using a VM context.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
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

    const realFs = require('fs');
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === 'fs') return realFs;
        return {};
      },
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
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
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

// Also load functions via VM for unit testing extractPromptFromTranscript
type ExtractPromptFromTranscriptFn = (transcriptPath: string) => string;
type FormatPromptTextFn = (toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>) => string;

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

  const realFs = require('fs');
  const ctx = createContext({
    require: (mod: string) => {
      if (mod === 'fs') return realFs;
      return {};
    },
    process: { env: {}, stdin: { isTTY: true } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    JSON,
    Array,
    Object,
    Math,
    Number,
    String,
    parseInt,
    parseFloat,
  });

  new Script(src, { filename: 'discode-notification-hook.js' }).runInContext(ctx);

  return {
    extractPromptFromTranscript: (ctx as any).extractPromptFromTranscript as ExtractPromptFromTranscriptFn,
    formatPromptText: (ctx as any).formatPromptText as FormatPromptTextFn,
  };
}

const { extractPromptFromTranscript, formatPromptText } = loadHookFunctions();

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

    const realFs = require('fs');
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === 'fs') return realFs;
        return {};
      },
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
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
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

    const realFs = require('fs');
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === 'fs') return realFs;
        return {};
      },
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
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
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

    const realFs = require('fs');
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === 'fs') return realFs;
        return {};
      },
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
      Buffer,
      JSON,
      Array,
      Object,
      String,
      Number,
      Math,
      parseInt,
      parseFloat,
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

// ── extractPromptFromTranscript ──────────────────────────────────────

describe('extractPromptFromTranscript', () => {
  let tempDir: string;

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-notif-test-'));
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  function writeTranscript(lines: unknown[]): string {
    const filePath = join(tempDir, 'transcript.jsonl');
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
    return filePath;
  }

  it('extracts AskUserQuestion prompt from transcript', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Help me decide' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Which approach?' },
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Approach',
                    question: 'Which approach do you prefer?',
                    options: [
                      { label: 'Fast', description: 'Quick but risky' },
                      { label: 'Safe', description: 'Slow but reliable' },
                    ],
                  }],
                },
              },
            ],
          },
        },
      ]);
      const result = extractPromptFromTranscript(fp);
      expect(result).toContain('Which approach do you prefer?');
      expect(result).toContain('*Fast*');
      expect(result).toContain('Quick but risky');
      expect(result).toContain('*Safe*');
      expect(result).toContain('Slow but reliable');
    } finally {
      teardown();
    }
  });

  it('extracts ExitPlanMode prompt from transcript', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Plan this' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Here is my plan' },
              { type: 'tool_use', name: 'ExitPlanMode', input: {} },
            ],
          },
        },
      ]);
      const result = extractPromptFromTranscript(fp);
      expect(result).toContain('Plan approval needed');
    } finally {
      teardown();
    }
  });

  it('returns empty string when no tool_use blocks in turn', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } },
        {
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'Hi there' }] },
        },
      ]);
      expect(extractPromptFromTranscript(fp)).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns empty string when only non-prompt tool_use (Bash, Read, etc.)', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Do stuff' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/a.ts' } },
            ],
          },
        },
      ]);
      expect(extractPromptFromTranscript(fp)).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns empty string for empty transcript path', () => {
    expect(extractPromptFromTranscript('')).toBe('');
  });

  it('returns empty string for non-existent transcript file', () => {
    expect(extractPromptFromTranscript('/tmp/nonexistent-' + Date.now() + '.jsonl')).toBe('');
  });

  it('does not pick up prompt from previous turn', () => {
    setup();
    try {
      const fp = writeTranscript([
        // Previous turn with AskUserQuestion
        { type: 'user', message: { content: [{ type: 'text', text: 'First question' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_old',
            content: [
              { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Old question?', options: [{ label: 'A' }] }] } },
            ],
          },
        },
        // Turn boundary
        { type: 'user', message: { content: [{ type: 'text', text: 'User answered' }] } },
        // Current turn — no prompt
        {
          type: 'assistant',
          message: { id: 'msg_new', content: [{ type: 'text', text: 'Thanks!' }] },
        },
      ]);
      expect(extractPromptFromTranscript(fp)).toBe('');
    } finally {
      teardown();
    }
  });

  it('collects prompt across tool calls in same turn', () => {
    setup();
    try {
      const fp = writeTranscript([
        { type: 'user', message: { content: [{ type: 'text', text: 'Do something' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_A',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } },
        {
          type: 'assistant',
          message: {
            id: 'msg_B',
            content: [
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Choice',
                    question: 'Which option?',
                    options: [{ label: 'X' }, { label: 'Y' }],
                  }],
                },
              },
            ],
          },
        },
      ]);
      const result = extractPromptFromTranscript(fp);
      expect(result).toContain('Which option?');
      expect(result).toContain('*X*');
      expect(result).toContain('*Y*');
    } finally {
      teardown();
    }
  });
});

// ── notification hook with transcript (integration) ─────────────────

describe('notification hook with transcript', () => {
  let tempDir: string;

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-notif-integ-'));
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  it('includes promptText in payload when transcript has AskUserQuestion', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Help' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Let me ask you' },
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    header: 'Library',
                    question: 'Which library should we use?',
                    options: [
                      { label: 'React', description: 'Popular UI library' },
                      { label: 'Vue', description: 'Progressive framework' },
                    ],
                  }],
                },
              },
            ],
          },
        }),
      ].join('\n'));

      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'myproject', AGENT_DISCORD_PORT: '18470' },
        {
          message: 'Claude Code needs your attention',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.notification');
      expect(payload.text).toBe('Claude Code needs your attention');
      expect(typeof payload.promptText).toBe('string');
      expect(payload.promptText as string).toContain('Which library should we use?');
      expect(payload.promptText as string).toContain('*React*');
      expect(payload.promptText as string).toContain('Popular UI library');
      expect(payload.promptText as string).toContain('*Vue*');
    } finally {
      teardown();
    }
  });

  it('omits promptText when transcript has no prompt tools', async () => {
    setup();
    try {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Run tests' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            ],
          },
        }),
      ].join('\n'));

      const result = await runHook(
        { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
        {
          message: 'Claude is idle',
          notification_type: 'idle_prompt',
          transcript_path: transcriptPath,
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.promptText).toBeUndefined();
    } finally {
      teardown();
    }
  });

  it('omits promptText when no transcript_path provided', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'proj', AGENT_DISCORD_PORT: '18470' },
      { message: 'Notification', notification_type: 'permission_prompt' },
    );

    expect(result.calls).toHaveLength(1);
    const payload = result.calls[0].body as Record<string, unknown>;
    expect(payload.promptText).toBeUndefined();
  });
});
