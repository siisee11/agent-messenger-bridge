/**
 * Unit tests for shell-escape module.
 *
 * escapeShellArg is security-critical — it prevents shell injection
 * when constructing tmux/docker commands with user-supplied text.
 */

import { describe, expect, it } from 'vitest';
import { escapeShellArg } from '../../src/infra/shell-escape.js';

describe('escapeShellArg', () => {
  it('wraps simple string in single quotes', () => {
    expect(escapeShellArg('hello')).toBe("'hello'");
  });

  it('wraps empty string in single quotes', () => {
    expect(escapeShellArg('')).toBe("''");
  });

  it('escapes embedded single quote', () => {
    expect(escapeShellArg("don't")).toBe("'don'\\''t'");
  });

  it('escapes multiple single quotes', () => {
    expect(escapeShellArg("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('wraps string with spaces', () => {
    expect(escapeShellArg('hello world')).toBe("'hello world'");
  });

  it('wraps string with double quotes', () => {
    expect(escapeShellArg('"hello"')).toBe("'\"hello\"'");
  });

  it('neutralises semicolon command chaining', () => {
    expect(escapeShellArg('a; rm -rf /')).toBe("'a; rm -rf /'");
  });

  it('neutralises pipe and redirect', () => {
    expect(escapeShellArg('cat f | grep x > out')).toBe("'cat f | grep x > out'");
  });

  it('neutralises backtick command substitution', () => {
    expect(escapeShellArg('`whoami`')).toBe("'`whoami`'");
  });

  it('neutralises dollar expansion', () => {
    expect(escapeShellArg('$HOME')).toBe("'$HOME'");
  });

  it('neutralises $() subshell', () => {
    expect(escapeShellArg('$(id)')).toBe("'$(id)'");
  });

  it('wraps string with newline', () => {
    expect(escapeShellArg('line1\nline2')).toBe("'line1\nline2'");
  });

  it('wraps string with backslash', () => {
    expect(escapeShellArg('back\\slash')).toBe("'back\\slash'");
  });

  it('wraps string with tab', () => {
    expect(escapeShellArg('col1\tcol2')).toBe("'col1\tcol2'");
  });
});
