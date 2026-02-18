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

  it('handles split ANSI chunks without leaking raw fragments', () => {
    const screen = new VtScreen(30, 6);
    screen.write('\x1b[38;2;255');
    screen.write(';255;255mWHITE\x1b[0m');

    const frame = screen.snapshot(30, 6);
    const segments = frame.lines
      .flatMap((line) => line.segments)
      .filter((seg) => seg.text.trim().length > 0);
    const combined = segments.map((seg) => seg.text).join('');

    expect(combined.includes(';255m')).toBe(false);
    expect(combined.includes('10m')).toBe(false);
    expect(combined.includes('WHITE')).toBe(true);
    expect(segments.find((seg) => seg.text.includes('WHITE'))?.fg).toBe('#ffffff');
  });

  it('does not carry complete OSC sequence into next chunk', () => {
    const screen = new VtScreen(30, 6);
    screen.write('\x1b]0;title\x07');
    screen.write('VISIBLE');

    const frame = screen.snapshot(30, 6);
    const text = frame.lines.map((line) => line.segments.map((seg) => seg.text).join('')).join('\n');
    expect(text.includes('VISIBLE')).toBe(true);
    expect(text.includes('title')).toBe(false);
  });

  it('line-feed keeps cursor column', () => {
    const screen = new VtScreen(12, 4);
    screen.write('AB');
    screen.write('\n');
    screen.write('C');

    const frame = screen.snapshot(12, 4);
    const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join(''));
    expect(lines.some((line) => line.startsWith('  C'))).toBe(true);
  });

  it('CSI 2J clears screen but keeps cursor position', () => {
    const screen = new VtScreen(12, 4);
    screen.write('12345');
    screen.write('\x1b[10G');
    screen.write('\x1b[2J');
    screen.write('X');

    const frame = screen.snapshot(12, 4);
    const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join(''));
    expect(lines.some((line) => line.includes('         X'))).toBe(true);
  });

  it('defers wrap until next printable character', () => {
    const screen = new VtScreen(20, 6);
    // Write exactly 20 chars to fill the row – cursor should stay at col 19
    // with wrapPending, NOT advance to the next row.
    screen.write('ABCDEFGHIJ0123456789');

    const pos1 = screen.getCursorPosition();
    expect(pos1.row).toBe(0);
    expect(pos1.col).toBe(19);

    // A CSI sequence should cancel the pending wrap without moving the cursor.
    screen.write('\x1b[31m');
    const pos2 = screen.getCursorPosition();
    expect(pos2.row).toBe(0);
    expect(pos2.col).toBe(19);

    // The next printable char triggers the deferred wrap: cursor wraps to
    // row 1, char is placed at col 0, then cursor advances to col 1.
    screen.write('X');
    const pos3 = screen.getCursorPosition();
    expect(pos3.row).toBe(1);
    expect(pos3.col).toBe(1);

    const frame = screen.snapshot(20, 6);
    const lines = frame.lines.map((l) => l.segments.map((s) => s.text).join(''));
    expect(lines.some((l) => l === 'ABCDEFGHIJ0123456789')).toBe(true);
    expect(lines.some((l) => l.startsWith('X'))).toBe(true);
  });

  it('deferred wrap does not cause spurious scroll in alt screen', () => {
    const screen = new VtScreen(20, 6);
    screen.write('\x1b[?1049h');

    // Fill the last row completely (20 chars)
    screen.write('\x1b[6;1H');
    screen.write('ABCDEFGHIJ0123456789');

    // Cursor should still be on row 5 (0-indexed) with wrap pending
    const pos = screen.getCursorPosition();
    expect(pos.row).toBe(5);

    // CSI H repositions – wrap should NOT have scrolled
    screen.write('\x1b[1;1H');
    screen.write('HEAD');

    const frame = screen.snapshot(20, 6);
    const lines = frame.lines.map((l) => l.segments.map((s) => s.text).join(''));
    expect(lines[0].startsWith('HEAD')).toBe(true);
    expect(lines[5]).toBe('ABCDEFGHIJ0123456789');
  });

  it('respects DECSTBM scroll region for line feed', () => {
    const screen = new VtScreen(20, 6);
    screen.write('\x1b[?1049h');
    screen.write('\x1b[2;5r');

    screen.write('\x1b[1;1Hfixed-head');
    screen.write('\x1b[2;1HA-top');
    screen.write('\x1b[3;1Hmid-1');
    screen.write('\x1b[4;1Hmid-2');
    screen.write('\x1b[5;1Hbottom');
    screen.write('\x1b[6;1Hfixed-tail');

    screen.write('\x1b[5;1H');
    screen.write('\n');
    screen.write('after-scroll');

    const frame = screen.snapshot(20, 6);
    const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join(''));

    expect(lines.some((line) => line.includes('fixed-tail'))).toBe(true);
    expect(lines.some((line) => line.includes('after-scroll'))).toBe(true);
    expect(lines.some((line) => line.includes('fixed-head'))).toBe(true);
  });
});
