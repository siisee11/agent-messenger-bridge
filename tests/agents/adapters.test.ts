/**
 * Tests for OpenCodeAdapter and CodexAdapter
 */

import { OpenCodeAdapter } from '../../src/agents/opencode.js';
import { CodexAdapter } from '../../src/agents/codex.js';

describe('OpenCodeAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new OpenCodeAdapter();

    expect(adapter.config.name).toBe('opencode');
    expect(adapter.config.displayName).toBe('OpenCode');
    expect(adapter.config.command).toBe('opencode');
    expect(adapter.config.channelSuffix).toBe('opencode');
  });

  it('should return expected start command', () => {
    const adapter = new OpenCodeAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && opencode');
  });
});

describe('CodexAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new CodexAdapter();

    expect(adapter.config.name).toBe('codex');
    expect(adapter.config.displayName).toBe('Codex CLI');
    expect(adapter.config.command).toBe('codex');
    expect(adapter.config.channelSuffix).toBe('codex');
  });

  it('should return expected start command', () => {
    const adapter = new CodexAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && codex');
  });
});
