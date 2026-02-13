import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PLUGIN_NAME,
  getClaudePluginHooksSource,
  getClaudePluginManifestSource,
  getClaudeStopHookSource,
} from '../../src/claude/plugin-installer.js';

describe('claude plugin installer', () => {
  it('emits valid manifest and hook config JSON', () => {
    const manifest = JSON.parse(getClaudePluginManifestSource()) as Record<string, unknown>;
    expect(manifest.name).toBe(CLAUDE_PLUGIN_NAME);
    expect(manifest.hooks).toBe('./hooks/hooks.json');

    const hooks = JSON.parse(getClaudePluginHooksSource()) as {
      hooks: {
        Stop: Array<{
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };

    expect(hooks.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/scripts/discode-stop-hook.js',
    });
  });

  it('posts claude stop events to the bridge endpoint', () => {
    const source = getClaudeStopHookSource();
    expect(source).toContain('/opencode-event');
    expect(source).toContain('agentType: "claude"');
    expect(source).toContain('type: "session.idle"');
  });
});
