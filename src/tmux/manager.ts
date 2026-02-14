/**
 * tmux session management
 */

import type { TmuxSession } from '../types/index.js';
import type { ICommandExecutor } from '../types/interfaces.js';
import { ShellCommandExecutor } from '../infra/shell.js';
import { escapeShellArg } from '../infra/shell-escape.js';

const TUI_PANE_TITLE = 'discode-tui';
const TUI_PANE_COMMAND_MARKERS = ['discode.js tui', 'discode tui'];
const TUI_PANE_MAX_WIDTH = 60;
const TUI_PANE_DELAY_SECONDS = 0.35;

type AgentPaneHint = 'opencode' | 'claude' | 'codex' | 'gemini';

const AGENT_PANE_MARKERS: Record<AgentPaneHint, string[]> = {
  opencode: ['opencode'],
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini'],
};

type PaneMetadata = {
  index: number;
  title: string;
  startCommand: string;
};

export class TmuxManager {
  private sessionPrefix: string;
  private executor: ICommandExecutor;

  constructor(sessionPrefix: string = '', executor?: ICommandExecutor) {
    this.sessionPrefix = sessionPrefix;
    this.executor = executor || new ShellCommandExecutor();
  }

  listSessions(): TmuxSession[] {
    try {
      const output = this.executor.exec('tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}"');

      return output
        .trim()
        .split('\n')
        .filter((line) => line.startsWith(this.sessionPrefix))
        .map((line) => {
          const [name, attached, windows, created] = line.split('|');
          return {
            name,
            attached: attached === '1',
            windows: parseInt(windows, 10),
            created: new Date(parseInt(created, 10) * 1000),
          };
        });
    } catch (error) {
      // No sessions or tmux not running
      return [];
    }
  }

  getCurrentSession(paneTarget?: string): string | null {
    if (paneTarget) {
      try {
        const output = this.executor.exec(
          `tmux display-message -p -t ${escapeShellArg(paneTarget)} "#{session_name}"`,
        );
        const sessionName = output.trim();
        if (sessionName.length > 0) return sessionName;
      } catch {
        // Fall through to current-client lookup.
      }
    }

    try {
      const output = this.executor.exec('tmux display-message -p "#{session_name}"');
      const sessionName = output.trim();
      return sessionName.length > 0 ? sessionName : null;
    } catch {
      return null;
    }
  }

  getCurrentWindow(paneTarget?: string): string | null {
    if (paneTarget) {
      try {
        const output = this.executor.exec(
          `tmux display-message -p -t ${escapeShellArg(paneTarget)} "#{window_name}"`,
        );
        const windowName = output.trim();
        if (windowName.length > 0) return windowName;
      } catch {
        // Fall through to current-client lookup.
      }

      try {
        const output = this.executor.exec('tmux list-panes -a -F "#{pane_id}|#{window_name}"');
        const matched = output
          .trim()
          .split('\n')
          .map((line) => line.split('|'))
          .find(([paneId]) => paneId === paneTarget);
        const windowName = matched?.[1]?.trim() || '';
        if (windowName.length > 0) return windowName;
      } catch {
        // Fall through to current-client lookup.
      }
    }

    try {
      const output = this.executor.exec('tmux display-message -p "#{window_name}"');
      const windowName = output.trim();
      return windowName.length > 0 ? windowName : null;
    } catch {
      return null;
    }
  }

  createSession(name: string, firstWindowName?: string): void {
    const escapedName = escapeShellArg(`${this.sessionPrefix}${name}`);
    if (firstWindowName) {
      const escapedWindowName = escapeShellArg(firstWindowName);
      this.executor.exec(`tmux new-session -d -s ${escapedName} -n ${escapedWindowName}`);
      return;
    }
    this.executor.exec(`tmux new-session -d -s ${escapedName}`);
  }

  sendKeys(sessionName: string, keys: string): void {
    const escapedTarget = escapeShellArg(`${this.sessionPrefix}${sessionName}`);
    const escapedKeys = escapeShellArg(keys);
    this.executor.exec(`tmux send-keys -t ${escapedTarget} ${escapedKeys}`);
    this.executor.exec(`tmux send-keys -t ${escapedTarget} Enter`);
  }

  capturePane(sessionName: string): string {
    const escapedTarget = escapeShellArg(`${this.sessionPrefix}${sessionName}`);
    return this.executor.exec(`tmux capture-pane -t ${escapedTarget} -p`);
  }

  sessionExists(name: string): boolean {
    try {
      const escapedTarget = escapeShellArg(`${this.sessionPrefix}${name}`);
      this.executor.execVoid(`tmux has-session -t ${escapedTarget}`, {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check for an existing tmux session using the full session name.
   * Useful when session names are not derived from the prefix + projectName.
   */
  sessionExistsFull(fullSessionName: string): boolean {
    try {
      const escapedTarget = escapeShellArg(fullSessionName);
      this.executor.execVoid(`tmux has-session -t ${escapedTarget}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get existing session or create a new one
   * @returns Full session name with prefix
   */
  getOrCreateSession(projectName: string, firstWindowName?: string): string {
    const fullSessionName = `${this.sessionPrefix}${projectName}`;

    if (!this.sessionExists(projectName)) {
      try {
        this.createSession(projectName, firstWindowName);
      } catch (error) {
        throw new Error(`Failed to create tmux session '${fullSessionName}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return fullSessionName;
  }

  /**
   * Create a new window within a session
   * @param sessionName Full session name (already includes prefix)
   */
  createWindow(sessionName: string, windowName: string, initialCommand?: string): void {
    const escapedSession = escapeShellArg(sessionName);
    const escapedWindowName = escapeShellArg(windowName);
    const commandSuffix = initialCommand ? ` ${escapeShellArg(initialCommand)}` : '';

    try {
      this.executor.exec(`tmux new-window -t ${escapedSession} -n ${escapedWindowName}${commandSuffix}`);
    } catch (error) {
      throw new Error(`Failed to create window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List all windows in a session
   * @param sessionName Full session name (already includes prefix)
   */
  listWindows(sessionName: string): string[] {
    try {
      const escapedSession = escapeShellArg(sessionName);
      const output = this.executor.exec(`tmux list-windows -t ${escapedSession} -F "#{window_name}"`);

      return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch (error) {
      throw new Error(`Failed to list windows in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  windowExists(sessionName: string, windowName: string): boolean {
    try {
      const escapedTarget = escapeShellArg(`${sessionName}:${windowName}`);
      this.executor.execVoid(`tmux list-panes -t ${escapedTarget}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a tmux target for a window.
   *
   * If caller already provides an explicit pane target (e.g. `codex.1`), keep it.
   * Otherwise, resolve the lowest existing pane index for the target window.
   * This avoids active-pane drift while also working when tmux pane-base-index is 1.
   */
  private resolveWindowTarget(sessionName: string, windowName: string, paneHint?: string): string {
    const hasExplicitPane = /\.\d+$/.test(windowName);
    if (hasExplicitPane) {
      return `${sessionName}:${windowName}`;
    }

    const baseTarget = `${sessionName}:${windowName}`;

    try {
      const panes = this.listPaneMetadata(sessionName, windowName);

      const hintedAgent = this.resolveAgentPaneHint(paneHint || windowName);
      if (hintedAgent) {
        const hintedPaneIndexes = panes
          .filter((pane) => this.matchesAgentPane(pane, hintedAgent))
          .map((pane) => pane.index);
        if (hintedPaneIndexes.length > 0) {
          const firstHintedPane = Math.min(...hintedPaneIndexes);
          return `${baseTarget}.${firstHintedPane}`;
        }
      }

      const nonTuiPaneIndexes = panes
        .filter((pane) => pane.title !== TUI_PANE_TITLE)
        .map((pane) => pane.index);

      if (nonTuiPaneIndexes.length > 0) {
        const firstNonTuiPane = Math.min(...nonTuiPaneIndexes);
        return `${baseTarget}.${firstNonTuiPane}`;
      }

      const paneIndexes = panes.map((pane) => pane.index);

      if (paneIndexes.length > 0) {
        const firstPane = Math.min(...paneIndexes);
        return `${baseTarget}.${firstPane}`;
      }
    } catch {
      // Fall back to plain window target.
    }

    return baseTarget;
  }

  private resolveAgentPaneHint(targetHint: string): AgentPaneHint | null {
    const normalized = targetHint.trim().toLowerCase();
    if (normalized.length === 0) return null;
    if (/\bopencode\b/.test(normalized)) return 'opencode';
    if (/\bcodex\b/.test(normalized)) return 'codex';
    if (/\bclaude\b/.test(normalized)) return 'claude';
    if (/\bgemini\b/.test(normalized)) return 'gemini';
    return null;
  }

  private matchesAgentPane(pane: PaneMetadata, hint: AgentPaneHint): boolean {
    if (pane.title === TUI_PANE_TITLE) return false;
    const haystack = `${pane.title}\n${pane.startCommand}`.toLowerCase();
    return AGENT_PANE_MARKERS[hint].some((marker) => haystack.includes(marker));
  }

  private listPaneMetadata(sessionName: string, windowName: string): PaneMetadata[] {
    const baseTarget = `${sessionName}:${windowName}`;
    const escapedBaseTarget = escapeShellArg(baseTarget);
      const output = this.executor.exec(
      `tmux list-panes -t ${escapedBaseTarget} -F "#{pane_index}\t#{pane_title}\t#{pane_start_command}"`,
    );

    return output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [indexRaw, titleRaw = '', ...startCommandRest] = line.split('\t');
        const index = /^\d+$/.test(indexRaw) ? parseInt(indexRaw, 10) : NaN;
        return {
          index,
          title: titleRaw,
          startCommand: startCommandRest.join('\t'),
        };
      })
      .filter((pane) => Number.isFinite(pane.index));
  }

  private findTuiPaneTargets(sessionName: string, windowName: string): string[] {
    const baseTarget = `${sessionName}:${windowName}`;
    try {
      const matches = this.listPaneMetadata(sessionName, windowName)
        .map((pane) => {
          const byTitle = pane.title === TUI_PANE_TITLE;
          const byCommand = TUI_PANE_COMMAND_MARKERS.some((marker) => pane.startCommand.includes(marker));
          if (!byTitle && !byCommand) return null;

          return {
            target: `${baseTarget}.${pane.index}`,
            byTitle,
            index: pane.index,
          };
        })
        .filter((pane): pane is { target: string; byTitle: boolean; index: number } => pane !== null)
        .sort((a, b) => {
          if (a.byTitle !== b.byTitle) return a.byTitle ? -1 : 1;
          return a.index - b.index;
        });

      const uniqueTargets = new Set<string>();
      for (const match of matches) {
        uniqueTargets.add(match.target);
      }
      return [...uniqueTargets];
    } catch {
      return [];
    }
  }

  private getWindowWidth(target: string): number | undefined {
    try {
      const output = this.executor.exec(`tmux display-message -p -t ${escapeShellArg(target)} "#{window_width}"`);
      const width = parseInt(output.trim(), 10);
      return Number.isFinite(width) ? width : undefined;
    } catch {
      return undefined;
    }
  }

  private getTuiPaneWidth(windowTarget: string): number {
    const windowWidth = this.getWindowWidth(windowTarget);
    if (windowWidth === undefined) {
      return TUI_PANE_MAX_WIDTH;
    }

    // Keep the TUI pane narrower than the AI pane.
    const maxByBalance = Math.floor((windowWidth - 1) / 2);
    return Math.max(1, Math.min(TUI_PANE_MAX_WIDTH, maxByBalance));
  }

  private resizePaneWidth(target: string, width: number): void {
    try {
      this.executor.exec(`tmux resize-pane -t ${escapeShellArg(target)} -x ${width}`);
    } catch {
      // Best effort.
    }
  }

  private forceTuiPaneWidth(sessionName: string, windowName: string, tuiTarget: string, width: number): void {
    const windowTarget = `${sessionName}:${windowName}`;
    const windowWidth = this.getWindowWidth(windowTarget);
    const paneCount = this.listPaneMetadata(sessionName, windowName).length;

    try {
      this.executor.exec(`tmux set-window-option -t ${escapeShellArg(windowTarget)} window-size latest`);
    } catch {
      // Best effort.
    }

    if (windowWidth !== undefined && paneCount === 2) {
      const mainPaneWidth = Math.max(1, windowWidth - width - 1);
      try {
        this.executor.exec(`tmux select-layout -t ${escapeShellArg(windowTarget)} main-vertical`);
      } catch {
        // Best effort.
      }
      try {
        this.executor.exec(`tmux set-window-option -t ${escapeShellArg(windowTarget)} main-pane-width ${mainPaneWidth}`);
      } catch {
        // Best effort.
      }
    }

    this.resizePaneWidth(tuiTarget, width);

    const delayedScript =
      `sleep ${TUI_PANE_DELAY_SECONDS}; ` +
      `tmux set-window-option -t ${escapeShellArg(windowTarget)} window-size latest >/dev/null 2>&1; ` +
      `tmux resize-pane -t ${escapeShellArg(tuiTarget)} -x ${width} >/dev/null 2>&1`;
    try {
      this.executor.exec(`tmux run-shell -b ${escapeShellArg(delayedScript)}`);
    } catch {
      // Best effort.
    }
  }

  ensureTuiPane(sessionName: string, windowName: string, tuiCommand: string): void {
    const baseTarget = `${sessionName}:${windowName}`;
    const splitWidth = this.getTuiPaneWidth(baseTarget);

    const existingTuiTargets = this.findTuiPaneTargets(sessionName, windowName);
    if (existingTuiTargets.length > 0) {
      const [primaryTarget, ...duplicateTargets] = existingTuiTargets;
      for (const duplicateTarget of duplicateTargets) {
        try {
          this.executor.exec(`tmux kill-pane -t ${escapeShellArg(duplicateTarget)}`);
        } catch {
          // Keep going if cleanup fails for a stale pane target.
        }
      }
      this.forceTuiPaneWidth(sessionName, windowName, primaryTarget, splitWidth);
      return;
    }

    const activeTarget = this.resolveWindowTarget(sessionName, windowName);
    const paneIndexOutput = this.executor.exec(
      `tmux split-window -P -F "#{pane_index}" -t ${escapeShellArg(activeTarget)} -h -l ${splitWidth} ${escapeShellArg(tuiCommand)}`,
    );
    const paneIndex = paneIndexOutput.trim();
    if (/^\d+$/.test(paneIndex)) {
      const tuiTarget = `${baseTarget}.${paneIndex}`;
      this.executor.exec(`tmux select-pane -t ${escapeShellArg(tuiTarget)} -T ${escapeShellArg(TUI_PANE_TITLE)}`);
      this.forceTuiPaneWidth(sessionName, windowName, tuiTarget, splitWidth);
    }

    this.executor.exec(`tmux select-pane -t ${escapeShellArg(activeTarget)}`);
  }

  /**
   * Send keys to a specific window
   * @param sessionName Full session name (already includes prefix)
   */
  sendKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void {
    const target = this.resolveWindowTarget(sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    const escapedKeys = escapeShellArg(keys);

    try {
      // Send keys and Enter separately for reliability
      this.executor.exec(`tmux send-keys -t ${escapedTarget} ${escapedKeys}`);
      this.executor.exec(`tmux send-keys -t ${escapedTarget} Enter`);
    } catch (error) {
      throw new Error(`Failed to send keys to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Type keys into a specific window without pressing Enter.
   * Useful when we want to control submission separately (e.g., Codex retries).
   */
  typeKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void {
    const target = this.resolveWindowTarget(sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    const escapedKeys = escapeShellArg(keys);

    try {
      this.executor.exec(`tmux send-keys -t ${escapedTarget} ${escapedKeys}`);
    } catch (error) {
      throw new Error(`Failed to type keys to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Send an Enter keypress to a specific window.
   * Useful for TUIs that may drop a submit when busy.
   */
  sendEnterToWindow(sessionName: string, windowName: string, paneHint?: string): void {
    const target = this.resolveWindowTarget(sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    try {
      this.executor.exec(`tmux send-keys -t ${escapedTarget} Enter`);
    } catch (error) {
      throw new Error(`Failed to send Enter to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Capture pane output from a specific window
   * @param sessionName Full session name (already includes prefix)
   */
  capturePaneFromWindow(sessionName: string, windowName: string, paneHint?: string): string {
    const target = this.resolveWindowTarget(sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);

    try {
      return this.executor.exec(`tmux capture-pane -t ${escapedTarget} -p`);
    } catch (error) {
      throw new Error(`Failed to capture pane from window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Start an agent in a specific window
   */
  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    // If the target window already exists, send command into it.
    if (this.windowExists(sessionName, windowName)) {
      this.sendKeysToWindow(sessionName, windowName, agentCommand);
      return;
    }

    // Create window with a shell first (no initial command), then send the agent
    // command as keystrokes. This ensures the window persists even if the agent
    // command exits immediately (e.g. missing binary, auth error), so that
    // subsequent operations (TUI pane, attach) still find the window.
    try {
      this.createWindow(sessionName, windowName);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('duplicate window')) {
        throw error;
      }
    }

    try {
      this.sendKeysToWindow(sessionName, windowName, agentCommand);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("can't find window")) {
        throw error;
      }

      // Window name may have been auto-renamed. Recreate with shell and retry.
      this.createWindow(sessionName, windowName);
      this.sendKeysToWindow(sessionName, windowName, agentCommand);
    }
  }

  /**
   * Set an environment variable on a tmux session
   * New windows/processes in that session will inherit it
   */
  setSessionEnv(sessionName: string, key: string, value: string): void {
    const escapedSession = escapeShellArg(sessionName);
    const escapedKey = escapeShellArg(key);
    const escapedValue = escapeShellArg(value);

    try {
      this.executor.exec(`tmux set-environment -t ${escapedSession} ${escapedKey} ${escapedValue}`);
    } catch (error) {
      throw new Error(
        `Failed to set env ${key} on session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Kill a specific window within a session.
   */
  killWindow(sessionName: string, windowName: string): void {
    const target = `${sessionName}:${windowName}`;
    const escapedTarget = escapeShellArg(target);
    this.executor.execVoid(`tmux kill-window -t ${escapedTarget}`, { stdio: 'ignore' });
  }

  /**
   * @deprecated Use escapeShellArg() from src/infra/shell-escape.ts instead.
   */
}
