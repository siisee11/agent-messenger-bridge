/**
 * Terminal capture text parser
 * Strips ANSI codes, extracts meaningful content
 */

const ANSI_REGEX = /\x1B(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|\([A-Z])/g;

/**
 * Strip ANSI escape codes from terminal output
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * Clean capture output: strip ANSI, trim trailing whitespace/blank lines
 */
export function cleanCapture(text: string): string {
  const stripped = stripAnsi(text);
  // Remove trailing blank lines but keep content structure
  const lines = stripped.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * Strip the outermost codeblock fence if the entire text is wrapped in one.
 * Preserves internal codeblocks and language specifiers are removed.
 *
 * Examples:
 *   "```\nfoo\n```"         -> "foo"
 *   "```ts\nfoo\n```"       -> "foo"
 *   "```\nfoo\n```\nbar"    -> unchanged (not fully wrapped)
 *   "hello"                  -> unchanged
 */
export function stripOuterCodeblock(text: string): string {
  const trimmed = text.trim();

  // Must start with ``` and end with ```
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return text;

  // Find the end of the opening fence line
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return text;

  // Find the closing fence: must be the last ```
  const closingFenceStart = trimmed.lastIndexOf('```');
  // The closing fence must not be the opening fence
  if (closingFenceStart <= 0) return text;

  // Check that the closing ``` is on its own line (only whitespace after it)
  const afterClosing = trimmed.substring(closingFenceStart + 3).trim();
  if (afterClosing.length > 0) return text;

  // Check there are no other top-level ``` fences in between
  // (i.e., the content between opening and closing shouldn't have unmatched ```)
  const inner = trimmed.substring(firstNewline + 1, closingFenceStart);

  // Count ``` occurrences in the inner content - if they come in pairs, it's nested codeblocks (fine).
  // If odd count, it means the outer fence doesn't truly wrap everything.
  const fenceMatches = inner.match(/^```/gm);
  if (fenceMatches && fenceMatches.length % 2 !== 0) return text;

  return inner.trimEnd();
}

/**
 * Split text into chunks for a messaging platform.
 * Strips outermost codeblock fence before splitting.
 * When a codeblock is split across chunks, closes it at the end of the
 * current chunk and re-opens it at the start of the next chunk so that
 * the platform renders each chunk correctly.
 *
 * @param maxLen Default 1900 (Discord-safe). Use 3900 for Slack.
 */
export function splitMessages(text: string, maxLen: number = 1900): string[] {
  const stripped = stripOuterCodeblock(text);
  if (stripped.length <= maxLen) return [stripped];

  const lines = stripped.split('\n');
  const rawChunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) rawChunks.push(current);
      current = line.length > maxLen ? line.substring(0, maxLen) : line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) rawChunks.push(current);

  // Post-process: ensure codeblock fences are balanced in each chunk
  const result: string[] = [];
  let openFenceLang: string | null = null; // tracks unclosed fence language (e.g. "yaml", "ts", or "")

  for (let i = 0; i < rawChunks.length; i++) {
    let chunk = rawChunks[i];

    // If previous chunk left a codeblock open, re-open it here
    if (openFenceLang !== null) {
      chunk = '```' + openFenceLang + '\n' + chunk;
    }

    // Scan this chunk line-by-line to determine if a codeblock is left open
    let insideCodeblock = false;
    let currentLang = '';
    for (const line of chunk.split('\n')) {
      const fenceMatch = line.match(/^```(\w*)/);
      if (fenceMatch) {
        if (!insideCodeblock) {
          insideCodeblock = true;
          currentLang = fenceMatch[1];
        } else {
          insideCodeblock = false;
          currentLang = '';
        }
      }
    }

    if (insideCodeblock) {
      // This chunk has an unclosed codeblock — close it
      chunk += '\n```';
      openFenceLang = currentLang;
    } else {
      openFenceLang = null;
    }

    result.push(chunk);
  }

  return result;
}

/** Split text into chunks for Discord (2000 char limit). */
export function splitForDiscord(text: string, maxLen: number = 1900): string[] {
  return splitMessages(text, maxLen);
}

/** Split text into chunks for Slack (40,000 char limit, use 3900 for safety). */
export function splitForSlack(text: string, maxLen: number = 3900): string[] {
  return splitMessages(text, maxLen);
}

/**
 * File extensions recognised when scanning agent output.
 */
const FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.json', '.txt'];

/**
 * Regex that matches absolute file paths ending with a known file extension.
 *
 * Handles paths that may appear:
 * - standalone on a line
 * - inside backticks: `/path/to/file.pdf`
 * - inside markdown image syntax: ![alt](/path/to/image.png)
 * - after "saved to", "wrote", "created", etc.
 *
 * The path must start with `/` (absolute) and the extension is
 * checked case-insensitively.
 */
const FILE_PATH_REGEX = new RegExp(
  `(?:^|[\\s\`"'(\\[])(/[^\\s\`"')\\\]]+\\.(?:${FILE_EXTENSIONS.map((e) => e.slice(1)).join('|')}))(?=[\\s\`"')\\].,;:!?]|$)`,
  'gim'
);

/**
 * Extract file paths from text.
 *
 * Scans the text for absolute file paths ending with known file
 * extensions and returns unique paths in order of first appearance.
 */
/**
 * Remove file paths from text to avoid leaking absolute paths in messages.
 *
 * For each path, removes occurrences in these forms:
 * - Markdown image: `![...](path)`
 * - Backtick-wrapped: `` `path` ``
 * - Standalone path (possibly preceded by whitespace)
 *
 * After removal, collapses runs of 3+ newlines into double-newlines.
 */
export function stripFilePaths(text: string, filePaths: string[]): string {
  let result = text;
  for (const p of filePaths) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Markdown image: ![any alt text](path)
    result = result.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    // Backtick-wrapped: `path`
    result = result.replace(new RegExp('`' + escaped + '`', 'g'), '');
    // Standalone path (possibly with surrounding whitespace on the line)
    result = result.replace(new RegExp(escaped, 'g'), '');
  }
  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, '\n\n');
  // Trim trailing whitespace on each line left empty by removal
  result = result.replace(/^[ \t]+$/gm, '');
  return result;
}

export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const p = match[1];
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }

  return paths;
}

export type TerminalSnapshotOptions = {
  width?: number;
  height?: number;
};

/**
 * Render a coarse terminal screen snapshot from ANSI stream text.
 *
 * This is not a full VT implementation, but handles the common control
 * sequences used by interactive CLIs so the current screen can be shown
 * in the discode TUI panel.
 */
export function renderTerminalSnapshot(text: string, options?: TerminalSnapshotOptions): string {
  const width = Math.max(20, Math.min(240, options?.width || 100));
  const height = Math.max(6, Math.min(120, options?.height || 30));
  const maxRows = Math.max(height * 6, 200);

  const makeRow = () => Array.from({ length: width }, () => ' ');
  let rows: string[][] = [makeRow()];
  let row = 0;
  let col = 0;
  let savedRow = 0;
  let savedCol = 0;
  let absoluteCursorUsed = false;

  const ensureRow = (index: number) => {
    while (rows.length <= index) rows.push(makeRow());
  };

  const trimHeadIfNeeded = () => {
    if (rows.length <= maxRows) return;
    const cut = rows.length - maxRows;
    rows = rows.slice(cut);
    row = Math.max(0, row - cut);
    savedRow = Math.max(0, savedRow - cut);
  };

  const clampCursor = () => {
    if (row < 0) row = 0;
    if (col < 0) col = 0;
    if (col >= width) col = width - 1;
    ensureRow(row);
  };

  const clearLine = (line: number, start: number, end: number) => {
    ensureRow(line);
    const safeStart = Math.max(0, Math.min(width - 1, start));
    const safeEnd = Math.max(0, Math.min(width - 1, end));
    for (let i = safeStart; i <= safeEnd; i++) rows[line][i] = ' ';
  };

  const clearDisplay = (mode: number) => {
    if (mode === 2) {
      rows = [makeRow()];
      row = 0;
      col = 0;
      return;
    }

    ensureRow(row);
    if (mode === 1) {
      for (let r = 0; r < row; r++) {
        clearLine(r, 0, width - 1);
      }
      clearLine(row, 0, col);
      return;
    }

    clearLine(row, col, width - 1);
    for (let r = row + 1; r < rows.length; r++) {
      clearLine(r, 0, width - 1);
    }
  };

  const writeChar = (ch: string) => {
    ensureRow(row);
    rows[row][col] = ch;
    col += 1;
    if (col >= width) {
      col = 0;
      row += 1;
      ensureRow(row);
      trimHeadIfNeeded();
    }
  };

  const parseNumber = (value: string, fallback: number) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\x1b') {
      const next = text[i + 1];

      // CSI
      if (next === '[') {
        let j = i + 2;
        while (j < text.length && (text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e)) j += 1;
        if (j >= text.length) break;

        const final = text[j];
        const rawParams = text.slice(i + 2, j);
        const isPrivate = rawParams.startsWith('?');
        const cleanParams = isPrivate ? rawParams.slice(1) : rawParams;
        const parts = cleanParams.length > 0 ? cleanParams.split(';') : [];
        const param = (index: number, fallback: number) => parseNumber(parts[index] || '', fallback);

        switch (final) {
          case 'A':
            row -= param(0, 1);
            break;
          case 'B':
            row += param(0, 1);
            break;
          case 'C':
            col += param(0, 1);
            break;
          case 'D':
            col -= param(0, 1);
            break;
          case 'E':
            row += param(0, 1);
            col = 0;
            break;
          case 'F':
            row -= param(0, 1);
            col = 0;
            break;
          case 'G':
            col = Math.max(0, param(0, 1) - 1);
            absoluteCursorUsed = true;
            break;
          case 'H':
          case 'f':
            row = Math.max(0, param(0, 1) - 1);
            col = Math.max(0, param(1, 1) - 1);
            absoluteCursorUsed = true;
            break;
          case 'd':
            row = Math.max(0, param(0, 1) - 1);
            absoluteCursorUsed = true;
            break;
          case 'J':
            clearDisplay(param(0, 0));
            absoluteCursorUsed = true;
            break;
          case 'K': {
            const mode = param(0, 0);
            if (mode === 1) clearLine(row, 0, col);
            else if (mode === 2) clearLine(row, 0, width - 1);
            else clearLine(row, col, width - 1);
            break;
          }
          case 's':
            savedRow = row;
            savedCol = col;
            break;
          case 'u':
            row = savedRow;
            col = savedCol;
            break;
          case 'm':
            // SGR styling ignored in text snapshot
            break;
          case 'h':
          case 'l':
            if (isPrivate && (param(0, 0) === 1049 || param(0, 0) === 47)) {
              // Alternate screen enter/leave
              clearDisplay(2);
              absoluteCursorUsed = true;
            }
            break;
          default:
            break;
        }

        clampCursor();
        trimHeadIfNeeded();
        i = j + 1;
        continue;
      }

      // OSC
      if (next === ']') {
        let j = i + 2;
        while (j < text.length) {
          if (text[j] === '\x07') {
            j += 1;
            break;
          }
          if (text[j] === '\x1b' && text[j + 1] === '\\') {
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
      col = 0;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow(row);
      trimHeadIfNeeded();
      i += 1;
      continue;
    }

    if (ch === '\b') {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }

    if (ch === '\t') {
      const spaces = 8 - (col % 8);
      for (let s = 0; s < spaces; s++) writeChar(' ');
      i += 1;
      continue;
    }

    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      i += 1;
      continue;
    }

    writeChar(ch);
    i += 1;
  }

  const viewRows = absoluteCursorUsed
    ? rows.slice(0, Math.max(height, Math.min(rows.length, height)))
    : rows.slice(Math.max(0, rows.length - height));

  const lines = viewRows.map((r) => r.join(''));
  return lines.join('\n');
}
