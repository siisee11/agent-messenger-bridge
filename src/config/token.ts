/**
 * Normalize Discord bot tokens from CLI/env/config input.
 * Handles common copy-paste mistakes (quotes, Bot/Bearer prefix, whitespace).
 */
export function normalizeDiscordToken(input?: string): string {
  if (!input) return '';

  let token = input.trim();
  if (!token) return '';

  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  token = token.replace(/^(bot|bearer)\s+/i, '').trim();
  token = token.replace(/\s+/g, '');

  return token;
}
