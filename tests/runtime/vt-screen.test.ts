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
});
