/**
 * Tests for AgentRegistry from src/agents/base.ts
 */

import { AgentRegistry, BaseAgentAdapter, type AgentConfig } from '../../src/agents/base.js';

class TestAdapter extends BaseAgentAdapter {
  constructor(name: string, suffix: string) {
    const config: AgentConfig = {
      name,
      displayName: name,
      command: name,
      channelSuffix: suffix,
    };
    super(config);
  }
}

describe('AgentRegistry', () => {
  it('should register and get an adapter', () => {
    const registry = new AgentRegistry();
    const adapter = new TestAdapter('test-agent', 'test');

    registry.register(adapter);

    const retrieved = registry.get('test-agent');
    expect(retrieved).toBe(adapter);
  });

  it('should return undefined for unknown agent', () => {
    const registry = new AgentRegistry();

    const retrieved = registry.get('unknown-agent');

    expect(retrieved).toBeUndefined();
  });

  it('should return all registered adapters', () => {
    const registry = new AgentRegistry();
    const adapter1 = new TestAdapter('agent1', 'suffix1');
    const adapter2 = new TestAdapter('agent2', 'suffix2');

    registry.register(adapter1);
    registry.register(adapter2);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(adapter1);
    expect(all).toContain(adapter2);
  });

  it('should find adapter by channel suffix', () => {
    const registry = new AgentRegistry();
    const adapter = new TestAdapter('test-agent', 'test-suffix');

    registry.register(adapter);

    const found = registry.getByChannelSuffix('test-suffix');
    expect(found).toBe(adapter);
  });

  it('should return undefined for unknown channel suffix', () => {
    const registry = new AgentRegistry();
    const adapter = new TestAdapter('test-agent', 'test-suffix');

    registry.register(adapter);

    const found = registry.getByChannelSuffix('unknown-suffix');
    expect(found).toBeUndefined();
  });

  it('should parse channel name and extract project name and agent', () => {
    const registry = new AgentRegistry();
    const adapter = new TestAdapter('claude', 'claude');

    registry.register(adapter);

    const result = registry.parseChannelName('myproject-claude');
    expect(result).not.toBeNull();
    expect(result?.projectName).toBe('myproject');
    expect(result?.agent).toBe(adapter);
  });

  it('should return null for unmatched channel name', () => {
    const registry = new AgentRegistry();
    const adapter = new TestAdapter('claude', 'claude');

    registry.register(adapter);

    const result = registry.parseChannelName('myproject-unknown');
    expect(result).toBeNull();
  });
});
