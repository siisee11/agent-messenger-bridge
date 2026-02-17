/**
 * Tests for the default agent registry
 */

import { createAgentRegistry } from '../../src/agents/index.js';
import { describe, expect, it } from 'vitest';

describe('createAgentRegistry', () => {
  it('registers claude adapter', () => {
    const registry = createAgentRegistry();
    expect(registry.get('claude')).toBeDefined();
  });

  it('registers gemini adapter', () => {
    const registry = createAgentRegistry();
    expect(registry.get('gemini')).toBeDefined();
  });
});
