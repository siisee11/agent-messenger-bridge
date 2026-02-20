/**
 * Codex (OpenAI) agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const codexConfig: AgentConfig = {
  name: 'codex',
  displayName: 'Codex',
  command: 'codex',
  channelSuffix: 'codex',
};

export class CodexAdapter extends BaseAgentAdapter {
  constructor() {
    super(codexConfig);
  }

  getStartCommand(projectPath: string, permissionAllow = false): string {
    const flag = permissionAllow ? ' --full-auto' : '';
    return `cd "${projectPath}" && ${this.config.command}${flag}`;
  }
}

export const codexAdapter = new CodexAdapter();
