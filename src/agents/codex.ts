/**
 * OpenAI Codex CLI agent adapter
 * https://developers.openai.com/codex/cli/
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const codexConfig: AgentConfig = {
  name: 'codex',
  displayName: 'Codex CLI',
  command: 'codex',
  channelSuffix: 'codex',
};

export class CodexAdapter extends BaseAgentAdapter {
  constructor() {
    super(codexConfig);
  }
}

export const codexAdapter = new CodexAdapter();
