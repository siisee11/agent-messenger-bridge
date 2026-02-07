/**
 * Tests for ClaudeAdapter from src/agents/claude.ts
 */

import { ClaudeAdapter } from '../../src/agents/claude.js';

describe('ClaudeAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new ClaudeAdapter();

    expect(adapter.config.name).toBe('claude');
    expect(adapter.config.displayName).toBe('Claude Code');
    expect(adapter.config.command).toBe('claude');
    expect(adapter.config.channelSuffix).toBe('claude');
  });

  it('should return basic command without yolo flag', () => {
    const adapter = new ClaudeAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && claude');
  });

  it('should add --dangerously-skip-permissions flag when yolo is true', () => {
    const adapter = new ClaudeAdapter();

    const command = adapter.getStartCommand('/path/to/project', true);

    expect(command).toBe('cd "/path/to/project" && claude --dangerously-skip-permissions');
  });

  it('should correctly match channel name', () => {
    const adapter = new ClaudeAdapter();

    const matches = adapter.matchesChannel('myproject-claude', 'myproject');

    expect(matches).toBe(true);
  });

  it('should not match incorrect channel name', () => {
    const adapter = new ClaudeAdapter();

    const matches = adapter.matchesChannel('myproject-other', 'myproject');

    expect(matches).toBe(false);
  });
});
