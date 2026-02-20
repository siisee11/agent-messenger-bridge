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
type ExtractThinkingBlocksFn = (node: unknown, depth?: number) => string[];
type ExtractToolUseBlocksFn = (node: unknown, depth?: number) => Array<{ name: string; input: Record<string, unknown> }>;
type FormatPromptTextFn = (toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>) => string;
type ReadAssistantEntryFn = (entry: unknown) => { messageId: string; text: string; thinking: string; toolUse: Array<{ name: string; input: Record<string, unknown> }> } | null;
type ParseTurnTextsFn = (tail: string) => { displayText: string; intermediateText: string; turnText: string; thinking: string; promptText: string };
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
    extractThinkingBlocks: (ctx as any).extractThinkingBlocks as ExtractThinkingBlocksFn,
    extractToolUseBlocks: (ctx as any).extractToolUseBlocks as ExtractToolUseBlocksFn,
    formatPromptText: (ctx as any).formatPromptText as FormatPromptTextFn,
    readAssistantEntry: (ctx as any).readAssistantEntry as ReadAssistantEntryFn,
    parseTurnTexts: (ctx as any).parseTurnTexts as ParseTurnTextsFn,
    readTail: (ctx as any).readTail as ReadTailFn,
  };
}

const { extractTextBlocks, extractThinkingBlocks, extractToolUseBlocks, formatPromptText, readAssistantEntry, parseTurnTexts, readTail } = loadHookFunctions();

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

// ── extractThinkingBlocks ─────────────────────────────────────────────

describe('extractThinkingBlocks', () => {
  it('extracts thinking from { type: "thinking", thinking: "..." }', () => {
    expect(extractThinkingBlocks({ type: 'thinking', thinking: 'Let me reason...' })).toEqual(['Let me reason...']);
  });

  it('returns empty for non-thinking blocks', () => {
    expect(extractThinkingBlocks({ type: 'text', text: 'hello' })).toEqual([]);
  });

  it('returns empty for empty thinking', () => {
    expect(extractThinkingBlocks({ type: 'thinking', thinking: '   ' })).toEqual([]);
  });

  it('extracts from arrays', () => {
    const input = [
      { type: 'thinking', thinking: 'Step 1' },
      { type: 'text', text: 'visible' },
      { type: 'thinking', thinking: 'Step 2' },
    ];
    expect(extractThinkingBlocks(input)).toEqual(['Step 1', 'Step 2']);
  });

  it('recurses into content arrays', () => {
    const input = {
      content: [
        { type: 'thinking', thinking: 'nested thinking' },
      ],
    };
    expect(extractThinkingBlocks(input)).toEqual(['nested thinking']);
  });

  it('returns empty for null/undefined', () => {
    expect(extractThinkingBlocks(null)).toEqual([]);
    expect(extractThinkingBlocks(undefined)).toEqual([]);
  });

  it('returns empty for strings and numbers', () => {
    expect(extractThinkingBlocks('hello')).toEqual([]);
    expect(extractThinkingBlocks(42)).toEqual([]);
  });

  it('stops recursion at depth 10', () => {
    let node: any = { type: 'thinking', thinking: 'deep' };
    for (let i = 0; i < 12; i++) {
      node = { content: [node] };
    }
    expect(extractThinkingBlocks(node)).toEqual([]);
  });

  it('extracts multiple thinking blocks from single content array', () => {
    const input = [
      { type: 'thinking', thinking: 'Step 1: analyze the code' },
      { type: 'text', text: 'visible response' },
      { type: 'thinking', thinking: 'Step 2: verify the fix' },
    ];
    expect(extractThinkingBlocks(input)).toEqual([
      'Step 1: analyze the code',
      'Step 2: verify the fix',
    ]);
  });

  it('ignores thinking property when type is not "thinking"', () => {
    // Some blocks might have a "thinking" property but not be thinking blocks
    expect(extractThinkingBlocks({ type: 'text', thinking: 'sneaky' })).toEqual([]);
  });

  it('ignores thinking when value is not a string', () => {
    expect(extractThinkingBlocks({ type: 'thinking', thinking: 42 })).toEqual([]);
    expect(extractThinkingBlocks({ type: 'thinking', thinking: ['array'] })).toEqual([]);
    expect(extractThinkingBlocks({ type: 'thinking', thinking: null })).toEqual([]);
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
    expect(result).toEqual({ messageId: 'msg_123', text: 'Hello!', thinking: '', toolUse: [] });
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
    expect(result).toEqual({ messageId: '', text: 'no id', thinking: '', toolUse: [] });
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

  it('extracts thinking from assistant entry', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'The answer is 42' },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.text).toBe('The answer is 42');
    expect(result?.thinking).toBe('Let me think...');
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
    expect(parseTurnTexts('')).toEqual({ displayText: '', intermediateText: '', turnText: '', thinking: '', promptText: '' });
    expect(parseTurnTexts(null as any)).toEqual({ displayText: '', intermediateText: '', turnText: '', thinking: '', promptText: '' });
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
    expect(result.intermediateText).toBe('First thinking');
  });

  it('returns intermediateText from earlier messageIds (before tool calls)', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '현재 분석 인프라를 파악하겠습니다.' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Task', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: '분석 결과입니다.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('분석 결과입니다.');
    expect(result.intermediateText).toBe('현재 분석 인프라를 파악하겠습니다.');
  });

  it('returns empty intermediateText when only one messageId has text', () => {
    const tail = line({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Only response' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Only response');
    expect(result.intermediateText).toBe('');
  });

  it('collects intermediateText from multiple earlier messageIds', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Step 1 narration' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Step 2 narration' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Final result' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final result');
    expect(result.intermediateText).toBe('Step 1 narration\nStep 2 narration');
  });

  it('does not include intermediateText from previous turn', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old narration' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('New answer');
    expect(result.intermediateText).toBe('');
  });

  it('intermediateText is empty when only tool_use (no text) in earlier messages', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Result' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Result');
    expect(result.intermediateText).toBe('');
  });

  it('intermediateText with whitespace-only earlier message is empty', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '   \n  ' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Done' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Done');
    // Whitespace-only text is not extracted by extractTextBlocks, so intermediateText should be empty
    expect(result.intermediateText).toBe('');
  });

  it('intermediateText with unicode and special characters preserved', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: '코드를 분석하겠습니다 🔍' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: '결과입니다' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.intermediateText).toBe('코드를 분석하겠습니다 🔍');
  });

  it('intermediateText preserves order of multiple earlier messages across tool calls', () => {
    // msg_A: text1 + tool → msg_B: text2 + tool → msg_C: final
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'First' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'Second' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Third' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'tool_use', id: 'tu_3', name: 'Edit', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3' }] } }),
      line({ type: 'assistant', message: { id: 'msg_D', content: [{ type: 'text', text: 'Final' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final');
    expect(result.intermediateText).toBe('First\nSecond\nThird');
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

  it('extracts thinking from single-message turn', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Let me reason about this...' },
          { type: 'text', text: 'The answer is 42' },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('The answer is 42');
    expect(result.thinking).toBe('Let me reason about this...');
  });

  it('collects thinking from ALL messageIds in the turn', () => {
    // In real transcripts, thinking appears in earlier messageIds (before tool calls)
    // but the final answer is in a different messageId. We must collect all thinking.
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'First reasoning' }, { type: 'text', text: 'Let me check' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'thinking', thinking: 'Second reasoning' }, { type: 'text', text: 'Final answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final answer');
    expect(result.thinking).toBe('First reasoning\nSecond reasoning');
  });

  it('collects thinking from earlier messageIds across tool calls (real transcript pattern)', () => {
    // This mirrors real Claude Code transcripts where:
    // - msg_A has thinking + tool_use
    // - tool_result entry
    // - msg_B has thinking + tool_use
    // - tool_result entry
    // - msg_C has the final text (NO thinking)
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'Let me search for the file' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Searching...' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'thinking', thinking: 'Found it, now analyzing' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Here is the final answer.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Here is the final answer.');
    // Thinking should be collected from msg_A and msg_B even though displayText is from msg_C
    expect(result.thinking).toBe('Let me search for the file\nFound it, now analyzing');
    // turnText includes all text from the turn
    expect(result.turnText).toContain('Searching...');
    expect(result.turnText).toContain('Here is the final answer.');
  });

  it('returns empty thinking when no thinking blocks present', () => {
    const tail = line({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Just text' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.thinking).toBe('');
  });

  it('combines multiple thinking parts across entries', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Part A' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Part B' }, { type: 'text', text: 'Answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.thinking).toBe('Part A\nPart B');
    expect(result.displayText).toBe('Answer');
  });

  it('collects thinking from 3+ messageIds in a long multi-step turn', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'Step 1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'thinking', thinking: 'Step 2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'thinking', thinking: 'Step 3' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'tool_use', id: 'tu_3', name: 'write', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3' }] } }),
      line({ type: 'assistant', message: { id: 'msg_D', content: [{ type: 'text', text: 'All done.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('All done.');
    expect(result.thinking).toBe('Step 1\nStep 2\nStep 3');
  });

  it('returns empty thinking for whitespace-only thinking blocks', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: '   \n  ' },
          { type: 'text', text: 'Answer' },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Answer');
    expect(result.thinking).toBe('');
  });

  it('handles thinking with special characters and unicode', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Let me think about 한국어 and emoji 🤔...\nStep 2: verify "quotes" & <tags>' },
          { type: 'text', text: 'Done' },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.thinking).toBe('Let me think about 한국어 and emoji 🤔...\nStep 2: verify "quotes" & <tags>');
  });

  it('handles turn with only thinking blocks and no final text', () => {
    // Edge case: all entries are thinking + tool_use, no final text message
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'Reasoning...' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('');
    expect(result.turnText).toBe('');
    expect(result.thinking).toBe('Reasoning...');
  });

  it('does not collect thinking from previous turn', () => {
    const tail = [
      // Previous turn
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'thinking', thinking: 'Old thinking' }] } }),
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old answer' }] } }),
      // Turn boundary
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      // Current turn (no thinking)
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('New answer');
    expect(result.thinking).toBe('');
  });
});

// ── extractToolUseBlocks ──────────────────────────────────────────────

describe('extractToolUseBlocks', () => {
  it('extracts tool_use block from content array', () => {
    const input = [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ];
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'Bash', input: { command: 'ls' } }]);
  });

  it('extracts multiple tool_use blocks', () => {
    const input = [
      { type: 'tool_use', name: 'Read', input: { file: 'a.ts' } },
      { type: 'text', text: 'between' },
      { type: 'tool_use', name: 'Edit', input: { file: 'b.ts' } },
    ];
    const result = extractToolUseBlocks(input);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Read');
    expect(result[1].name).toBe('Edit');
  });

  it('recurses into content arrays', () => {
    const input = {
      content: [
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } },
      ],
    };
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'AskUserQuestion', input: { questions: [] } }]);
  });

  it('returns empty for null/undefined', () => {
    expect(extractToolUseBlocks(null)).toEqual([]);
    expect(extractToolUseBlocks(undefined)).toEqual([]);
  });

  it('returns empty for strings and numbers', () => {
    expect(extractToolUseBlocks('hello')).toEqual([]);
    expect(extractToolUseBlocks(42)).toEqual([]);
  });

  it('stops recursion at depth 10', () => {
    let node: any = { type: 'tool_use', name: 'Bash', input: {} };
    for (let i = 0; i < 12; i++) {
      node = { content: [node] };
    }
    expect(extractToolUseBlocks(node)).toEqual([]);
  });

  it('defaults input to {} when missing', () => {
    const input = [{ type: 'tool_use', name: 'ExitPlanMode' }];
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'ExitPlanMode', input: {} }]);
  });

  it('defaults input to {} when not an object', () => {
    const input = [{ type: 'tool_use', name: 'Bash', input: 'invalid' }];
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'Bash', input: {} }]);
  });

  it('ignores tool_use without name', () => {
    const input = [{ type: 'tool_use', input: {} }];
    expect(extractToolUseBlocks(input)).toEqual([]);
  });
});

// ── formatPromptText ─────────────────────────────────────────────────

describe('formatPromptText', () => {
  it('formats AskUserQuestion with header and options', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Approach',
          question: 'Which approach?',
          options: [
            { label: 'Option A', description: 'Fast' },
            { label: 'Option B', description: 'Safe' },
          ],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('❓');
    expect(result).toContain('*Approach*');
    expect(result).toContain('Which approach?');
    expect(result).toContain('*Option A*');
    expect(result).toContain('Fast');
    expect(result).toContain('*Option B*');
    expect(result).toContain('Safe');
  });

  it('formats AskUserQuestion without descriptions', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Choice',
          question: 'Pick one?',
          options: [
            { label: 'Yes' },
            { label: 'No' },
          ],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('*Yes*');
    expect(result).toContain('*No*');
    expect(result).not.toContain('—');
  });

  it('formats AskUserQuestion without header', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Which one?',
          options: [{ label: 'A' }],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('❓ Which one?');
    // Should NOT have *header* format when header is missing
    expect(result).not.toMatch(/\*\w+\*\nWhich/);
  });

  it('formats ExitPlanMode', () => {
    const blocks = [{ name: 'ExitPlanMode', input: {} }];
    const result = formatPromptText(blocks);
    expect(result).toContain('Plan approval needed');
  });

  it('returns empty for non-interactive tools', () => {
    const blocks = [
      { name: 'Bash', input: { command: 'ls' } },
      { name: 'Read', input: { file: 'a.ts' } },
      { name: 'Edit', input: {} },
    ];
    expect(formatPromptText(blocks)).toBe('');
  });

  it('returns empty for empty array', () => {
    expect(formatPromptText([])).toBe('');
  });

  it('formats multiple questions', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [
          { header: 'Q1', question: 'First?', options: [{ label: 'A' }] },
          { header: 'Q2', question: 'Second?', options: [{ label: 'B' }] },
        ],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('First?');
    expect(result).toContain('Second?');
  });

  it('handles AskUserQuestion with missing questions array', () => {
    const blocks = [{ name: 'AskUserQuestion', input: {} }];
    expect(formatPromptText(blocks)).toBe('');
  });

  it('combines AskUserQuestion and ExitPlanMode in same array', () => {
    const blocks = [
      {
        name: 'AskUserQuestion',
        input: {
          questions: [{
            header: 'Choice',
            question: 'Pick?',
            options: [{ label: 'Yes' }],
          }],
        },
      },
      { name: 'ExitPlanMode', input: {} },
    ];
    const result = formatPromptText(blocks);
    expect(result).toContain('Pick?');
    expect(result).toContain('Plan approval needed');
  });

  it('ignores questions with empty question text', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [
          { header: 'H1', question: '', options: [{ label: 'A' }] },
          { header: 'H2', question: 'Real question?', options: [{ label: 'B' }] },
        ],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).not.toContain('H1');
    expect(result).toContain('Real question?');
  });

  it('ignores options with empty label', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Pick?',
          options: [
            { label: '', description: 'hidden' },
            { label: 'Visible', description: 'shown' },
          ],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).not.toContain('hidden');
    expect(result).toContain('*Visible*');
  });
});

// ── readAssistantEntry toolUse ────────────────────────────────────────

describe('readAssistantEntry toolUse', () => {
  it('extracts tool_use blocks from assistant entry', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Let me ask' },
          { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.toolUse).toEqual([{ name: 'AskUserQuestion', input: { questions: [] } }]);
  });

  it('returns empty toolUse when no tool_use blocks', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Just text' }],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.toolUse).toEqual([]);
  });
});

// ── parseTurnTexts promptText ─────────────────────────────────────────

describe('parseTurnTexts promptText', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it('returns promptText for AskUserQuestion', () => {
    const tail = line({
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
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toContain('Which approach do you prefer?');
    expect(result.promptText).toContain('*Fast*');
    expect(result.promptText).toContain('*Safe*');
  });

  it('returns promptText for ExitPlanMode', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', name: 'ExitPlanMode', input: {} },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toContain('Plan approval needed');
  });

  it('returns empty promptText for non-interactive tools', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Running command' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toBe('');
  });

  it('returns empty promptText when no tool_use blocks', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Just text' }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toBe('');
  });

  it('collects tool_use blocks across multiple messageIds in a turn', () => {
    // Tool_use in earlier messageId, text in later — both should contribute to promptText
    const tail = [
      line({
        type: 'assistant',
        message: {
          id: 'msg_A',
          content: [
            { type: 'text', text: 'Let me check something' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({
        type: 'assistant',
        message: {
          id: 'msg_B',
          content: [
            { type: 'text', text: 'Which approach?' },
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: {
                questions: [{
                  header: 'Approach',
                  question: 'Pick one?',
                  options: [{ label: 'A' }, { label: 'B' }],
                }],
              },
            },
          ],
        },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    // AskUserQuestion from msg_B should appear in promptText
    expect(result.promptText).toContain('Pick one?');
    expect(result.promptText).toContain('*A*');
    expect(result.promptText).toContain('*B*');
    expect(result.displayText).toBe('Which approach?');
  });

  it('does not carry promptText from previous turn', () => {
    const tail = [
      // Previous turn with AskUserQuestion
      line({
        type: 'assistant',
        message: {
          id: 'msg_old',
          content: [
            { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Old?' }] } },
          ],
        },
      }),
      // Turn boundary
      line({ type: 'user', message: { content: [{ type: 'text', text: 'User answered' }] } }),
      // Current turn — no tool_use
      line({
        type: 'assistant',
        message: { id: 'msg_new', content: [{ type: 'text', text: 'Thanks!' }] },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    expect(result.promptText).toBe('');
    expect(result.displayText).toBe('Thanks!');
  });

  it('formats both AskUserQuestion and ExitPlanMode in same turn', () => {
    const tail = [
      line({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Here is my plan' },
            { type: 'tool_use', name: 'ExitPlanMode', input: {} },
          ],
        },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    expect(result.promptText).toContain('Plan approval needed');
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
