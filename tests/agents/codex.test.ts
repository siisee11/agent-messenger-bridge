import { CodexAdapter } from '../../src/agents/codex.js';
import { describe, expect, it } from 'vitest';

describe('CodexAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new CodexAdapter();

    expect(adapter.config.name).toBe('codex');
    expect(adapter.config.displayName).toBe('Codex');
    expect(adapter.config.command).toBe('codex');
    expect(adapter.config.channelSuffix).toBe('codex');
  });

  it('should return expected start command', () => {
    const adapter = new CodexAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && codex');
  });

  it('should append --full-auto when permissionAllow is true', () => {
    const adapter = new CodexAdapter();

    const command = adapter.getStartCommand('/path/to/project', true);

    expect(command).toBe('cd "/path/to/project" && codex --full-auto');
  });

  it('should correctly match channel name', () => {
    const adapter = new CodexAdapter();

    expect(adapter.matchesChannel('myproject-codex', 'myproject')).toBe(true);
  });

  it('should not match incorrect channel name', () => {
    const adapter = new CodexAdapter();

    expect(adapter.matchesChannel('myproject-claude', 'myproject')).toBe(false);
    expect(adapter.matchesChannel('myproject-codex', 'otherproject')).toBe(false);
  });
});
