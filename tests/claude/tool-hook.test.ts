/**
 * Unit tests for the Claude Code PostToolUse hook script.
 *
 * The hook is a CJS script (not a module), so we load it into a VM
 * context and extract the pure functions for testing, and also run
 * full integration tests via a simulated stdin/fetch environment.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/claude/plugin/scripts/discode-tool-hook.js');

type FormatToolLineFn = (toolName: string, toolInput: Record<string, unknown>) => string;
type ShortenPathFn = (fp: string, maxSegments: number) => string;
type FirstLinePreviewFn = (str: string, maxLen: number) => string;

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  // Strip the self-executing main() so it doesn't run
  const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

  const ctx = createContext({
    require: () => ({}),
    process: { env: {}, stdin: { isTTY: true } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    fetch: async () => ({}),
    JSON,
    Array,
    Object,
    Math,
    Number,
    String,
    parseInt,
    parseFloat,
  });

  new Script(src, { filename: 'discode-tool-hook.js' }).runInContext(ctx);

  return {
    formatToolLine: (ctx as any).formatToolLine as FormatToolLineFn,
    shortenPath: (ctx as any).shortenPath as ShortenPathFn,
    firstLinePreview: (ctx as any).firstLinePreview as FirstLinePreviewFn,
  };
}

const { formatToolLine, shortenPath, firstLinePreview } = loadHookFunctions();

// ── shortenPath ──────────────────────────────────────────────────────

describe('shortenPath', () => {
  it('returns last N segments of a long path', () => {
    expect(shortenPath('/home/user/project/src/index.ts', 4)).toBe('user/project/src/index.ts');
  });

  it('returns full path when segments <= maxSegments', () => {
    expect(shortenPath('/src/index.ts', 4)).toBe('src/index.ts');
  });

  it('handles single segment', () => {
    expect(shortenPath('/file.ts', 4)).toBe('file.ts');
  });

  it('handles deep paths', () => {
    expect(shortenPath('/a/b/c/d/e/f.ts', 3)).toBe('d/e/f.ts');
  });

  it('returns empty for empty string', () => {
    expect(shortenPath('', 4)).toBe('');
  });

  it('handles maxSegments of 1', () => {
    expect(shortenPath('/home/user/project/index.ts', 1)).toBe('index.ts');
  });

  it('handles path without leading slash', () => {
    expect(shortenPath('src/components/Button.tsx', 3)).toBe('src/components/Button.tsx');
  });

  it('filters out empty segments from trailing slash', () => {
    expect(shortenPath('/home/user/', 4)).toBe('home/user');
  });
});

// ── firstLinePreview ─────────────────────────────────────────────────

describe('firstLinePreview', () => {
  it('returns first line trimmed', () => {
    expect(firstLinePreview('hello world\nsecond line', 40)).toBe('hello world');
  });

  it('truncates long first line', () => {
    expect(firstLinePreview('x'.repeat(50), 20)).toBe('x'.repeat(20) + '...');
  });

  it('returns empty for empty string', () => {
    expect(firstLinePreview('', 40)).toBe('');
  });

  it('returns empty for null/undefined', () => {
    expect(firstLinePreview(null as any, 40)).toBe('');
    expect(firstLinePreview(undefined as any, 40)).toBe('');
  });

  it('trims whitespace from first line', () => {
    expect(firstLinePreview('  hello  \nsecond', 40)).toBe('hello');
  });

  it('returns first line when exactly at maxLen', () => {
    expect(firstLinePreview('abcde', 5)).toBe('abcde');
  });
});

// ── formatToolLine ───────────────────────────────────────────────────

describe('formatToolLine', () => {
  it('formats Read with shortened path', () => {
    expect(formatToolLine('Read', { file_path: '/home/user/project/src/index.ts' }))
      .toBe('📖 Read(`user/project/src/index.ts`)');
  });

  it('formats Read with short path', () => {
    expect(formatToolLine('Read', { file_path: '/CLAUDE.md' }))
      .toBe('📖 Read(`CLAUDE.md`)');
  });

  it('skips Read with missing file_path', () => {
    expect(formatToolLine('Read', {})).toBe('');
  });

  it('formats Edit with line delta and preview', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/app.ts',
      old_string: 'line1',
      new_string: 'line1\nline2\nline3\nline4\nline5\nline6',
    });
    expect(result).toContain('✏️ Edit(`src/app.ts`)');
    expect(result).toContain('+5 lines');
    expect(result).toContain('— "line1"');
  });

  it('formats Edit with negative line delta', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/app.ts',
      old_string: 'a\nb\nc\nd',
      new_string: 'a',
    });
    expect(result).toContain('-3 lines');
  });

  it('formats Edit with no line change — shows preview only', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/app.ts',
      old_string: 'old text',
      new_string: 'new text',
    });
    expect(result).toBe('✏️ Edit(`src/app.ts`) — "new text"');
  });

  it('skips Edit with missing file_path', () => {
    expect(formatToolLine('Edit', { old_string: 'a', new_string: 'b' })).toBe('');
  });

  it('formats Write with line count', () => {
    expect(formatToolLine('Write', { file_path: '/src/new.ts', content: 'a\nb\nc' }))
      .toBe('📝 Write(`src/new.ts`) 3 lines');
  });

  it('formats Write without content', () => {
    expect(formatToolLine('Write', { file_path: '/src/new.ts' }))
      .toBe('📝 Write(`src/new.ts`)');
  });

  it('skips Write with missing file_path', () => {
    expect(formatToolLine('Write', {})).toBe('');
  });

  it('formats Bash with command', () => {
    expect(formatToolLine('Bash', { command: 'npm run test' }))
      .toBe('💻 `npm run test`');
  });

  it('truncates long Bash command to 100 chars', () => {
    const longCmd = 'x'.repeat(120);
    const result = formatToolLine('Bash', { command: longCmd });
    expect(result).toBe('💻 `' + 'x'.repeat(100) + '...`');
  });

  it('skips Bash with missing command', () => {
    expect(formatToolLine('Bash', {})).toBe('');
  });

  it('returns empty for non-file tools', () => {
    expect(formatToolLine('Grep', { pattern: 'foo' })).toBe('');
    expect(formatToolLine('Glob', { pattern: '*.ts' })).toBe('');
    expect(formatToolLine('AskUserQuestion', { questions: [] })).toBe('');
    expect(formatToolLine('Task', {})).toBe('');
    expect(formatToolLine('ExitPlanMode', {})).toBe('');
  });

  it('handles null/undefined toolInput', () => {
    expect(formatToolLine('Read', null as any)).toBe('');
    expect(formatToolLine('Read', undefined as any)).toBe('');
  });

  it('formats Edit insertion (empty old_string)', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/utils.ts',
      old_string: '',
      new_string: 'const x = 1;\nconst y = 2;\nconst z = 3;',
    });
    expect(result).toContain('✏️ Edit(`src/utils.ts`)');
    expect(result).toContain('+3 lines');
    expect(result).toContain('— "const x = 1;"');
  });

  it('formats Edit deletion (empty new_string) — no preview', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/index.ts',
      old_string: 'line1\nline2\nline3',
      new_string: '',
    });
    expect(result).toContain('-3 lines');
    expect(result).not.toContain('—');
  });

  it('truncates long Edit preview at 40 chars', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/app.ts',
      old_string: 'a',
      new_string: 'x'.repeat(60),
    });
    expect(result).toContain('— "' + 'x'.repeat(40) + '..."');
  });

  it('formats Edit preview using only first line of multiline new_string', () => {
    const result = formatToolLine('Edit', {
      file_path: '/src/config.ts',
      old_string: 'old',
      new_string: 'export const config = {\n  port: 3000,\n};',
    });
    expect(result).toContain('— "export const config = {"');
    expect(result).not.toContain('port: 3000');
  });

  it('formats Write with single-line content showing 1 lines', () => {
    expect(formatToolLine('Write', { file_path: '/tmp/out.txt', content: 'single line' }))
      .toBe('📝 Write(`tmp/out.txt`) 1 lines');
  });

  it('formats Bash command at exactly 100 chars without truncation', () => {
    const cmd = 'x'.repeat(100);
    expect(formatToolLine('Bash', { command: cmd })).toBe('💻 `' + cmd + '`');
  });

  it('handles non-string file_path gracefully', () => {
    expect(formatToolLine('Read', { file_path: 123 })).toBe('');
    expect(formatToolLine('Edit', { file_path: null })).toBe('');
    expect(formatToolLine('Write', { file_path: undefined })).toBe('');
  });

  it('handles non-string command gracefully', () => {
    expect(formatToolLine('Bash', { command: 42 })).toBe('');
  });

  it('formats Read with dotfile path', () => {
    expect(formatToolLine('Read', { file_path: '/home/user/.claude/skills/deploy/SKILL.md' }))
      .toBe('📖 Read(`.claude/skills/deploy/SKILL.md`)');
  });
});

// ── integration: full hook execution ─────────────────────────────────

describe('tool-hook integration', () => {
  function runHook(
    env: Record<string, string>,
    stdinJson: unknown,
  ): Promise<{ calls: Array<{ url: string; body: unknown }> }> {
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

      new Script(raw, { filename: 'discode-tool-hook.js' }).runInContext(ctx);

      // Feed stdin
      if (onData) onData(stdinData);
      if (onEnd) onEnd();

      // Wait for async main to complete
      setTimeout(() => resolve({ calls: fetchCalls }), 100);
    });
  }

  it('sends tool.activity for Read tool', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Read', tool_input: { file_path: '/src/index.ts' } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      projectName: 'myproj',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
  });

  it('sends tool.activity for Edit tool with line delta', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Edit', tool_input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'a\nb\nc' } },
    );
    expect(calls).toHaveLength(1);
    const body = calls[0].body as any;
    expect(body.type).toBe('tool.activity');
    expect(body.text).toContain('✏️ Edit(`src/app.ts`)');
    expect(body.text).toContain('+2 lines');
  });

  it('sends tool.activity for Bash tool', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    );
    expect(calls).toHaveLength(1);
    const body = calls[0].body as any;
    expect(body.text).toBe('💻 `npm test`');
  });

  it('does not send for non-file tools', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Grep', tool_input: { pattern: 'foo' } },
    );
    expect(calls).toHaveLength(0);
  });

  it('does not send when AGENT_DISCORD_PROJECT is empty', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Read', tool_input: { file_path: '/src/index.ts' } },
    );
    expect(calls).toHaveLength(0);
  });

  it('includes instanceId when provided', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_INSTANCE: 'inst-A', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Write', tool_input: { file_path: '/src/new.ts', content: 'hello\nworld' } },
    );
    expect(calls).toHaveLength(1);
    const body = calls[0].body as any;
    expect(body.instanceId).toBe('inst-A');
    expect(body.text).toContain('📝 Write(`src/new.ts`)');
  });

  it('uses custom hostname from env', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_HOSTNAME: '192.168.1.5', AGENT_DISCORD_PORT: '9999' },
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://192.168.1.5:9999/opencode-event');
  });

  it('sends tool.activity for Write tool', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Write', tool_input: { file_path: '/src/new.ts', content: 'a\nb\nc' } },
    );
    expect(calls).toHaveLength(1);
    const body = calls[0].body as any;
    expect(body.type).toBe('tool.activity');
    expect(body.text).toBe('📝 Write(`src/new.ts`) 3 lines');
  });

  it('does not send for AskUserQuestion', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'AskUserQuestion', tool_input: { questions: [] } },
    );
    expect(calls).toHaveLength(0);
  });

  it('does not send for Glob', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Glob', tool_input: { pattern: '*.ts' } },
    );
    expect(calls).toHaveLength(0);
  });

  it('does not send for Task', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Task', tool_input: {} },
    );
    expect(calls).toHaveLength(0);
  });

  it('handles malformed stdin JSON gracefully', async () => {
    // Override runHook to send non-JSON stdin
    const { calls } = await new Promise<{ calls: Array<{ url: string; body: unknown }> }>((resolve) => {
      const raw = readFileSync(hookPath, 'utf-8');
      const fetchCalls: Array<{ url: string; body: unknown }> = [];
      let onData: ((chunk: string) => void) | null = null;
      let onEnd: (() => void) | null = null;

      const ctx = createContext({
        require: () => ({}),
        process: {
          env: { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
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
        Promise, setTimeout, Buffer, JSON, Array, Object, String, Number, Math, parseInt, parseFloat,
        fetch: async (url: string, opts: any) => {
          fetchCalls.push({ url, body: JSON.parse(opts.body) });
          return {};
        },
      });

      new Script(raw, { filename: 'discode-tool-hook.js' }).runInContext(ctx);
      if (onData) onData('not-json{{{');
      if (onEnd) onEnd();
      setTimeout(() => resolve({ calls: fetchCalls }), 100);
    });
    // Should not crash or send anything
    expect(calls).toHaveLength(0);
  });

  it('handles empty tool_name gracefully', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: '', tool_input: { file_path: '/src/a.ts' } },
    );
    expect(calls).toHaveLength(0);
  });

  it('handles missing tool_input gracefully', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Read' },
    );
    // tool_input defaults to {}, Read needs file_path → empty → skipped
    expect(calls).toHaveLength(0);
  });

  it('handles non-string tool_name gracefully', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 42, tool_input: { file_path: '/src/a.ts' } },
    );
    expect(calls).toHaveLength(0);
  });

  it('uses default port 18470 when AGENT_DISCORD_PORT not set', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude' },
      { tool_name: 'Read', tool_input: { file_path: '/src/index.ts' } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:18470/opencode-event');
  });

  it('uses default agentType "claude" when not set', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Read', tool_input: { file_path: '/src/index.ts' } },
    );
    expect(calls).toHaveLength(1);
    expect((calls[0].body as any).agentType).toBe('claude');
  });

  it('does not include instanceId when not set', async () => {
    const { calls } = await runHook(
      { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
      { tool_name: 'Read', tool_input: { file_path: '/src/index.ts' } },
    );
    expect(calls).toHaveLength(1);
    expect((calls[0].body as any).instanceId).toBeUndefined();
  });

  it('ignores fetch failure gracefully', async () => {
    // Run hook with fetch that throws — should not throw
    const result = await new Promise<{ calls: number }>((resolve) => {
      const raw = readFileSync(hookPath, 'utf-8');
      let fetchCallCount = 0;
      let onData: ((chunk: string) => void) | null = null;
      let onEnd: (() => void) | null = null;

      const ctx = createContext({
        require: () => ({}),
        process: {
          env: { AGENT_DISCORD_PROJECT: 'myproj', AGENT_DISCORD_AGENT: 'claude', AGENT_DISCORD_PORT: '18470' },
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
        Promise, setTimeout, Buffer, JSON, Array, Object, String, Number, Math, parseInt, parseFloat,
        fetch: async () => {
          fetchCallCount++;
          throw new Error('Connection refused');
        },
      });

      new Script(raw, { filename: 'discode-tool-hook.js' }).runInContext(ctx);
      if (onData) onData(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/src/a.ts' } }));
      if (onEnd) onEnd();
      setTimeout(() => resolve({ calls: fetchCallCount }), 100);
    });
    // fetch was called but failure was swallowed
    expect(result.calls).toBe(1);
  });
});
