import {
  stripAnsi,
  cleanCapture,
  splitForDiscord,
  splitForSlack,
  stripOuterCodeblock,
  stripFilePaths,
  extractFilePaths,
  renderTerminalSnapshot,
} from '../../src/capture/parser.js';

describe('stripAnsi', () => {
  it('returns plain text unchanged', () => {
    const plain = 'hello world';
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('strips color codes', () => {
    const input = '\x1B[31mred\x1B[0m normal';
    expect(stripAnsi(input)).toBe('red normal');
  });

  it('strips bold and underline codes', () => {
    const input = '\x1B[1mbold\x1B[0m \x1B[4munderline\x1B[0m';
    expect(stripAnsi(input)).toBe('bold underline');
  });

  it('strips cursor movement codes', () => {
    const input = '\x1B[2Jclear\x1B[H move';
    expect(stripAnsi(input)).toBe('clear move');
  });

  it('strips OSC sequences with BEL terminator', () => {
    const input = '\x1B]0;window title\x07content';
    expect(stripAnsi(input)).toBe('content');
  });

  it('strips OSC sequences with ST terminator', () => {
    const input = '\x1B]0;title\x1B\\content';
    expect(stripAnsi(input)).toBe('content');
  });

  it('strips charset sequences', () => {
    // Regex only matches \x1B([A-Z]), so \x1B(B is stripped but \x1B(0 is not
    expect(stripAnsi('\x1B(Btext')).toBe('text');
    expect(stripAnsi('\x1B(Atext\x1B(Bmore')).toBe('textmore');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles multiple mixed ANSI codes in one string', () => {
    const input = '\x1B[31m\x1B[1mred bold\x1B[0m \x1B]0;title\x07\x1B[4munderline\x1B[0m';
    expect(stripAnsi(input)).toBe('red bold underline');
  });
});

describe('cleanCapture', () => {
  it('strips ANSI and removes trailing blank lines', () => {
    const input = '\x1B[32mgreen\x1B[0m\ntext\n\n\n';
    expect(cleanCapture(input)).toBe('green\ntext');
  });

  it('preserves internal blank lines', () => {
    const input = 'line1\n\nline3\n\n';
    expect(cleanCapture(input)).toBe('line1\n\nline3');
  });

  it('returns empty string for all-blank input', () => {
    expect(cleanCapture('\n\n\n')).toBe('');
  });

  it('handles content with no trailing blanks', () => {
    const input = 'line1\nline2';
    expect(cleanCapture(input)).toBe('line1\nline2');
  });

  it('handles mixed ANSI and trailing blanks', () => {
    const input = '\x1B[1mbold\x1B[0m\n\x1B[31mred\x1B[0m\n\n';
    expect(cleanCapture(input)).toBe('bold\nred');
  });
});

describe('splitForDiscord', () => {
  it('returns single-element array for short text', () => {
    const short = 'hello world';
    const result = splitForDiscord(short);
    expect(result).toEqual([short]);
  });

  it('splits long text at line boundaries', () => {
    const lines = Array(100).fill('line').join('\n');
    const result = splitForDiscord(lines, 200);
    expect(result.length).toBeGreaterThan(1);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(200);
    });
  });

  it('respects custom maxLen parameter', () => {
    const text = 'a'.repeat(500);
    const result = splitForDiscord(text, 100);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(100);
    });
  });

  it('truncates single long line exceeding maxLen', () => {
    const longLine = 'x'.repeat(2500);
    const result = splitForDiscord(longLine, 1900);
    expect(result.length).toBeGreaterThan(0);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    });
  });

  it('handles empty string', () => {
    const result = splitForDiscord('');
    expect(result).toEqual(['']);
  });

  it('each chunk is under maxLen with default value', () => {
    const longText = Array(200).fill('some longer line content').join('\n');
    const result = splitForDiscord(longText);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    });
  });

  it('preserves line structure when possible', () => {
    const text = 'line1\nline2\nline3';
    const result = splitForDiscord(text, 100);
    result.forEach(chunk => {
      expect(chunk.split('\n').every(line => line.length <= 100)).toBe(true);
    });
  });

  it('strips outer codeblock before splitting', () => {
    const text = '```\nhello world\n```';
    const result = splitForDiscord(text);
    expect(result).toEqual(['hello world']);
  });

  it('strips outer codeblock with language tag before splitting', () => {
    const text = '```typescript\nconst x = 1;\n```';
    const result = splitForDiscord(text);
    expect(result).toEqual(['const x = 1;']);
  });

  it('preserves nested codeblocks after stripping outer', () => {
    const text = '```\nsome text\n```js\ncode\n```\nmore text\n```';
    const result = splitForDiscord(text);
    expect(result[0]).toContain('```js');
  });

  it('closes unclosed codeblock at chunk boundary and re-opens in next chunk', () => {
    // Build text with explanation + a codeblock that will span chunks
    // (pure codeblock would be stripped by stripOuterCodeblock, so add prefix text)
    const yamlLines = Array(50).fill('  key: value  # some yaml config line').join('\n');
    const text = 'Here is the manifest:\n\n```yaml\n' + yamlLines + '\n```';
    const result = splitForDiscord(text, 500);

    expect(result.length).toBeGreaterThan(1);

    // Each chunk should have balanced codeblock fences
    for (const chunk of result) {
      const fences = chunk.match(/^```/gm) || [];
      expect(fences.length % 2).toBe(0);
    }
  });

  it('does not alter chunks that have no codeblocks', () => {
    const text = Array(100).fill('plain text line here').join('\n');
    const result = splitForDiscord(text, 500);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk).not.toContain('```');
    }
  });

  it('handles mixed text and codeblock split across chunks', () => {
    const code = Array(40).fill('  command: echo hello').join('\n');
    const text = 'Here is the manifest:\n\n```yaml\n' + code + '\n```\n\nDone!';
    const result = splitForDiscord(text, 500);

    expect(result.length).toBeGreaterThan(1);

    // Every chunk should have balanced fences
    for (const chunk of result) {
      const fences = chunk.match(/^```/gm) || [];
      expect(fences.length % 2).toBe(0);
    }
  });
});

describe('stripOuterCodeblock', () => {
  it('returns plain text unchanged', () => {
    expect(stripOuterCodeblock('hello world')).toBe('hello world');
  });

  it('strips simple codeblock fence', () => {
    expect(stripOuterCodeblock('```\nfoo bar\n```')).toBe('foo bar');
  });

  it('strips codeblock with language tag', () => {
    expect(stripOuterCodeblock('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips codeblock with python language tag', () => {
    expect(stripOuterCodeblock('```python\nprint("hi")\n```')).toBe('print("hi")');
  });

  it('preserves text that is not fully wrapped', () => {
    const text = '```\ncode\n```\nextra text';
    expect(stripOuterCodeblock(text)).toBe(text);
  });

  it('preserves text with only opening fence', () => {
    expect(stripOuterCodeblock('```\nno closing')).toBe('```\nno closing');
  });

  it('preserves text with only closing fence', () => {
    expect(stripOuterCodeblock('no opening\n```')).toBe('no opening\n```');
  });

  it('handles multiline content', () => {
    const text = '```\nline1\nline2\nline3\n```';
    expect(stripOuterCodeblock(text)).toBe('line1\nline2\nline3');
  });

  it('preserves nested codeblocks (even count)', () => {
    const text = '```\nouter\n```js\ninner\n```\nouter2\n```';
    expect(stripOuterCodeblock(text)).toBe('outer\n```js\ninner\n```\nouter2');
  });

  it('does not strip when inner fences are odd (not fully wrapped)', () => {
    const text = '```\npart1\n```\npart2';
    expect(stripOuterCodeblock(text)).toBe(text);
  });

  it('handles empty codeblock', () => {
    expect(stripOuterCodeblock('```\n```')).toBe('');
  });

  it('handles whitespace around the text', () => {
    expect(stripOuterCodeblock('  ```\nfoo\n```  ')).toBe('foo');
  });

  it('returns empty string unchanged', () => {
    expect(stripOuterCodeblock('')).toBe('');
  });

  it('handles single backtick lines (not codeblock)', () => {
    expect(stripOuterCodeblock('`inline code`')).toBe('`inline code`');
  });
});

describe('stripFilePaths', () => {
  it('returns text unchanged when no file paths given', () => {
    const text = 'Hello world';
    expect(stripFilePaths(text, [])).toBe(text);
  });

  it('removes a standalone absolute path', () => {
    const text = 'Here is the file: /home/user/project/.discode/files/chart.png done';
    const result = stripFilePaths(text, ['/home/user/project/.discode/files/chart.png']);
    expect(result).toBe('Here is the file:  done');
    expect(result).not.toContain('/home/user');
  });

  it('removes a backtick-wrapped path', () => {
    const text = 'Generated: `/tmp/output.png`';
    const result = stripFilePaths(text, ['/tmp/output.png']);
    expect(result).toBe('Generated: ');
  });

  it('removes a markdown image with the path', () => {
    const text = 'See below:\n![chart](/tmp/chart.png)\nDone';
    const result = stripFilePaths(text, ['/tmp/chart.png']);
    expect(result).toBe('See below:\n\nDone');
  });

  it('removes multiple paths from text', () => {
    const text = 'Files: `/tmp/a.png` and `/tmp/b.pdf`';
    const result = stripFilePaths(text, ['/tmp/a.png', '/tmp/b.pdf']);
    expect(result).toBe('Files:  and ');
  });

  it('collapses 3+ consecutive newlines into 2', () => {
    const text = 'Hello\n\n\n\nWorld';
    const result = stripFilePaths(text, []);
    expect(result).toBe('Hello\n\nWorld');
  });

  it('collapses newlines left by path removal', () => {
    const text = 'Before\n\n/tmp/file.png\n\nAfter';
    const result = stripFilePaths(text, ['/tmp/file.png']);
    expect(result).toBe('Before\n\nAfter');
  });

  it('handles path with regex special characters', () => {
    const text = 'File: /tmp/output[1].png done';
    const result = stripFilePaths(text, ['/tmp/output[1].png']);
    expect(result).toBe('File:  done');
  });

  it('removes all occurrences of the same path', () => {
    const text = 'See /tmp/f.png and also /tmp/f.png';
    const result = stripFilePaths(text, ['/tmp/f.png']);
    expect(result).toBe('See  and also ');
  });
});

describe('extractFilePaths', () => {
  it('returns empty array for text without paths', () => {
    expect(extractFilePaths('hello world')).toEqual([]);
  });

  it('extracts single absolute path', () => {
    const text = 'I saved the image to /home/user/output.png for you.';
    expect(extractFilePaths(text)).toEqual(['/home/user/output.png']);
  });

  it('extracts multiple paths', () => {
    const text = 'Created /tmp/a.png and /tmp/b.pdf';
    const paths = extractFilePaths(text);
    expect(paths).toContain('/tmp/a.png');
    expect(paths).toContain('/tmp/b.pdf');
  });

  it('deduplicates paths', () => {
    const text = 'See /tmp/file.png and also /tmp/file.png again';
    expect(extractFilePaths(text)).toEqual(['/tmp/file.png']);
  });

  it('extracts backtick-wrapped path', () => {
    const text = 'Generated: `/tmp/output.png`';
    expect(extractFilePaths(text)).toEqual(['/tmp/output.png']);
  });

  it('extracts path from markdown image', () => {
    const text = '![chart](/home/user/chart.png)';
    expect(extractFilePaths(text)).toEqual(['/home/user/chart.png']);
  });

  it('ignores relative paths', () => {
    expect(extractFilePaths('See ./output.png and ../file.pdf')).toEqual([]);
  });

  it('ignores paths with unknown extensions', () => {
    expect(extractFilePaths('File at /tmp/data.xyz')).toEqual([]);
  });

  it('matches known extensions case-insensitively', () => {
    const text = 'Image at /tmp/photo.PNG';
    expect(extractFilePaths(text)).toEqual(['/tmp/photo.PNG']);
  });

  it('extracts various file types', () => {
    const text = '/tmp/a.jpg /tmp/b.gif /tmp/c.webp /tmp/d.csv /tmp/e.json /tmp/f.txt';
    const paths = extractFilePaths(text);
    expect(paths).toHaveLength(6);
  });

  it('handles path at end of line', () => {
    const text = 'Saved to /tmp/result.pdf';
    expect(extractFilePaths(text)).toEqual(['/tmp/result.pdf']);
  });

  it('handles path on its own line', () => {
    const text = 'Files:\n/home/user/output.png\nDone.';
    expect(extractFilePaths(text)).toEqual(['/home/user/output.png']);
  });
});

describe('splitForSlack', () => {
  it('returns single-element array for short text', () => {
    expect(splitForSlack('hello')).toEqual(['hello']);
  });

  it('splits at line boundaries under 3900 chars', () => {
    const lines = Array(200).fill('some longer line for slack testing').join('\n');
    const result = splitForSlack(lines);
    expect(result.length).toBeGreaterThan(1);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    });
  });

  it('respects custom maxLen parameter', () => {
    const lines = Array(20).fill('a line of text').join('\n');
    const result = splitForSlack(lines, 50);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(50);
    });
  });

  it('handles empty string', () => {
    expect(splitForSlack('')).toEqual(['']);
  });

  it('preserves codeblock fences across chunks', () => {
    const yamlLines = Array(200).fill('  key: value').join('\n');
    const text = 'Config:\n\n```yaml\n' + yamlLines + '\n```';
    const result = splitForSlack(text, 500);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      const fences = chunk.match(/^```/gm) || [];
      expect(fences.length % 2).toBe(0);
    }
  });
});

describe('renderTerminalSnapshot', () => {
  it('renders plain text', () => {
    const result = renderTerminalSnapshot('Hello World', { width: 30, height: 5 });
    expect(result.trimEnd()).toBe('Hello World');
  });

  it('handles newlines', () => {
    const result = renderTerminalSnapshot('line1\nline2\nline3', { width: 20, height: 5 });
    const lines = result.split('\n');
    expect(lines[0].trimEnd()).toBe('line1');
    expect(lines[1].trimEnd()).toBe('line2');
    expect(lines[2].trimEnd()).toBe('line3');
  });

  it('handles carriage return (overwrites line)', () => {
    const result = renderTerminalSnapshot('hello\rworld', { width: 20, height: 5 });
    const first = result.split('\n')[0];
    expect(first.trimEnd()).toBe('world');
  });

  it('strips SGR color codes (renders text only)', () => {
    const result = renderTerminalSnapshot('\x1b[31mred\x1b[0m normal', { width: 30, height: 5 });
    expect(result.trimEnd()).toBe('red normal');
  });

  it('handles cursor up (CSI A)', () => {
    const result = renderTerminalSnapshot('aaa\nbbb\x1b[1Aup', { width: 20, height: 5 });
    const lines = result.split('\n');
    // After "bbb", cursor is at row 1 col 3. CSI 1A moves up to row 0 col 3, then writes "up"
    expect(lines[0]).toContain('up');
  });

  it('handles clear screen (CSI 2J)', () => {
    const result = renderTerminalSnapshot('old text\x1b[2Jnew', { width: 20, height: 5 });
    expect(result).toContain('new');
    expect(result).not.toContain('old');
  });

  it('handles absolute cursor positioning (CSI H)', () => {
    const result = renderTerminalSnapshot('\x1b[2;6Hhello', { width: 20, height: 5 });
    const lines = result.split('\n');
    // Row 2 (1-based), Col 6 (1-based) → 0-based: row 1, col 5
    expect(lines[1].indexOf('hello')).toBe(5);
  });

  it('handles line clear (CSI 0K — clear to end of line)', () => {
    const result = renderTerminalSnapshot('abcdef\r\x1b[3Cxxx\x1b[0K', { width: 10, height: 5 });
    const first = result.split('\n')[0];
    // After writing "abcdef", CR resets to col 0, move right 3, write "xxx", clear to end
    expect(first.trimEnd()).toBe('abcxxx');
  });

  it('wraps text at width boundary', () => {
    // width is clamped to min 20, so use 20 chars to wrap
    const input = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars > 20
    const result = renderTerminalSnapshot(input, { width: 20, height: 6 });
    const lines = result.split('\n');
    expect(lines[0]).toBe('abcdefghijklmnopqrst');
    expect(lines[1].trimEnd()).toBe('uvwxyz');
  });

  it('respects height option (takes last N rows in scrollback mode)', () => {
    // height is clamped to min 6, so use 6
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const result = renderTerminalSnapshot(text, { width: 20, height: 6 });
    const lines = result.split('\n');
    expect(lines).toHaveLength(6);
    // Should contain the last 6 lines
    expect(lines[5].trimEnd()).toBe('line19');
  });

  it('handles tab characters', () => {
    const result = renderTerminalSnapshot('a\tb', { width: 20, height: 5 });
    const first = result.split('\n')[0];
    // Tab at col 1 expands to 7 spaces (8 - 1%8 = 7), then 'b' at col 8
    expect(first[0]).toBe('a');
    expect(first[8]).toBe('b');
  });

  it('handles backspace', () => {
    const result = renderTerminalSnapshot('abc\bd', { width: 20, height: 5 });
    const first = result.split('\n')[0];
    // After "abc", backspace moves to col 2, then 'd' overwrites 'c'
    expect(first.trimEnd()).toBe('abd');
  });

  it('handles empty input', () => {
    const result = renderTerminalSnapshot('', { width: 20, height: 5 });
    expect(result.trimEnd()).toBe('');
  });
});
