import { describe, expect, it, vi } from 'vitest';
import { TmuxRuntime } from '../../src/runtime/tmux-runtime.js';

function createMockTmuxManager() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('agent-bridge'),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(true),
    startAgentInWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  };
}

describe('TmuxRuntime', () => {
  it('forwards lifecycle methods to tmux manager', () => {
    const tmux = createMockTmuxManager();
    const runtime = new TmuxRuntime(tmux as any);

    const session = runtime.getOrCreateSession('bridge', 'project-claude');
    runtime.setSessionEnv('agent-bridge', 'AGENT_DISCORD_PORT', '18470');
    const exists = runtime.windowExists('agent-bridge', 'project-claude');
    runtime.startAgentInWindow('agent-bridge', 'project-claude', 'claude');

    expect(session).toBe('agent-bridge');
    expect(exists).toBe(true);
    expect(tmux.getOrCreateSession).toHaveBeenCalledWith('bridge', 'project-claude');
    expect(tmux.setSessionEnv).toHaveBeenCalledWith('agent-bridge', 'AGENT_DISCORD_PORT', '18470');
    expect(tmux.windowExists).toHaveBeenCalledWith('agent-bridge', 'project-claude');
    expect(tmux.startAgentInWindow).toHaveBeenCalledWith('agent-bridge', 'project-claude', 'claude');
  });

  it('forwards input methods to tmux manager', () => {
    const tmux = createMockTmuxManager();
    const runtime = new TmuxRuntime(tmux as any);

    runtime.sendKeysToWindow('agent-bridge', 'project-opencode', 'hello', 'opencode');
    runtime.typeKeysToWindow('agent-bridge', 'project-opencode', 'hello', 'opencode');
    runtime.sendEnterToWindow('agent-bridge', 'project-opencode', 'opencode');

    expect(tmux.sendKeysToWindow).toHaveBeenCalledWith('agent-bridge', 'project-opencode', 'hello', 'opencode');
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-bridge', 'project-opencode', 'hello', 'opencode');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-bridge', 'project-opencode', 'opencode');
  });
});
