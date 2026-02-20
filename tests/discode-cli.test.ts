import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stateManager = {
    listProjects: vi.fn().mockReturnValue([]),
    getProject: vi.fn().mockReturnValue(undefined),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn().mockReturnValue('guild-1'),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    reload: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };

  const config = {
    discord: { token: 'token' },
    tmux: { sessionPrefix: 'agent-', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
    defaultAgentCli: 'claude',
  };

  const agentAdapter = {
    config: { name: 'claude', displayName: 'Claude Code', command: 'claude', channelSuffix: 'claude' },
    isInstalled: vi.fn().mockReturnValue(true),
    getStartCommand: vi.fn().mockReturnValue('claude'),
    matchesChannel: vi.fn(),
  };

  const agentRegistry = {
    getAll: vi.fn().mockReturnValue([agentAdapter]),
    get: vi.fn((name: string) => (name === 'claude' ? agentAdapter : undefined)),
    parseChannelName: vi.fn(),
  };

  const tmux = {
    sessionExistsFull: vi.fn().mockReturnValue(true),
    windowExists: vi.fn().mockReturnValue(true),
    ensureTuiPane: vi.fn(),
    getOrCreateSession: vi.fn(),
    setSessionEnv: vi.fn(),
    startAgentInWindow: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
  };

  const TmuxManager = vi.fn().mockImplementation(function MockTmuxManager() {
    return tmux;
  });

  const bridgeInstances: any[] = [];
  const AgentBridge = vi.fn().mockImplementation(function MockAgentBridge() {
    const instance = {
      connect: vi.fn().mockResolvedValue(undefined),
      setupProject: vi.fn().mockResolvedValue({
        channelName: 'demo-claude',
        channelId: 'ch-1',
        agentName: 'Claude Code',
        tmuxSession: 'agent-bridge',
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    bridgeInstances.push(instance);
    return instance;
  });

  const defaultDaemonManager = {
    getPort: vi.fn().mockReturnValue(18470),
    isRunning: vi.fn().mockResolvedValue(false),
    startDaemon: vi.fn().mockReturnValue(123),
    waitForReady: vi.fn().mockResolvedValue(true),
    stopDaemon: vi.fn().mockReturnValue(true),
    getLogFile: vi.fn().mockReturnValue('/tmp/daemon.log'),
    getPidFile: vi.fn().mockReturnValue('/tmp/daemon.pid'),
  };

  const execSync = vi.fn();
  const spawnSync = vi.fn().mockReturnValue({ status: 0, error: undefined });

  return {
    stateManager,
    config,
    agentAdapter,
    agentRegistry,
    tmux,
    TmuxManager,
    AgentBridge,
    bridgeInstances,
    defaultDaemonManager,
    execSync,
    spawnSync,
  };
});

vi.mock('../src/index.js', () => ({
  AgentBridge: mocks.AgentBridge,
}));

vi.mock('../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

vi.mock('../src/config/index.js', () => ({
  validateConfig: vi.fn(),
  config: mocks.config,
  saveConfig: vi.fn(),
  getConfigPath: vi.fn().mockReturnValue('/tmp/discode/config.json'),
  getConfigValue: vi.fn(),
}));

vi.mock('../src/tmux/manager.js', () => ({
  TmuxManager: mocks.TmuxManager,
}));

vi.mock('../src/agents/index.js', () => ({
  agentRegistry: mocks.agentRegistry,
}));

vi.mock('../src/daemon.js', () => ({
  defaultDaemonManager: mocks.defaultDaemonManager,
}));

vi.mock('../src/discord/client.js', () => ({
  DiscordClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    deleteChannel: vi.fn().mockResolvedValue(true),
    getGuilds: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/tmp/opencode-plugin.ts'),
}));

vi.mock('../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: vi.fn().mockReturnValue('/tmp/claude-plugin'),
}));

vi.mock('../src/gemini/hook-installer.js', () => ({
  installGeminiHook: vi.fn().mockReturnValue('/tmp/gemini-hook.js'),
  removeGeminiHook: vi.fn().mockReturnValue(true),
}));

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
  spawnSync: mocks.spawnSync,
}));

vi.mock('http', () => ({
  request: vi.fn((_url: string, _options: any, callback?: () => void) => {
    callback?.();
    return {
      on: vi.fn(),
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
  }),
}));

function applyExecSyncDefaults() {
  mocks.execSync.mockImplementation((command: string) => {
    if (command === 'tmux -V') return 'tmux 3.4';
    if (command.startsWith('tmux list-panes -a -F "#{pane_tty}"')) {
      throw new Error('no active panes');
    }
    if (command.startsWith('tmux list-panes -t ')) return '';
    if (command.startsWith('tmux kill-window -t ')) return '';
    if (command.startsWith('tmux kill-session -t ')) return '';
    if (command.startsWith('tmux attach-session -t ')) return '';
    if (command.startsWith('tmux switch-client -t ')) return '';
    if (command.startsWith('tmux display-message -p -t ')) return '';
    return '';
  });
}

describe('CLI flow safety (stage 1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.bridgeInstances.length = 0;
    applyExecSyncDefaults();
    mocks.stateManager.listProjects.mockReturnValue([]);
    mocks.stateManager.getProject.mockReturnValue(undefined);
    mocks.stateManager.getGuildId.mockReturnValue('guild-1');
    mocks.tmux.sessionExistsFull.mockReturnValue(true);
    mocks.tmux.windowExists.mockReturnValue(true);
    mocks.defaultDaemonManager.isRunning.mockResolvedValue(false);
  });

  it('new: starts daemon and sets up a new instance', async () => {
    const mod = await import('../bin/discode.ts');

    await mod.newCommand('claude', { name: 'demo', attach: false });

    expect(mocks.defaultDaemonManager.startDaemon).toHaveBeenCalledOnce();
    expect(mocks.AgentBridge).toHaveBeenCalledOnce();

    const bridge = mocks.bridgeInstances[0];
    expect(bridge.connect).toHaveBeenCalledOnce();
    expect(bridge.setupProject).toHaveBeenCalledWith(
      'demo',
      process.cwd(),
      { claude: true },
      undefined,
      18470,
      { instanceId: 'claude', skipRuntimeStart: false },
    );
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it('attach: attaches to requested instance window', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
        'claude-2': { instanceId: 'claude-2', agentType: 'claude', tmuxWindow: 'demo-claude-2', channelId: 'ch-2' },
      },
    };
    mocks.stateManager.getProject.mockReturnValue(project);

    mod.attachCommand('demo', { instance: 'claude-2' });

    const attachOrSwitchCall = mocks.execSync.mock.calls.find(([command]) =>
      typeof command === 'string' &&
      (
        command.includes("tmux attach-session -t 'agent-bridge:demo-claude-2'") ||
        command.includes("tmux switch-client -t 'agent-bridge:demo-claude-2'")
      )
    );
    expect(attachOrSwitchCall).toBeTruthy();
    expect(attachOrSwitchCall?.[1]).toEqual(expect.objectContaining({ stdio: 'inherit' }));
  });

  it('stop: stops one instance and keeps remaining instances in state', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
        'claude-2': { instanceId: 'claude-2', agentType: 'claude', tmuxWindow: 'demo-claude-2', channelId: 'ch-2' },
      },
    };
    mocks.stateManager.getProject.mockReturnValue(project);

    await mod.stopCommand('demo', { instance: 'claude-2', keepChannel: true });

    expect(mocks.execSync).toHaveBeenCalledWith(
      expect.stringContaining("tmux kill-window -t 'agent-bridge:demo-claude-2'"),
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mocks.stateManager.setProject).toHaveBeenCalledOnce();
    expect(mocks.stateManager.removeProject).not.toHaveBeenCalled();
  });

  it('new: shows install guidance when no agents installed', async () => {
    mocks.agentAdapter.isInstalled.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mod = await import('../bin/discode.ts');

    await expect(mod.newCommand(undefined, { name: 'demo', attach: false }))
      .rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);

    // Verify error message
    const errorCall = errorSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('No agent CLIs found')
    );
    expect(errorCall).toBeDefined();

    // Verify install instructions for all three agents
    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('npm install -g @anthropic-ai/claude-code');
    expect(allLogs).toContain('npm install -g @anthropic-ai/gemini-cli');
    expect(allLogs).toContain('go install github.com/anthropics/opencode@latest');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
