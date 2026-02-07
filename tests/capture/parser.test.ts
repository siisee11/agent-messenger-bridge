import { stripAnsi, cleanCapture, splitForDiscord } from '../../src/capture/parser.js';

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
});
