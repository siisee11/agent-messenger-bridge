import { describe, expect, it } from 'vitest';
import { VtScreen } from '../../src/runtime/vt-screen.js';

describe('VtScreen', () => {
  it('renders basic styled segments from SGR colors', () => {
    const screen = new VtScreen(20, 6);
    screen.write('\x1b[31mred\x1b[0m normal');

    const frame = screen.snapshot(20, 6);
    const nonEmpty = frame.lines.find((line) => line.segments.some((seg) => seg.text.trim().length > 0));
    expect(nonEmpty).toBeDefined();

    const segments = nonEmpty!.segments.filter((seg) => seg.text.trim().length > 0);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0].fg).toBe('#cd3131');
    expect(segments[0].text.includes('red')).toBe(true);
  });

  it('keeps cursor-driven full-screen updates', () => {
    const screen = new VtScreen(10, 4);
    screen.write('hello');
    screen.write('\x1b[2J\x1b[H');
    screen.write('new');

    const frame = screen.snapshot(10, 4);
    const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join(''));
    expect(lines.some((line) => line.startsWith('new'))).toBe(true);
  });

  it('restores primary buffer after alt-screen leave', () => {
    const screen = new VtScreen(20, 6);
    screen.write('primary');
    screen.write('\x1b[?1049h');
    screen.write('alt-screen');
    screen.write('\x1b[?1049l');

    const frame = screen.snapshot(20, 6);
    const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join(''));
    const joined = lines.join('\n');

    expect(joined.includes('primary')).toBe(true);
    expect(joined.includes('alt-screen')).toBe(false);
  });

  it('handles insert/delete character CSI commands', () => {
    const screen = new VtScreen(12, 4);
    screen.write('abcdef');
    screen.write('\r\x1b[3C');
    screen.write('\x1b[2@');
    screen.write('XY');
    screen.write('\r\x1b[1P');

    const frame = screen.snapshot(12, 6);
    const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join(''));
    expect(lines.some((line) => line.startsWith('bcXYdef'))).toBe(true);
  });
});
