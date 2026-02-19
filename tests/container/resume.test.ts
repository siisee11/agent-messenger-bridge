/**
 * Tests for container instance resume/recovery in project-service.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock container module
const containerMocks = vi.hoisted(() => ({
  containerExists: vi.fn().mockReturnValue(true),
  buildDockerStartCommand: vi.fn().mockReturnValue('docker start -ai container-abc'),
}));

vi.mock('../../src/container/index.js', () => containerMocks);

// Mock plugin installers
vi.mock('../../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/mock/plugin'),
}));

vi.mock('../../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: vi.fn().mockReturnValue('/mock/plugin'),
}));

vi.mock('../../src/gemini/hook-installer.js', () => ({
  installGeminiHook: vi.fn().mockReturnValue('/mock/hook'),
}));

// Mock state
vi.mock('../../src/state/index.js', () => ({
  stateManager: {
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
  },
}));

import { resumeProjectInstance } from '../../src/app/project-service.js';
import type { BridgeConfig, ProjectState, ProjectInstanceState } from '../../src/types/index.js';

function createConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    discord: { token: 'test' },
    tmux: { sessionPrefix: '', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
    ...overrides,
  };
}

function createMockRuntime() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('bridge'),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(false),
    startAgentInWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
}

describe('resumeProjectInstance with container mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.containerExists.mockReturnValue(true);
  });

  it('restores container instance using docker start command', async () => {
    const runtime = createMockRuntime();
    const project: ProjectState = {
      projectName: 'test',
      projectPath: '/test',
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
          containerId: 'container-abc',
          containerName: 'discode-test-claude',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    };

    const instance: ProjectInstanceState = project.instances!.claude!;

    const result = await resumeProjectInstance({
      config: createConfig({ container: { enabled: true, socketPath: '/sock' } }),
      projectName: 'test',
      project,
      instance,
      port: 18470,
      runtime,
    });

    expect(containerMocks.containerExists).toHaveBeenCalledWith('container-abc', '/sock');
    expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
      'bridge',
      'test-claude',
      'docker start -ai container-abc',
    );
    expect(result.restoredWindow).toBe(true);
    expect(result.infoMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Restored container runtime window'),
      ]),
    );
  });

  it('warns when container no longer exists', async () => {
    containerMocks.containerExists.mockReturnValue(false);

    const runtime = createMockRuntime();
    const project: ProjectState = {
      projectName: 'test',
      projectPath: '/test',
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
          containerId: 'container-gone',
          containerName: 'discode-test-claude',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    };

    const instance: ProjectInstanceState = project.instances!.claude!;

    const result = await resumeProjectInstance({
      config: createConfig({ container: { enabled: true } }),
      projectName: 'test',
      project,
      instance,
      port: 18470,
      runtime,
    });

    // Should not attempt to start
    expect(runtime.startAgentInWindow).not.toHaveBeenCalled();

    // Should warn
    expect(result.warningMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no longer exists'),
      ]),
    );
  });

  it('falls back to standard resume for non-container instances', async () => {
    const runtime = createMockRuntime();
    const project: ProjectState = {
      projectName: 'test',
      projectPath: '/test',
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

    const instance: ProjectInstanceState = project.instances!.claude!;

    const result = await resumeProjectInstance({
      config: createConfig(),
      projectName: 'test',
      project,
      instance,
      port: 18470,
      runtime,
    });

    // Should use standard agent command, not docker start
    expect(containerMocks.buildDockerStartCommand).not.toHaveBeenCalled();
    expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
      'bridge',
      'test-claude',
      expect.stringContaining('export AGENT_DISCORD_PROJECT='),
    );
    expect(result.restoredWindow).toBe(true);
  });
});
