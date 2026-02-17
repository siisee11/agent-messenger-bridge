import { beforeEach, describe, expect, it, vi } from 'vitest';

const installerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn(),
  installClaudePlugin: vi.fn(),
  installGeminiHook: vi.fn(),
}));

vi.mock('../../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: installerMocks.installOpencodePlugin,
}));

vi.mock('../../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: installerMocks.installClaudePlugin,
}));

vi.mock('../../src/gemini/hook-installer.js', () => ({
  installGeminiHook: installerMocks.installGeminiHook,
}));

import { installAgentIntegration } from '../../src/policy/agent-integration.js';

describe('agent integration policy', () => {
  beforeEach(() => {
    installerMocks.installOpencodePlugin.mockReset();
    installerMocks.installClaudePlugin.mockReset();
    installerMocks.installGeminiHook.mockReset();
  });

  it('returns claude plugin dir and event hook on success', () => {
    installerMocks.installClaudePlugin.mockReturnValue('/mock/claude/plugin');

    const result = installAgentIntegration('claude', '/project', 'install');

    expect(result.eventHookInstalled).toBe(true);
    expect(result.claudePluginDir).toBe('/mock/claude/plugin');
    expect(result.infoMessages).toContain('🪝 Installed Claude Code plugin: /mock/claude/plugin');
    expect(result.warningMessages).toHaveLength(0);
  });

  it('returns warning and no hook on gemini install failure', () => {
    installerMocks.installGeminiHook.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const result = installAgentIntegration('gemini', '/project', 'reinstall');

    expect(result.eventHookInstalled).toBe(false);
    expect(result.infoMessages).toHaveLength(0);
    expect(result.warningMessages).toContain('Could not reinstall Gemini CLI hook: permission denied');
  });
});
