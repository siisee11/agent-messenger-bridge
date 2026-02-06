/**
 * OpenCode CLI agent adapter
 * https://opencode.ai/
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const opencodeConfig: AgentConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  command: 'opencode',
  channelSuffix: 'opencode',
};

export class OpenCodeAdapter extends BaseAgentAdapter {
  constructor() {
    super(opencodeConfig);
  }
}

export const opencodeAdapter = new OpenCodeAdapter();
