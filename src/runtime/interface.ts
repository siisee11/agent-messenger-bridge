export interface AgentRuntime {
  getOrCreateSession(projectName: string, firstWindowName?: string): string;
  setSessionEnv(sessionName: string, key: string, value: string): void;
  windowExists(sessionName: string, windowName: string): boolean;
  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void;
  sendKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void;
  typeKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void;
  sendEnterToWindow(sessionName: string, windowName: string, paneHint?: string): void;
  listWindows?: (sessionName?: string) => Array<{
    sessionName: string;
    windowName: string;
    status?: string;
    pid?: number;
    startedAt?: Date;
    exitedAt?: Date;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  }>;
  getWindowBuffer?: (sessionName: string, windowName: string) => string;
  stopWindow?: (sessionName: string, windowName: string, signal?: NodeJS.Signals) => boolean;
}
