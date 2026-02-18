import { TmuxManager } from '../tmux/manager.js';
import type { AgentRuntime } from './interface.js';

export class TmuxRuntime implements AgentRuntime {
  constructor(private tmux: TmuxManager) {}

  static create(sessionPrefix: string): TmuxRuntime {
    return new TmuxRuntime(new TmuxManager(sessionPrefix));
  }

  getOrCreateSession(projectName: string, firstWindowName?: string): string {
    return this.tmux.getOrCreateSession(projectName, firstWindowName);
  }

  setSessionEnv(sessionName: string, key: string, value: string): void {
    this.tmux.setSessionEnv(sessionName, key, value);
  }

  windowExists(sessionName: string, windowName: string): boolean {
    return this.tmux.windowExists(sessionName, windowName);
  }

  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    this.tmux.startAgentInWindow(sessionName, windowName, agentCommand);
  }

  sendKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void {
    this.tmux.sendKeysToWindow(sessionName, windowName, keys, paneHint);
  }

  typeKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void {
    this.tmux.typeKeysToWindow(sessionName, windowName, keys, paneHint);
  }

  sendEnterToWindow(sessionName: string, windowName: string, paneHint?: string): void {
    this.tmux.sendEnterToWindow(sessionName, windowName, paneHint);
  }

  listWindows(sessionName?: string): Array<{
    sessionName: string;
    windowName: string;
    status: string;
  }> {
    const sessions = sessionName
      ? [sessionName]
      : this.tmux.listSessions().map((session) => session.name);

    const result: Array<{ sessionName: string; windowName: string; status: string }> = [];
    for (const name of sessions) {
      if (!this.tmux.sessionExistsFull(name)) continue;
      let windows: string[] = [];
      try {
        windows = this.tmux.listWindows(name);
      } catch {
        windows = [];
      }
      for (const windowName of windows) {
        result.push({ sessionName: name, windowName, status: 'running' });
      }
    }
    return result;
  }

  getWindowBuffer(sessionName: string, windowName: string): string {
    return this.tmux.capturePaneFromWindow(sessionName, windowName);
  }

  stopWindow(sessionName: string, windowName: string): boolean {
    try {
      this.tmux.killWindow(sessionName, windowName);
      return true;
    } catch {
      return false;
    }
  }

  resizeWindow(_sessionName: string, _windowName: string, _cols: number, _rows: number): void {
    // tmux runtime currently relies on terminal/tmux native sizing behavior.
  }

  dispose(): void {
    // tmux-backed runtime does not own process lifecycles directly.
  }
}
