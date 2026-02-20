import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stateManager = {
    getProject: vi.fn().mockReturnValue(undefined),
    listProjects: vi.fn().mockReturnValue([]),
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
    tmux: { sessionPrefix: '', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
    runtimeMode: 'pty' as string,
  };

  const getConfigValue = vi.fn().mockReturnValue(undefined);

  const deleteChannels = vi.fn().mockResolvedValue([]);
  const removeInstanceFromProjectState = vi.fn().mockReturnValue({ removedProject: false });
  const removeProjectState = vi.fn();
  const listProjectInstances = vi.fn().mockReturnValue([]);
  const getProjectInstance = vi.fn().mockReturnValue(undefined);

  const stopRuntimeWindow = vi.fn().mockResolvedValue(true);
  const stopContainer = vi.fn().mockReturnValue(true);
  const removeContainer = vi.fn().mockReturnValue(true);

  const ContainerSync = vi.fn().mockImplementation(function MockSync() {
    (this as any).finalSync = vi.fn();
  });

  const execSync = vi.fn();

  return {
    stateManager,
    config,
    getConfigValue,
    deleteChannels,
    removeInstanceFromProjectState,
    removeProjectState,
    listProjectInstances,
    getProjectInstance,
    stopRuntimeWindow,
    stopContainer,
    removeContainer,
    ContainerSync,
    execSync,
  };
});

vi.mock('../../../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: mocks.config,
  getConfigValue: mocks.getConfigValue,
}));

vi.mock('../../../src/app/channel-service.js', () => ({
  deleteChannels: mocks.deleteChannels,
}));

vi.mock('../../../src/app/project-service.js', () => ({
  removeInstanceFromProjectState: mocks.removeInstanceFromProjectState,
  removeProjectState: mocks.removeProjectState,
}));

vi.mock('../../../src/state/instances.js', () => ({
  listProjectInstances: mocks.listProjectInstances,
  getProjectInstance: mocks.getProjectInstance,
}));

vi.mock('../../../src/cli/common/runtime-api.js', () => ({
  stopRuntimeWindow: mocks.stopRuntimeWindow,
}));

vi.mock('../../../src/container/index.js', () => ({
  stopContainer: mocks.stopContainer,
  removeContainer: mocks.removeContainer,
}));

vi.mock('../../../src/container/sync.js', () => ({
  ContainerSync: mocks.ContainerSync,
}));

vi.mock('../../../src/cli/common/tmux.js', () => ({
  applyTmuxCliOverrides: vi.fn((_config: any, _options: any) => mocks.config),
  cleanupStaleDiscodeTuiProcesses: vi.fn().mockReturnValue(0),
  escapeShellArg: vi.fn((s: string) => `'${s}'`),
  resolveProjectWindowName: vi.fn().mockReturnValue('demo-claude'),
  terminateTmuxPaneProcesses: vi.fn().mockResolvedValue(0),
}));

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
}));

function makeProject(overrides?: any) {
  return {
    tmuxSession: 'bridge',
    projectPath: '/test/project',
    ...overrides,
  };
}

function makeInstance(overrides?: any) {
  return {
    instanceId: 'claude-1',
    agentType: 'claude',
    channelId: 'ch-123',
    ...overrides,
  };
}

// Helper to find console.log calls containing a substring
function findLogCall(spy: ReturnType<typeof vi.spyOn>, substring: string) {
  return spy.mock.calls.find((call) =>
    typeof call[0] === 'string' && call[0].includes(substring)
  );
}

describe('stopCommand — keepChannelOnStop config (pty single instance)', () => {
  let stopCommand: typeof import('../../../src/cli/commands/stop.js').stopCommand;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config.runtimeMode = 'pty';
    mocks.deleteChannels.mockResolvedValue([]);
    mocks.removeInstanceFromProjectState.mockReturnValue({ removedProject: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../../../src/cli/commands/stop.js');
    stopCommand = mod.stopCommand;
  });

  it('deletes channel by default (keepChannelOnStop not set)', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(undefined);
    mocks.deleteChannels.mockResolvedValue(['ch-123']);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.deleteChannels).toHaveBeenCalledWith(['ch-123']);
  });

  it('preserves channel when keepChannelOnStop=true in config', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(true);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.deleteChannels).not.toHaveBeenCalled();
  });

  it('prints preserve message when keepChannelOnStop=true', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(true);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(findLogCall(consoleSpy, 'Channel preserved')).toBeDefined();
  });

  it('--keep-channel CLI flag overrides config=false', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(false);

    await stopCommand('demo', { instance: 'claude-1', keepChannel: true });

    expect(mocks.deleteChannels).not.toHaveBeenCalled();
    expect(findLogCall(consoleSpy, 'Channel preserved')).toBeDefined();
  });

  it('deletes channel when keepChannelOnStop=false explicitly', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(false);
    mocks.deleteChannels.mockResolvedValue(['ch-123']);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.deleteChannels).toHaveBeenCalledWith(['ch-123']);
  });

  it('does not show preserve message when channel is deleted', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(undefined);
    mocks.deleteChannels.mockResolvedValue(['ch-123']);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(findLogCall(consoleSpy, 'Channel preserved')).toBeUndefined();
  });

  it('does not attempt deletion or preserve for instance without channelId', async () => {
    const instance = makeInstance({ channelId: undefined });
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(true);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.deleteChannels).not.toHaveBeenCalled();
    expect(findLogCall(consoleSpy, 'Channel preserved')).toBeUndefined();
  });
});

describe('stopCommand — keepChannelOnStop config (pty bulk project stop)', () => {
  let stopCommand: typeof import('../../../src/cli/commands/stop.js').stopCommand;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config.runtimeMode = 'pty';
    mocks.removeProjectState.mockReturnValue(undefined);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../../../src/cli/commands/stop.js');
    stopCommand = mod.stopCommand;
  });

  it('deletes all channels when keepChannelOnStop not set (bulk)', async () => {
    const instances = [
      makeInstance({ instanceId: 'claude-1', channelId: 'ch-1' }),
      makeInstance({ instanceId: 'claude-2', channelId: 'ch-2' }),
    ];
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.listProjectInstances.mockReturnValue(instances);
    mocks.getConfigValue.mockReturnValue(undefined);
    mocks.deleteChannels.mockResolvedValue(['ch-1', 'ch-2']);

    // No instance option → bulk stop
    await stopCommand('demo', {});

    expect(mocks.deleteChannels).toHaveBeenCalledWith(['ch-1', 'ch-2']);
  });

  it('preserves all channels when keepChannelOnStop=true (bulk)', async () => {
    const instances = [
      makeInstance({ instanceId: 'claude-1', channelId: 'ch-1' }),
      makeInstance({ instanceId: 'claude-2', channelId: 'ch-2' }),
    ];
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.listProjectInstances.mockReturnValue(instances);
    mocks.getConfigValue.mockReturnValue(true);

    await stopCommand('demo', {});

    expect(mocks.deleteChannels).not.toHaveBeenCalled();
    expect(findLogCall(consoleSpy, 'Channels preserved')).toBeDefined();
  });
});

describe('stopCommand — keepChannelOnStop config (tmux single instance)', () => {
  let stopCommand: typeof import('../../../src/cli/commands/stop.js').stopCommand;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config.runtimeMode = 'tmux';
    mocks.removeInstanceFromProjectState.mockReturnValue({ removedProject: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../../../src/cli/commands/stop.js');
    stopCommand = mod.stopCommand;
  });

  it('deletes channel by default in tmux mode', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(undefined);
    mocks.deleteChannels.mockResolvedValue(['ch-123']);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.deleteChannels).toHaveBeenCalledWith(['ch-123']);
  });

  it('preserves channel when keepChannelOnStop=true in tmux mode', async () => {
    const instance = makeInstance();
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(true);

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.deleteChannels).not.toHaveBeenCalled();
    expect(findLogCall(consoleSpy, 'Channel preserved')).toBeDefined();
  });
});

describe('stopCommand — keepChannelOnStop config (tmux bulk project stop)', () => {
  let stopCommand: typeof import('../../../src/cli/commands/stop.js').stopCommand;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config.runtimeMode = 'tmux';
    mocks.removeProjectState.mockReturnValue(undefined);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../../../src/cli/commands/stop.js');
    stopCommand = mod.stopCommand;
  });

  it('deletes all channels in tmux bulk stop by default', async () => {
    const instances = [
      makeInstance({ instanceId: 'claude-1', channelId: 'ch-1' }),
      makeInstance({ instanceId: 'claude-2', channelId: 'ch-2' }),
    ];
    const project = makeProject({ tmuxSession: 'my-project' });
    mocks.stateManager.getProject.mockReturnValue(project);
    mocks.listProjectInstances.mockReturnValue(instances);
    mocks.getConfigValue.mockReturnValue(undefined);
    mocks.deleteChannels.mockResolvedValue(['ch-1', 'ch-2']);

    await stopCommand('demo', {});

    expect(mocks.deleteChannels).toHaveBeenCalledWith(['ch-1', 'ch-2']);
  });

  it('preserves all channels when keepChannelOnStop=true in tmux bulk stop', async () => {
    const instances = [
      makeInstance({ instanceId: 'claude-1', channelId: 'ch-1' }),
      makeInstance({ instanceId: 'claude-2', channelId: 'ch-2' }),
    ];
    const project = makeProject({ tmuxSession: 'my-project' });
    mocks.stateManager.getProject.mockReturnValue(project);
    mocks.listProjectInstances.mockReturnValue(instances);
    mocks.getConfigValue.mockReturnValue(true);

    await stopCommand('demo', {});

    expect(mocks.deleteChannels).not.toHaveBeenCalled();
    expect(findLogCall(consoleSpy, 'Channels preserved')).toBeDefined();
  });
});

describe('stopCommand — container sync warning', () => {
  let stopCommand: typeof import('../../../src/cli/commands/stop.js').stopCommand;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config.runtimeMode = 'pty';
    mocks.removeInstanceFromProjectState.mockReturnValue({ removedProject: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../../../src/cli/commands/stop.js');
    stopCommand = mod.stopCommand;
  });

  it('shows warning when container sync fails', async () => {
    const instance = makeInstance({ containerMode: true, containerId: 'abc123' });
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(undefined);

    mocks.ContainerSync.mockImplementation(function MockSync() {
      (this as any).finalSync = vi.fn(() => { throw new Error('sync timeout'); });
    });

    await stopCommand('demo', { instance: 'claude-1' });

    const syncWarning = findLogCall(consoleSpy, 'Container file sync failed');
    expect(syncWarning).toBeDefined();
    expect(syncWarning![0]).toContain('sync timeout');
  });

  it('does not show warning when container sync succeeds', async () => {
    const instance = makeInstance({ containerMode: true, containerId: 'abc123' });
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(undefined);

    mocks.ContainerSync.mockImplementation(function MockSync() {
      (this as any).finalSync = vi.fn();
    });

    await stopCommand('demo', { instance: 'claude-1' });

    expect(findLogCall(consoleSpy, 'Container file sync failed')).toBeUndefined();
  });

  it('still stops and removes container even when sync fails', async () => {
    const instance = makeInstance({ containerMode: true, containerId: 'abc123', containerName: 'my-container' });
    mocks.stateManager.getProject.mockReturnValue(makeProject());
    mocks.getProjectInstance.mockReturnValue(instance);
    mocks.getConfigValue.mockReturnValue(undefined);

    mocks.ContainerSync.mockImplementation(function MockSync() {
      (this as any).finalSync = vi.fn(() => { throw new Error('sync fail'); });
    });

    await stopCommand('demo', { instance: 'claude-1' });

    expect(mocks.stopContainer).toHaveBeenCalledWith('abc123', undefined);
    expect(mocks.removeContainer).toHaveBeenCalledWith('abc123', undefined);
  });
});
