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
 * Split text into chunks for Discord (2000 char limit)
 */
export function splitForDiscord(text: string, maxLen: number = 1900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      current = line.length > maxLen ? line.substring(0, maxLen) : line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
