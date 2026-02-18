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

type SavedScreenState = {
  lines: Cell[][];
  cursorRow: number;
  cursorCol: number;
  savedRow: number;
  savedCol: number;
  scrollTop: number;
  scrollBottom: number;
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
  private usingAltScreen = false;
  private savedPrimaryScreen?: SavedScreenState;
  private pendingInput = '';
  private scrollTop = 0;
  private scrollBottom = 0;
  private wrapPending = false;

  constructor(cols = 120, rows = 40, scrollback = 2000) {
    this.cols = clamp(cols, 20, 300);
    this.rows = clamp(rows, 6, 200);
    this.scrollback = Math.max(this.rows * 4, scrollback);
    this.lines = [this.makeLine(this.cols)];
    this.scrollBottom = this.rows - 1;
  }

  write(chunk: string): void {
    let data = this.pendingInput + chunk;
    this.pendingInput = '';

    if (data.length === 0) return;
    if (data.length > 32_768) {
      // Guard against pathological accumulation.
      data = data.slice(-32_768);
    }

    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === '\x1b') {
        const next = data[i + 1];
        if (next === undefined) {
          this.pendingInput = data.slice(i);
          break;
        }

        if (next === '[') {
          let j = i + 2;
          while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j += 1;
          if (j >= data.length) {
            this.pendingInput = data.slice(i);
            break;
          }
          const final = data[j];
          const raw = data.slice(i + 2, j);
          this.handleCsi(raw, final);
          i = j + 1;
          continue;
        }

        if (next === 'D') {
          this.wrapPending = false;
          this.lineFeed();
          i += 2;
          continue;
        }

        if (next === 'E') {
          this.wrapPending = false;
          this.cursorCol = 0;
          this.lineFeed();
          i += 2;
          continue;
        }

        if (next === 'M') {
          this.wrapPending = false;
          this.reverseIndex();
          i += 2;
          continue;
        }

        if (next === ']') {
          // OSC
          let j = i + 2;
          let terminated = false;
          while (j < data.length) {
            if (data[j] === '\x07') {
              j += 1;
              terminated = true;
              break;
            }
            if (data[j] === '\x1b' && data[j + 1] === '\\') {
              j += 2;
              terminated = true;
              break;
            }
            j += 1;
          }
          if (!terminated) {
            this.pendingInput = data.slice(i);
            break;
          }
          i = j;
          continue;
        }

        i += 2;
        continue;
      }

      if (ch === '\r') {
        this.wrapPending = false;
        this.cursorCol = 0;
        i += 1;
        continue;
      }

      if (ch === '\n') {
        this.wrapPending = false;
        this.lineFeed();
        i += 1;
        continue;
      }

      if (ch === '\b') {
        this.wrapPending = false;
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

      const code = data.charCodeAt(i);
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
    this.scrollTop = Math.max(0, Math.min(this.rows - 1, this.scrollTop));
    this.scrollBottom = Math.max(this.scrollTop, Math.min(this.rows - 1, this.scrollBottom));
    this.wrapPending = false;
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

  getCursorPosition(): { row: number; col: number } {
    return {
      row: this.cursorRow,
      col: this.cursorCol,
    };
  }

  getDimensions(): { cols: number; rows: number } {
    return {
      cols: this.cols,
      rows: this.rows,
    };
  }

  private handleCsi(rawParams: string, final: string): void {
    // Clear deferred wrap for cursor-moving and erase operations.
    // SGR ('m') and mode-set ('h'/'l') do NOT cancel the pending wrap.
    if (final !== 'm' && final !== 'h' && final !== 'l') {
      this.wrapPending = false;
    }
    const isPrivate = rawParams.startsWith('?');
    const clean = isPrivate ? rawParams.slice(1) : rawParams;
    const parts = clean.length > 0 ? clean.split(';') : [];
    const param = (index: number, fallback: number) => {
      const parsed = parseInt(parts[index] || '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const privateParams = parts
      .map((part) => parseInt(part || '', 10))
      .filter((value) => Number.isFinite(value));

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
      case 'r': {
        const top = Math.max(1, param(0, 1));
        const bottom = parts.length >= 2 ? Math.max(1, param(1, this.rows)) : this.rows;
        if (top < bottom && bottom <= this.rows) {
          this.scrollTop = top - 1;
          this.scrollBottom = bottom - 1;
          this.cursorRow = 0;
          this.cursorCol = 0;
        }
        break;
      }
      case 'J':
        this.clearDisplay(param(0, 0));
        break;
      case 'K':
        this.clearLine(param(0, 0));
        break;
      case '@':
        this.insertChars(param(0, 1));
        break;
      case 'P':
        this.deleteChars(param(0, 1));
        break;
      case 'X':
        this.eraseChars(param(0, 1));
        break;
      case 'L':
        this.insertLines(param(0, 1));
        break;
      case 'M':
        this.deleteLines(param(0, 1));
        break;
      case 'S':
        this.scrollUp(param(0, 1));
        break;
      case 'T':
        this.scrollDown(param(0, 1));
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
        if (isPrivate) {
          const wantsAlt = privateParams.some((v) => v === 1049 || v === 1047 || v === 47);
          if (wantsAlt) {
            if (final === 'h') {
              this.enterAltScreen();
            } else {
              this.leaveAltScreen();
            }
          }
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
      if (this.usingAltScreen) {
        while (this.lines.length < this.rows) this.lines.push(this.makeLine(this.cols));
      }
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

  private insertChars(count: number): void {
    this.ensureCursorRow();
    const line = this.lines[this.cursorRow];
    const n = Math.max(1, Math.min(this.cols, count));
    for (let i = this.cols - 1; i >= this.cursorCol + n; i -= 1) {
      line[i] = line[i - n];
    }
    for (let i = 0; i < n && this.cursorCol + i < this.cols; i += 1) {
      line[this.cursorCol + i] = this.makeCell(' ');
    }
  }

  private deleteChars(count: number): void {
    this.ensureCursorRow();
    const line = this.lines[this.cursorRow];
    const n = Math.max(1, Math.min(this.cols, count));
    for (let i = this.cursorCol; i < this.cols - n; i += 1) {
      line[i] = line[i + n];
    }
    for (let i = this.cols - n; i < this.cols; i += 1) {
      line[i] = this.makeCell(' ');
    }
  }

  private eraseChars(count: number): void {
    this.ensureCursorRow();
    const line = this.lines[this.cursorRow];
    const n = Math.max(1, Math.min(this.cols - this.cursorCol, count));
    for (let i = 0; i < n; i += 1) {
      line[this.cursorCol + i] = this.makeCell(' ');
    }
  }

  private insertLines(count: number): void {
    this.ensureCursorRow();
    if (!this.cursorWithinScrollRegion()) return;
    const n = Math.max(1, Math.min(this.absoluteRowFromViewport(this.scrollBottom) - this.cursorRow + 1, count));
    const bottom = this.absoluteRowFromViewport(this.scrollBottom);
    for (let i = 0; i < n; i += 1) {
      this.lines.splice(this.cursorRow, 0, this.makeLine(this.cols));
      this.lines.splice(bottom + 1, 1);
    }
    this.trimBottomToRows();
  }

  private deleteLines(count: number): void {
    this.ensureCursorRow();
    if (!this.cursorWithinScrollRegion()) return;
    const n = Math.max(1, Math.min(this.absoluteRowFromViewport(this.scrollBottom) - this.cursorRow + 1, count));
    const bottom = this.absoluteRowFromViewport(this.scrollBottom);
    for (let i = 0; i < n; i += 1) {
      if (this.cursorRow < this.lines.length) {
        this.lines.splice(this.cursorRow, 1);
      }
      this.lines.splice(bottom, 0, this.makeLine(this.cols));
    }
    this.trimBottomToRows();
  }

  private scrollUp(count: number): void {
    const n = Math.max(1, Math.min(this.rows, count));
    this.scrollRegionUp(this.scrollTop, this.scrollBottom, n);
    this.trimBottomToRows();
  }

  private scrollDown(count: number): void {
    const n = Math.max(1, Math.min(this.rows, count));
    this.scrollRegionDown(this.scrollTop, this.scrollBottom, n);
    this.trimBottomToRows();
  }

  private writeChar(ch: string): void {
    if (this.wrapPending) {
      this.wrapPending = false;
      this.cursorCol = 0;
      this.lineFeed();
    }
    this.ensureCursorRow();
    this.clampCursor();

    this.lines[this.cursorRow][this.cursorCol] = this.makeCell(ch);
    if (this.cursorCol < this.cols - 1) {
      this.cursorCol += 1;
    } else {
      this.wrapPending = true;
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
    if (this.usingAltScreen) {
      while (this.lines.length < this.rows) {
        this.lines.push(this.makeLine(this.cols));
      }
      while (this.cursorRow >= this.rows) {
        this.cursorRow = this.rows - 1;
        this.scrollRegionUp(this.scrollTop, this.scrollBottom, 1);
      }
      this.cursorRow = Math.max(0, this.cursorRow);
      return;
    }

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

  private trimBottomToRows(): void {
    if (!this.usingAltScreen) return;
    while (this.lines.length > this.rows) {
      this.lines.pop();
    }
    while (this.lines.length < this.rows) {
      this.lines.push(this.makeLine(this.cols));
    }
  }

  private enterAltScreen(): void {
    if (this.usingAltScreen) return;
    this.savedPrimaryScreen = {
      lines: cloneLines(this.lines),
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
      savedRow: this.savedRow,
      savedCol: this.savedCol,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
    };
    this.usingAltScreen = true;
    this.lines = [];
    while (this.lines.length < this.rows) this.lines.push(this.makeLine(this.cols));
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.wrapPending = false;
  }

  private leaveAltScreen(): void {
    if (!this.usingAltScreen) return;
    this.usingAltScreen = false;
    this.wrapPending = false;
    if (!this.savedPrimaryScreen) {
      this.lines = [this.makeLine(this.cols)];
      this.cursorRow = 0;
      this.cursorCol = 0;
      this.savedRow = 0;
      this.savedCol = 0;
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
      return;
    }
    this.lines = cloneLines(this.savedPrimaryScreen.lines);
    this.cursorRow = this.savedPrimaryScreen.cursorRow;
    this.cursorCol = this.savedPrimaryScreen.cursorCol;
    this.savedRow = this.savedPrimaryScreen.savedRow;
    this.savedCol = this.savedPrimaryScreen.savedCol;
    this.scrollTop = this.savedPrimaryScreen.scrollTop;
    this.scrollBottom = this.savedPrimaryScreen.scrollBottom;
    this.savedPrimaryScreen = undefined;
  }

  private lineFeed(): void {
    this.ensureCursorRow();
    const top = this.absoluteRowFromViewport(this.scrollTop);
    const bottom = this.absoluteRowFromViewport(this.scrollBottom);

    if (this.cursorRow >= top && this.cursorRow <= bottom) {
      if (this.cursorRow === bottom) {
        this.scrollRegionUp(this.scrollTop, this.scrollBottom, 1);
      } else {
        this.cursorRow += 1;
      }
      return;
    }

    this.cursorRow += 1;
    this.ensureCursorRow();
  }

  private reverseIndex(): void {
    this.ensureCursorRow();
    const top = this.absoluteRowFromViewport(this.scrollTop);
    const bottom = this.absoluteRowFromViewport(this.scrollBottom);

    if (this.cursorRow >= top && this.cursorRow <= bottom) {
      if (this.cursorRow === top) {
        this.scrollRegionDown(this.scrollTop, this.scrollBottom, 1);
      } else {
        this.cursorRow -= 1;
      }
      return;
    }

    this.cursorRow = Math.max(0, this.cursorRow - 1);
  }

  private cursorWithinScrollRegion(): boolean {
    const top = this.absoluteRowFromViewport(this.scrollTop);
    const bottom = this.absoluteRowFromViewport(this.scrollBottom);
    return this.cursorRow >= top && this.cursorRow <= bottom;
  }

  private scrollRegionUp(topLocal: number, bottomLocal: number, count: number): void {
    const top = this.absoluteRowFromViewport(topLocal);
    const bottom = this.absoluteRowFromViewport(bottomLocal);
    const n = Math.max(1, Math.min(bottom - top + 1, count));

    for (let i = 0; i < n; i += 1) {
      this.lines.splice(top, 1);
      this.lines.splice(bottom, 0, this.makeLine(this.cols));
    }
  }

  private scrollRegionDown(topLocal: number, bottomLocal: number, count: number): void {
    const top = this.absoluteRowFromViewport(topLocal);
    const bottom = this.absoluteRowFromViewport(bottomLocal);
    const n = Math.max(1, Math.min(bottom - top + 1, count));

    for (let i = 0; i < n; i += 1) {
      this.lines.splice(bottom, 1);
      this.lines.splice(top, 0, this.makeLine(this.cols));
    }
  }

  private absoluteRowFromViewport(localRow: number): number {
    if (this.usingAltScreen) return localRow;
    const base = Math.max(0, this.lines.length - this.rows);
    return base + localRow;
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

function cloneLines(lines: Cell[][]): Cell[][] {
  return lines.map((line) => line.map((cell) => ({
    ch: cell.ch,
    style: { ...cell.style },
  })));
}
