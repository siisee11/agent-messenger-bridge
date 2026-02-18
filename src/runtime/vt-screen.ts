export type TerminalStyle = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

export type TerminalSegment = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type TerminalStyledLine = {
  segments: TerminalSegment[];
};

export type TerminalStyledFrame = {
  cols: number;
  rows: number;
  lines: TerminalStyledLine[];
  cursorRow: number;
  cursorCol: number;
};

type Cell = {
  ch: string;
  style: TerminalStyle;
};

export class VtScreen {
  private cols: number;
  private rows: number;
  private scrollback: number;
  private lines: Cell[][];
  private cursorRow = 0;
  private cursorCol = 0;
  private savedRow = 0;
  private savedCol = 0;
  private currentStyle: TerminalStyle = {};

  constructor(cols = 120, rows = 40, scrollback = 2000) {
    this.cols = clamp(cols, 20, 300);
    this.rows = clamp(rows, 6, 200);
    this.scrollback = Math.max(this.rows * 4, scrollback);
    this.lines = [this.makeLine(this.cols)];
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];

      if (ch === '\x1b') {
        const next = chunk[i + 1];
        if (next === '[') {
          let j = i + 2;
          while (j < chunk.length && (chunk.charCodeAt(j) < 0x40 || chunk.charCodeAt(j) > 0x7e)) j += 1;
          if (j >= chunk.length) break;
          const final = chunk[j];
          const raw = chunk.slice(i + 2, j);
          this.handleCsi(raw, final);
          i = j + 1;
          continue;
        }

        if (next === ']') {
          // OSC
          let j = i + 2;
          while (j < chunk.length) {
            if (chunk[j] === '\x07') {
              j += 1;
              break;
            }
            if (chunk[j] === '\x1b' && chunk[j + 1] === '\\') {
              j += 2;
              break;
            }
            j += 1;
          }
          i = j;
          continue;
        }

        i += 2;
        continue;
      }

      if (ch === '\r') {
        this.cursorCol = 0;
        i += 1;
        continue;
      }

      if (ch === '\n') {
        this.cursorRow += 1;
        this.cursorCol = 0;
        this.ensureCursorRow();
        i += 1;
        continue;
      }

      if (ch === '\b') {
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        i += 1;
        continue;
      }

      if (ch === '\t') {
        const spaces = 8 - (this.cursorCol % 8);
        for (let s = 0; s < spaces; s += 1) {
          this.writeChar(' ');
        }
        i += 1;
        continue;
      }

      const code = chunk.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) {
        i += 1;
        continue;
      }

      this.writeChar(ch);
      i += 1;
    }
  }

  resize(cols: number, rows: number): void {
    const nextCols = clamp(cols, 20, 300);
    const nextRows = clamp(rows, 6, 200);
    if (nextCols === this.cols && nextRows === this.rows) return;

    for (let r = 0; r < this.lines.length; r += 1) {
      const line = this.lines[r];
      if (line.length < nextCols) {
        this.lines[r] = line.concat(this.makeLine(nextCols - line.length));
      } else if (line.length > nextCols) {
        this.lines[r] = line.slice(0, nextCols);
      }
    }

    this.cols = nextCols;
    this.rows = nextRows;
    this.scrollback = Math.max(this.rows * 4, this.scrollback);
    this.cursorCol = Math.min(this.cursorCol, this.cols - 1);
  }

  snapshot(cols?: number, rows?: number): TerminalStyledFrame {
    const viewCols = clamp(cols || this.cols, 20, 300);
    const viewRows = clamp(rows || this.rows, 6, 200);
    const start = Math.max(0, this.lines.length - viewRows);
    const lines = this.lines.slice(start, start + viewRows).map((line) => this.toStyledLine(line, viewCols));

    while (lines.length < viewRows) {
      lines.unshift({ segments: [{ text: ' '.repeat(viewCols) }] });
    }

    const cursorRow = Math.max(0, Math.min(viewRows - 1, this.cursorRow - start));
    const cursorCol = Math.max(0, Math.min(viewCols - 1, this.cursorCol));

    return {
      cols: viewCols,
      rows: viewRows,
      lines,
      cursorRow,
      cursorCol,
    };
  }

  private handleCsi(rawParams: string, final: string): void {
    const isPrivate = rawParams.startsWith('?');
    const clean = isPrivate ? rawParams.slice(1) : rawParams;
    const parts = clean.length > 0 ? clean.split(';') : [];
    const param = (index: number, fallback: number) => {
      const parsed = parseInt(parts[index] || '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    switch (final) {
      case 'A':
        this.cursorRow -= param(0, 1);
        break;
      case 'B':
        this.cursorRow += param(0, 1);
        break;
      case 'C':
        this.cursorCol += param(0, 1);
        break;
      case 'D':
        this.cursorCol -= param(0, 1);
        break;
      case 'E':
        this.cursorRow += param(0, 1);
        this.cursorCol = 0;
        break;
      case 'F':
        this.cursorRow -= param(0, 1);
        this.cursorCol = 0;
        break;
      case 'G':
        this.cursorCol = Math.max(0, param(0, 1) - 1);
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, param(0, 1) - 1);
        this.cursorCol = Math.max(0, param(1, 1) - 1);
        break;
      case 'd':
        this.cursorRow = Math.max(0, param(0, 1) - 1);
        break;
      case 'J':
        this.clearDisplay(param(0, 0));
        break;
      case 'K':
        this.clearLine(param(0, 0));
        break;
      case 's':
        this.savedRow = this.cursorRow;
        this.savedCol = this.cursorCol;
        break;
      case 'u':
        this.cursorRow = this.savedRow;
        this.cursorCol = this.savedCol;
        break;
      case 'm':
        this.applySgr(parts);
        break;
      case 'h':
      case 'l':
        if (isPrivate && (param(0, 0) === 1049 || param(0, 0) === 47)) {
          this.clearDisplay(2);
        }
        break;
      default:
        break;
    }

    this.clampCursor();
    this.ensureCursorRow();
  }

  private clearDisplay(mode: number): void {
    this.ensureCursorRow();
    if (mode === 2) {
      this.lines = [this.makeLine(this.cols)];
      this.cursorRow = 0;
      this.cursorCol = 0;
      return;
    }

    if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r += 1) {
        this.lines[r] = this.makeLine(this.cols);
      }
      this.clearLine(1);
      return;
    }

    this.clearLine(0);
    for (let r = this.cursorRow + 1; r < this.lines.length; r += 1) {
      this.lines[r] = this.makeLine(this.cols);
    }
  }

  private clearLine(mode: number): void {
    this.ensureCursorRow();
    const line = this.lines[this.cursorRow];

    if (mode === 2) {
      this.lines[this.cursorRow] = this.makeLine(this.cols);
      return;
    }
    if (mode === 1) {
      for (let c = 0; c <= this.cursorCol; c += 1) {
        line[c] = this.makeCell(' ');
      }
      return;
    }
    for (let c = this.cursorCol; c < this.cols; c += 1) {
      line[c] = this.makeCell(' ');
    }
  }

  private writeChar(ch: string): void {
    this.ensureCursorRow();
    this.clampCursor();

    this.lines[this.cursorRow][this.cursorCol] = this.makeCell(ch);
    this.cursorCol += 1;
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.cursorRow += 1;
      this.ensureCursorRow();
    }
  }

  private applySgr(parts: string[]): void {
    if (parts.length === 0) {
      this.currentStyle = {};
      return;
    }

    for (let i = 0; i < parts.length; i += 1) {
      const code = parseInt(parts[i] || '0', 10);
      if (!Number.isFinite(code) || code === 0) {
        this.currentStyle = {};
        continue;
      }

      if (code === 1) {
        this.currentStyle.bold = true;
        continue;
      }
      if (code === 3) {
        this.currentStyle.italic = true;
        continue;
      }
      if (code === 4) {
        this.currentStyle.underline = true;
        continue;
      }
      if (code === 7) {
        this.currentStyle.inverse = true;
        continue;
      }
      if (code === 22) {
        this.currentStyle.bold = false;
        continue;
      }
      if (code === 23) {
        this.currentStyle.italic = false;
        continue;
      }
      if (code === 24) {
        this.currentStyle.underline = false;
        continue;
      }
      if (code === 27) {
        this.currentStyle.inverse = false;
        continue;
      }
      if (code === 39) {
        this.currentStyle.fg = undefined;
        continue;
      }
      if (code === 49) {
        this.currentStyle.bg = undefined;
        continue;
      }

      if (code >= 30 && code <= 37) {
        this.currentStyle.fg = ANSI_16_COLORS[code - 30];
        continue;
      }
      if (code >= 90 && code <= 97) {
        this.currentStyle.fg = ANSI_16_COLORS[8 + (code - 90)];
        continue;
      }
      if (code >= 40 && code <= 47) {
        this.currentStyle.bg = ANSI_16_COLORS[code - 40];
        continue;
      }
      if (code >= 100 && code <= 107) {
        this.currentStyle.bg = ANSI_16_COLORS[8 + (code - 100)];
        continue;
      }

      if ((code === 38 || code === 48) && i + 1 < parts.length) {
        const mode = parseInt(parts[i + 1] || '', 10);
        if (mode === 5 && i + 2 < parts.length) {
          const idx = parseInt(parts[i + 2] || '', 10);
          const color = xterm256Color(idx);
          if (color) {
            if (code === 38) this.currentStyle.fg = color;
            else this.currentStyle.bg = color;
          }
          i += 2;
          continue;
        }
        if (mode === 2 && i + 4 < parts.length) {
          const r = parseInt(parts[i + 2] || '', 10);
          const g = parseInt(parts[i + 3] || '', 10);
          const b = parseInt(parts[i + 4] || '', 10);
          if ([r, g, b].every((v) => Number.isFinite(v))) {
            const color = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            if (code === 38) this.currentStyle.fg = color;
            else this.currentStyle.bg = color;
          }
          i += 4;
          continue;
        }
      }
    }
  }

  private toStyledLine(line: Cell[], cols: number): TerminalStyledLine {
    const segments: TerminalSegment[] = [];

    let current: TerminalSegment | null = null;
    for (let i = 0; i < cols; i += 1) {
      const cell = line[i] || this.makeCell(' ');
      const style = applyInverse(cell.style);
      const nextStyleKey = styleKey(style);

      if (!current || styleKey(current) !== nextStyleKey) {
        if (current) segments.push(current);
        current = {
          text: cell.ch,
          fg: style.fg,
          bg: style.bg,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
        };
      } else {
        current.text += cell.ch;
      }
    }
    if (current) segments.push(current);

    if (segments.length === 0) {
      segments.push({ text: ' '.repeat(cols) });
    }

    return { segments };
  }

  private ensureCursorRow(): void {
    while (this.lines.length <= this.cursorRow) {
      this.lines.push(this.makeLine(this.cols));
      if (this.lines.length > this.scrollback) {
        this.lines.shift();
        this.cursorRow = Math.max(0, this.cursorRow - 1);
        this.savedRow = Math.max(0, this.savedRow - 1);
      }
    }
  }

  private clampCursor(): void {
    this.cursorRow = Math.max(0, this.cursorRow);
    this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.cursorCol));
  }

  private makeLine(cols: number): Cell[] {
    return Array.from({ length: cols }, () => this.makeCell(' '));
  }

  private makeCell(ch: string): Cell {
    return {
      ch,
      style: { ...this.currentStyle },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function styleKey(style: Partial<TerminalSegment | TerminalStyle>): string {
  return `${style.fg || ''}|${style.bg || ''}|${style.bold ? '1' : '0'}|${style.italic ? '1' : '0'}|${style.underline ? '1' : '0'}`;
}

function applyInverse(style: TerminalStyle): TerminalStyle {
  if (!style.inverse) return style;
  return {
    ...style,
    fg: style.bg,
    bg: style.fg,
    inverse: false,
  };
}

function toHex(v: number): string {
  const clamped = Math.max(0, Math.min(255, v));
  return clamped.toString(16).padStart(2, '0');
}

const ANSI_16_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function xterm256Color(index: number): string | undefined {
  if (!Number.isFinite(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_16_COLORS[index];
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return `#${toHex(v)}${toHex(v)}${toHex(v)}`;
  }

  const i = index - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const map = [0, 95, 135, 175, 215, 255];
  return `#${toHex(map[r])}${toHex(map[g])}${toHex(map[b])}`;
}
