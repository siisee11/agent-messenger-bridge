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
 * Split text into chunks for Discord (2000 char limit).
 * Strips outermost codeblock fence before splitting.
 * When a codeblock is split across chunks, closes it at the end of the
 * current chunk and re-opens it at the start of the next chunk so that
 * Discord renders each chunk correctly.
 */
export function splitForDiscord(text: string, maxLen: number = 1900): string[] {
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
