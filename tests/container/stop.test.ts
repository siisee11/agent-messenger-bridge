/**
 * Tests for container cleanup in the stop command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock container modules
const containerMocks = vi.hoisted(() => ({
  stopContainer: vi.fn().mockReturnValue(true),
  removeContainer: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/container/index.js', () => containerMocks);

const syncInstanceMethods = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  finalSync: vi.fn(),
  syncOnce: vi.fn(),
}));

vi.mock('../../src/container/sync.js', () => ({
  ContainerSync: class MockContainerSync {
    start = syncInstanceMethods.start;
    stop = syncInstanceMethods.stop;
    finalSync = syncInstanceMethods.finalSync;
    syncOnce = syncInstanceMethods.syncOnce;
  },
}));

// Mock state
const mockStateManager = vi.hoisted(() => ({
  getProject: vi.fn(),
  setProject: vi.fn(),
  removeProject: vi.fn(),
  listProjects: vi.fn().mockReturnValue([]),
  reload: vi.fn(),
  getGuildId: vi.fn(),
  setGuildId: vi.fn(),
  getWorkspaceId: vi.fn(),
  setWorkspaceId: vi.fn(),
  updateLastActive: vi.fn(),
  findProjectByChannel: vi.fn(),
  getAgentTypeByChannel: vi.fn(),
}));

vi.mock('../../src/state/index.js', () => ({
  stateManager: mockStateManager,
}));

// Mock config
vi.mock('../../src/config/index.js', () => ({
  config: {
    discord: { token: 'test' },
    tmux: { sessionPrefix: '', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
    runtimeMode: 'pty',
    container: { enabled: true, socketPath: '/test/docker.sock' },
  },
  getConfigValue: vi.fn().mockReturnValue(undefined),
}));

// Mock channel service
vi.mock('../../src/app/channel-service.js', () => ({
  deleteChannels: vi.fn().mockResolvedValue([]),
}));

// Mock project service
vi.mock('../../src/app/project-service.js', () => ({
  removeInstanceFromProjectState: vi.fn().mockReturnValue({ projectFound: true, instanceFound: true, removedProject: true }),
  removeProjectState: vi.fn().mockReturnValue(true),
}));

// Mock tmux helpers
vi.mock('../../src/cli/common/tmux.js', () => ({
  applyTmuxCliOverrides: (_config: any) => ({
    discord: { token: 'test' },
    tmux: { sessionPrefix: '', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
    runtimeMode: 'pty',
    container: { enabled: true, socketPath: '/test/docker.sock' },
  }),
  cleanupStaleDiscodeTuiProcesses: vi.fn().mockReturnValue(0),
  escapeShellArg: (s: string) => `'${s}'`,
  resolveProjectWindowName: vi.fn().mockReturnValue('test-claude'),
  terminateTmuxPaneProcesses: vi.fn().mockResolvedValue(0),
}));

// Mock runtime-api
vi.mock('../../src/cli/common/runtime-api.js', () => ({
  stopRuntimeWindow: vi.fn().mockResolvedValue(true),
}));

import { stopCommand } from '../../src/cli/commands/stop.js';
import type { ProjectState } from '../../src/types/index.js';

describe('stop command container cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncInstanceMethods.finalSync.mockClear();
  });

  it('performs final sync and removes container on single instance stop (pty mode)', async () => {
    const project: ProjectState = {
      projectName: 'test-project',
      projectPath: '/test/path',
      tmuxSession: 'bridge',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'test-claude',
          channelId: 'ch-1',
          containerMode: true,
          containerId: 'container-xyz',
          containerName: 'discode-test-project-claude',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    };
    mockStateManager.getProject.mockReturnValue(project);

    await stopCommand('test-project', { instance: 'claude' });

    // Should have performed final sync
    expect(syncInstanceMethods.finalSync).toHaveBeenCalled();

    // Should have stopped the container
    expect(containerMocks.stopContainer).toHaveBeenCalledWith('container-xyz', '/test/docker.sock');

    // Should have removed the container
    expect(containerMocks.removeContainer).toHaveBeenCalledWith('container-xyz', '/test/docker.sock');
  });

  it('cleans up all containers when stopping entire project (pty mode)', async () => {
    const project: ProjectState = {
      projectName: 'test-project',
      projectPath: '/test/path',
      tmuxSession: 'bridge',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'test-claude',
          channelId: 'ch-1',
          containerMode: true,
          containerId: 'container-aaa',
          containerName: 'discode-test-project-claude',
        },
        'claude-2': {
          instanceId: 'claude-2',
          agentType: 'claude',
          tmuxWindow: 'test-claude-2',
          channelId: 'ch-2',
          containerMode: true,
          containerId: 'container-bbb',
          containerName: 'discode-test-project-claude-2',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    };
    mockStateManager.getProject.mockReturnValue(project);

    await stopCommand('test-project', {});

    // Both containers should be stopped and removed
    expect(containerMocks.stopContainer).toHaveBeenCalledWith('container-aaa', '/test/docker.sock');
    expect(containerMocks.stopContainer).toHaveBeenCalledWith('container-bbb', '/test/docker.sock');
    expect(containerMocks.removeContainer).toHaveBeenCalledWith('container-aaa', '/test/docker.sock');
    expect(containerMocks.removeContainer).toHaveBeenCalledWith('container-bbb', '/test/docker.sock');
  });

  it('skips container cleanup for non-container instances', async () => {
    const project: ProjectState = {
      projectName: 'test-project',
      projectPath: '/test/path',
      tmuxSession: 'bridge',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'test-claude',
          channelId: 'ch-1',
          // No containerMode
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    };
    mockStateManager.getProject.mockReturnValue(project);

    await stopCommand('test-project', { instance: 'claude' });

    expect(containerMocks.stopContainer).not.toHaveBeenCalled();
    expect(containerMocks.removeContainer).not.toHaveBeenCalled();
  });
});
