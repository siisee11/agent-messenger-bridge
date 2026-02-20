/**
 * Unit tests for the Claude Code stop-hook script.
 *
 * The hook is a CJS script (not a module), so we load it into a VM
 * context and extract the pure functions for testing.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/claude/plugin/scripts/discode-stop-hook.js');

type ExtractTextBlocksFn = (node: unknown, depth?: number) => string[];
type ReadAssistantEntryFn = (entry: unknown) => { messageId: string; text: string } | null;
type ParseTurnTextsFn = (tail: string) => { displayText: string; turnText: string };
type ReadTailFn = (filePath: string, maxBytes: number) => string;

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  // Strip the self-executing main() so it doesn't run
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

  new Script(src, { filename: 'discode-stop-hook.js' }).runInContext(ctx);

  return {
    extractTextBlocks: (ctx as any).extractTextBlocks as ExtractTextBlocksFn,
    readAssistantEntry: (ctx as any).readAssistantEntry as ReadAssistantEntryFn,
    parseTurnTexts: (ctx as any).parseTurnTexts as ParseTurnTextsFn,
    readTail: (ctx as any).readTail as ReadTailFn,
  };
}

const { extractTextBlocks, readAssistantEntry, parseTurnTexts, readTail } = loadHookFunctions();

// ── extractTextBlocks ────────────────────────────────────────────────

describe('extractTextBlocks', () => {
  it('returns string in array for plain string', () => {
    expect(extractTextBlocks('hello')).toEqual(['hello']);
  });

  it('returns empty array for empty string', () => {
    expect(extractTextBlocks('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(extractTextBlocks('   ')).toEqual([]);
  });

  it('extracts text from { type: "text", text: "..." }', () => {
    expect(extractTextBlocks({ type: 'text', text: 'hello' })).toEqual(['hello']);
  });

  it('returns empty for text block with empty text', () => {
    expect(extractTextBlocks({ type: 'text', text: '   ' })).toEqual([]);
  });

  it('extracts text from array of text blocks', () => {
    const input = [
      { type: 'text', text: 'part1' },
      { type: 'text', text: 'part2' },
    ];
    expect(extractTextBlocks(input)).toEqual(['part1', 'part2']);
  });

  it('recurses into content arrays', () => {
    const input = {
      content: [
        { type: 'text', text: 'nested' },
      ],
    };
    expect(extractTextBlocks(input)).toEqual(['nested']);
  });

  it('recurses into content string', () => {
    const input = { content: 'direct string' };
    expect(extractTextBlocks(input)).toEqual(['direct string']);
  });

  it('returns empty for null', () => {
    expect(extractTextBlocks(null)).toEqual([]);
  });

  it('returns empty for undefined', () => {
    expect(extractTextBlocks(undefined)).toEqual([]);
  });

  it('returns empty for number', () => {
    expect(extractTextBlocks(42)).toEqual([]);
  });

  it('stops recursion at depth 10', () => {
    // Build deeply nested structure
    let node: any = { type: 'text', text: 'deep' };
    for (let i = 0; i < 12; i++) {
      node = { content: [node] };
    }
    expect(extractTextBlocks(node)).toEqual([]);
  });

  it('extracts from object with text property but no type', () => {
    expect(extractTextBlocks({ text: 'implicit' })).toEqual(['implicit']);
  });

  it('skips tool_use blocks', () => {
    const input = [
      { type: 'text', text: 'before' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
      { type: 'text', text: 'after' },
    ];
    expect(extractTextBlocks(input)).toEqual(['before', 'after']);
  });
});

// ── readAssistantEntry ───────────────────────────────────────────────

describe('readAssistantEntry', () => {
  it('extracts text from assistant entry with message wrapper', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello!' }],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result).toEqual({ messageId: 'msg_123', text: 'Hello!' });
  });

  it('returns null for non-assistant entry', () => {
    expect(readAssistantEntry({ type: 'user', message: {} })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(readAssistantEntry(null)).toBeNull();
  });

  it('returns null for array input', () => {
    expect(readAssistantEntry([1, 2, 3])).toBeNull();
  });

  it('handles entry without message.id', () => {
    const entry = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'no id' }],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result).toEqual({ messageId: '', text: 'no id' });
  });

  it('joins multiple text blocks with newline', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.text).toBe('line1\nline2');
  });

  it('returns empty text when content has no text blocks', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash' },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.text).toBe('');
  });
});

// ── parseTurnTexts ───────────────────────────────────────────────────

describe('parseTurnTexts', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it('returns empty for null/empty input', () => {
    expect(parseTurnTexts('')).toEqual({ displayText: '', turnText: '' });
    expect(parseTurnTexts(null as any)).toEqual({ displayText: '', turnText: '' });
  });

  it('extracts text from single assistant entry', () => {
    const tail = line({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Done!' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Done!');
    expect(result.turnText).toBe('Done!');
  });

  it('combines multiple entries with same messageId', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Part 1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Part 2' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Part 1\nPart 2');
    expect(result.turnText).toBe('Part 1\nPart 2');
  });

  it('uses latest messageId for displayText but all for turnText', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'First thinking' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Final answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final answer');
    expect(result.turnText).toBe('First thinking\nFinal answer');
  });

  it('stops at user message with text content', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Old question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old answer' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    // Should only see text after the last real user message
    expect(result.displayText).toBe('New answer');
    expect(result.turnText).toBe('New answer');
  });

  it('skips tool_result user entries (continues scanning)', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Run tests' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Running...' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Tests passed!' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    // tool_result is skipped, turn boundary is "Run tests"
    expect(result.displayText).toBe('Running...\nTests passed!');
    expect(result.turnText).toBe('Running...\nTests passed!');
  });

  it('skips progress and system entries', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Working...' }] } }),
      line({ type: 'progress', data: { percent: 50 } }),
      line({ type: 'system', message: 'rate limit' }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Done!' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Working...\nDone!');
    expect(result.turnText).toBe('Working...\nDone!');
  });

  it('handles malformed JSON lines gracefully', () => {
    const tail = [
      'not json at all',
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Valid' }] } }),
      '{ broken json',
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Valid');
  });

  it('returns empty when no assistant entries found', () => {
    const tail = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('');
    expect(result.turnText).toBe('');
  });

  it('handles trailing empty lines', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Answer' }] } }),
      '',
      '',
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Answer');
  });

  it('handles assistant entry without messageId', () => {
    const tail = line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'No ID entry' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('No ID entry');
    expect(result.turnText).toBe('No ID entry');
  });
});

// ── readTail ──────────────────────────────────────────────────────────

describe('readTail', () => {
  let tempDir: string;

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-stophook-test-'));
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  it('reads the entire file when maxBytes >= file size', () => {
    setup();
    try {
      const filePath = join(tempDir, 'small.jsonl');
      writeFileSync(filePath, 'hello world');
      const result = readTail(filePath, 65536);
      expect(result).toBe('hello world');
    } finally {
      teardown();
    }
  });

  it('reads only the tail when maxBytes < file size', () => {
    setup();
    try {
      const filePath = join(tempDir, 'large.jsonl');
      writeFileSync(filePath, 'AAAA' + 'BBBB');
      const result = readTail(filePath, 4);
      expect(result).toBe('BBBB');
    } finally {
      teardown();
    }
  });

  it('returns empty string for empty file', () => {
    setup();
    try {
      const filePath = join(tempDir, 'empty.jsonl');
      writeFileSync(filePath, '');
      const result = readTail(filePath, 65536);
      expect(result).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns empty string for non-existent file', () => {
    const result = readTail('/tmp/nonexistent-file-' + Date.now() + '.jsonl', 65536);
    expect(result).toBe('');
  });

  it('handles multi-line JSONL transcript', () => {
    setup();
    try {
      const filePath = join(tempDir, 'transcript.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'question' }] } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'answer' }] } }),
      ];
      writeFileSync(filePath, lines.join('\n'));
      const tail = readTail(filePath, 65536);
      // Should be parseable by parseTurnTexts
      const result = parseTurnTexts(tail);
      expect(result.displayText).toBe('answer');
    } finally {
      teardown();
    }
  });

  it('reads tail of large transcript correctly', () => {
    setup();
    try {
      const filePath = join(tempDir, 'large-transcript.jsonl');
      // Write many lines, then check that tail captures the last entries
      const filler = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ type: 'progress', index: i })
      ).join('\n');
      const lastLine = JSON.stringify({ type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: 'Final answer' }] } });
      writeFileSync(filePath, filler + '\n' + lastLine);

      // Read only last 512 bytes (should capture the last line)
      const tail = readTail(filePath, 512);
      expect(tail).toContain('Final answer');
    } finally {
      teardown();
    }
  });
});
