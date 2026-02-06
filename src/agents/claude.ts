/**
 * Claude Code agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const claudeConfig: AgentConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  channelSuffix: 'claude',
};

export class ClaudeAdapter extends BaseAgentAdapter {
  constructor() {
    super(claudeConfig);
  }

  getStartCommand(projectPath: string, yolo = false): string {
    const flags = yolo ? ' --dangerously-skip-permissions' : '';
    return `cd "${projectPath}" && ${this.config.command}${flags}`;
  }
}

export const claudeAdapter = new ClaudeAdapter();
