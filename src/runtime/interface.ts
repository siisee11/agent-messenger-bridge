export interface AgentRuntime {
  getOrCreateSession(projectName: string, firstWindowName?: string): string;
  setSessionEnv(sessionName: string, key: string, value: string): void;
  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void;
  sendKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void;
  typeKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void;
  sendEnterToWindow(sessionName: string, windowName: string, paneHint?: string): void;
}
