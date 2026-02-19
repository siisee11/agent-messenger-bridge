/**
 * Integration tests for container mode.
 *
 * Tests the full flow of setupProject with container enabled,
 * message-router file injection, stop cleanup, and resume recovery.
 * All Docker calls are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock container module ────────────────────────────────────────────

const containerMocks = vi.hoisted(() => ({
  isDockerAvailable: vi.fn().mockReturnValue(true),
  createContainer: vi.fn().mockReturnValue('abc123def456'),
  buildDockerStartCommand: vi.fn().mockReturnValue('docker start -ai abc123def456'),
  injectCredentials: vi.fn(),
  injectChromeMcpBridge: vi.fn().mockReturnValue(false),
  injectFile: vi.fn().mockReturnValue(true),
  containerExists: vi.fn().mockReturnValue(true),
  stopContainer: vi.fn().mockReturnValue(true),
  removeContainer: vi.fn().mockReturnValue(true),
  findDockerSocket: vi.fn().mockReturnValue('/var/run/docker.sock'),
  isContainerRunning: vi.fn().mockReturnValue(true),
  ensureImage: vi.fn(),
  ChromeMcpProxy: class MockChromeMcpProxy {
    async start() { return false; }
    stop() {}
    isActive() { return false; }
    getPort() { return 18471; }
  },
  WORKSPACE_DIR: '/workspace',
  FULL_IMAGE_TAG: 'discode-agent:1',
}));

const syncInstanceMethods = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  finalSync: vi.fn(),
  syncOnce: vi.fn(),
}));

const containerSyncCalls = vi.hoisted(() => ({ args: [] as any[] }));

vi.mock('../../src/container/index.js', () => containerMocks);

vi.mock('../../src/container/sync.js', () => ({
  ContainerSync: class MockContainerSync {
    start = syncInstanceMethods.start;
    stop = syncInstanceMethods.stop;
    finalSync = syncInstanceMethods.finalSync;
    syncOnce = syncInstanceMethods.syncOnce;
    constructor(options: any) {
      containerSyncCalls.args.push(options);
    }
  },
}));

// ── Mock plugin installers ───────────────────────────────────────────

const pluginInstallerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/mock/opencode/plugin.ts'),
  installClaudePlugin: vi.fn().mockReturnValue('/mock/claude/plugin'),
  installGeminiHook: vi.fn().mockReturnValue('/mock/gemini/hook.js'),
}));

vi.mock('../../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: pluginInstallerMocks.installOpencodePlugin,
}));

vi.mock('../../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: pluginInstallerMocks.installClaudePlugin,
}));

vi.mock('../../src/gemini/hook-installer.js', () => ({
  installGeminiHook: pluginInstallerMocks.installGeminiHook,
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { AgentBridge } from '../../src/index.js';
import type { IStateManager } from '../../src/types/interfaces.js';
import type { BridgeConfig, ProjectState, ProjectInstanceState } from '../../src/types/index.js';

// ── Mock factories ───────────────────────────────────────────────────

function createMockConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    discord: { token: 'test-token' },
    tmux: { sessionPrefix: 'agent-' },
    hookServerPort: 19999,
    ...overrides,
  };
}

function createMockStateManager(): IStateManager & { [k: string]: any } {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn().mockReturnValue('guild-123'),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn().mockReturnValue('workspace-123'),
    setWorkspaceId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function createMockMessaging() {
  return {
    platform: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    registerChannelMappings: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    getGuilds: vi.fn().mockReturnValue([]),
    getChannelMapping: vi.fn().mockReturnValue(new Map()),
    createAgentChannels: vi.fn().mockResolvedValue({ claude: 'ch-123' }),
    deleteChannel: vi.fn(),
    sendApprovalRequest: vi.fn(),
    sendQuestionWithButtons: vi.fn(),
    setTargetChannel: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
}

function createMockRuntime() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('agent-test'),
    createWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    startAgentInWindow: vi.fn(),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(false),
    listWindows: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

function createMockRegistry() {
  const mockAdapter = {
    config: { name: 'claude', displayName: 'Claude Code', command: 'claude', channelSuffix: 'claude' },
    getStartCommand: vi.fn().mockReturnValue('cd "/test" && claude'),
    matchesChannel: vi.fn(),
    isInstalled: vi.fn().mockReturnValue(true),
  };
  return {
    get: vi.fn().mockReturnValue(mockAdapter),
    getAll: vi.fn().mockReturnValue([mockAdapter]),
    register: vi.fn(),
    getByChannelSuffix: vi.fn(),
    parseChannelName: vi.fn(),
    _mockAdapter: mockAdapter,
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('container mode integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.isDockerAvailable.mockReturnValue(true);
    containerMocks.createContainer.mockReturnValue('abc123def456');
    containerMocks.buildDockerStartCommand.mockReturnValue('docker start -ai abc123def456');
    containerMocks.containerExists.mockReturnValue(true);
    syncInstanceMethods.start.mockClear();
    syncInstanceMethods.stop.mockClear();
    syncInstanceMethods.finalSync.mockClear();
    containerSyncCalls.args.length = 0;
  });

  describe('setupProject with container enabled', () => {
    it('creates a container instead of running agent command directly', async () => {
      const mockRuntime = createMockRuntime();
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      const result = await bridge.setupProject(
        'test-project',
        '/test/path',
        { claude: true },
      );

      // Should have created a container
      expect(containerMocks.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          containerName: 'discode-test-project-claude',
          projectPath: '/test/path',
          env: expect.objectContaining({
            AGENT_DISCORD_PROJECT: 'test-project',
            AGENT_DISCORD_HOSTNAME: 'host.docker.internal',
          }),
        }),
      );

      // Should have injected credentials
      expect(containerMocks.injectCredentials).toHaveBeenCalledWith(
        'abc123def456',
        undefined,
      );

      // Should start agent with docker start command
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        'docker start -ai abc123def456',
      );

      // Should start sync
      expect(containerSyncCalls.args).toEqual([
        expect.objectContaining({
          containerId: 'abc123def456',
          projectPath: '/test/path',
        }),
      ]);
      expect(syncInstanceMethods.start).toHaveBeenCalled();

      expect(result.channelId).toBe('ch-123');
    });

    it('saves container fields in project state', async () => {
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          instances: expect.objectContaining({
            claude: expect.objectContaining({
              containerMode: true,
              containerId: 'abc123def456',
              containerName: 'discode-test-project-claude',
            }),
          }),
        }),
      );
    });

    it('throws when Docker is not available', async () => {
      containerMocks.isDockerAvailable.mockReturnValue(false);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await expect(
        bridge.setupProject('test', '/test', { claude: true }),
      ).rejects.toThrow('Docker is not available');
    });

    it('passes custom socket path to container operations', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({
          container: { enabled: true, socketPath: '/custom/sock' },
        }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      expect(containerMocks.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: '/custom/sock',
        }),
      );
    });

    it('passes agent command to createContainer for execution inside container', async () => {
      const registry = createMockRegistry();
      // Simulate adapter returning a command using the given projectPath
      registry._mockAdapter.getStartCommand.mockImplementation(
        (path: string) => `cd "${path}" && claude --dangerously-skip-permissions`,
      );

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry,
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test/path', { claude: true });

      // Agent command should use WORKSPACE_DIR (/workspace) not the host projectPath
      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      expect(createArgs.command).toContain('/workspace');
      expect(createArgs.command).not.toContain('/test/path');
      // Adapter's getStartCommand should have been called with /workspace
      expect(registry._mockAdapter.getStartCommand).toHaveBeenCalledWith(
        '/workspace',
        expect.anything(),
      );
    });

    it('passes plugin volume mount to createContainer when plugin dir exists', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      // Should have volumes array with plugin mount (host:container:ro)
      expect(createArgs.volumes).toBeDefined();
      expect(Array.isArray(createArgs.volumes)).toBe(true);
      if (createArgs.volumes.length > 0) {
        expect(createArgs.volumes[0]).toContain('/home/coder/.claude/plugins/discode-claude-bridge:ro');
      }
    });

    it('includes plugin-dir in agent command when plugin is installed', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      // The command should include --plugin-dir pointing to the container plugin path
      if (createArgs.command) {
        expect(createArgs.command).toContain('--plugin-dir');
        expect(createArgs.command).toContain('/home/coder/.claude/plugins/discode-claude-bridge');
      }
    });

    it('skips runtime start when skipRuntimeStart is true', async () => {
      const mockRuntime = createMockRuntime();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true }, undefined, undefined, {
        skipRuntimeStart: true,
      });

      // Container should be created but not started
      expect(containerMocks.createContainer).toHaveBeenCalled();
      expect(containerMocks.injectCredentials).toHaveBeenCalled();
      expect(mockRuntime.startAgentInWindow).not.toHaveBeenCalled();
      // Sync should still start
      expect(syncInstanceMethods.start).toHaveBeenCalled();
    });
  });

  describe('setupProject without container', () => {
    it('does not create a container in standard mode', async () => {
      const mockRuntime = createMockRuntime();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      expect(containerMocks.createContainer).not.toHaveBeenCalled();
      expect(containerMocks.injectCredentials).not.toHaveBeenCalled();

      // Should use export prefix + agent command (standard mode)
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        expect.stringContaining('export AGENT_DISCORD_PROJECT='),
      );
    });

    it('does not save container fields in state', async () => {
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      const savedProject = mockStateManager.setProject.mock.calls[0][0];
      const instance = savedProject.instances.claude;
      expect(instance.containerMode).toBeUndefined();
      expect(instance.containerId).toBeUndefined();
    });
  });

  describe('stop cleans up container syncs', () => {
    it('stops all container syncs on bridge stop', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      // Create a project to start sync
      await bridge.setupProject('test', '/test', { claude: true });
      expect(syncInstanceMethods.start).toHaveBeenCalled();

      // Stop bridge
      await bridge.stop();

      expect(syncInstanceMethods.stop).toHaveBeenCalled();
    });
  });

  describe('restoreRuntimeWindows with container instances', () => {
    it('uses docker start command for container instances on restore', async () => {
      const mockRuntime = createMockRuntime();
      const mockStateManager = createMockStateManager();

      const existingProject: ProjectState = {
        projectName: 'test-project',
        projectPath: '/test',
        tmuxSession: 'agent-test',
        discordChannels: { claude: 'ch-123' },
        agents: { claude: true },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'test-project-claude',
            channelId: 'ch-123',
            containerMode: true,
            containerId: 'existing-container-id',
            containerName: 'discode-test-project-claude',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      mockStateManager.listProjects.mockReturnValue([existingProject]);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({
          runtimeMode: 'pty',
          container: { enabled: true },
        }),
      });

      await bridge.start();

      // Should have restored window with docker start command
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        'docker start -ai abc123def456',  // from buildDockerStartCommand mock
      );

      // Should have started sync for restored container
      expect(containerSyncCalls.args).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            containerId: 'existing-container-id',
            projectPath: '/test',
          }),
        ]),
      );

      await bridge.stop();
    });

    it('does not use container path for non-container instances on restore', async () => {
      const mockRuntime = createMockRuntime();
      const mockStateManager = createMockStateManager();

      const existingProject: ProjectState = {
        projectName: 'test-project',
        projectPath: '/test',
        tmuxSession: 'agent-test',
        discordChannels: { claude: 'ch-123' },
        agents: { claude: true },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'test-project-claude',
            channelId: 'ch-123',
            // No containerMode — standard mode instance
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      mockStateManager.listProjects.mockReturnValue([existingProject]);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ runtimeMode: 'pty' }),
      });

      await bridge.start();

      // Should use standard agent command, not docker start
      expect(containerMocks.buildDockerStartCommand).not.toHaveBeenCalled();
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        expect.stringContaining('export AGENT_DISCORD_PROJECT='),
      );

      // No container sync should have been started
      expect(containerSyncCalls.args).toHaveLength(0);

      await bridge.stop();
    });
  });
});
