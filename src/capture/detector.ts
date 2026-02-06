/**
 * Agent state detection from tmux capture diffs
 */

export type AgentState = 'working' | 'stopped' | 'offline';

/**
 * Detect agent state based on capture content changes
 *
 * - 'working': capture content changed since last poll
 * - 'stopped': capture content is stable (unchanged for 1+ polls)
 * - 'offline': tmux session/window doesn't exist
 */
export function detectState(
  current: string | null,
  previous: string | null,
  _stableCount: number
): AgentState {
  if (current === null) return 'offline';
  if (previous === null) return 'working'; // First capture
  if (current !== previous) return 'working';
  return 'stopped';
}
