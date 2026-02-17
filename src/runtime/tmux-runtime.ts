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
}
