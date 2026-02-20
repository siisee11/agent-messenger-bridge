/**
 * Unit tests for BridgeProjectBootstrap.
 *
 * Tests the daemon-boot orchestration that installs agent integrations,
 * file instructions, send scripts, and registers channel mappings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockInstallAgentIntegration = vi.fn().mockReturnValue({
  infoMessages: [],
  warningMessages: [],
  eventHookInstalled: false,
});
const mockInstallFileInstruction = vi.fn();
const mockInstallDiscodeSendScript = vi.fn();

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: (...args: any[]) => mockInstallAgentIntegration(...args),
}));

vi.mock('../../src/infra/file-instruction.js', () => ({
  installFileInstruction: (...args: any[]) => mockInstallFileInstruction(...args),
}));

vi.mock('../../src/infra/send-script.js', () => ({
  installDiscodeSendScript: (...args: any[]) => mockInstallDiscodeSendScript(...args),
}));

// ── Imports ──────────────────────────────────────────────────────────

import { BridgeProjectBootstrap } from '../../src/bridge/project-bootstrap.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createMockStateManager(projects: any[] = []) {
  return {
    listProjects: vi.fn().mockReturnValue(projects),
    setProject: vi.fn(),
    reload: vi.fn(),
    getProject: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  } as any;
}

function createMockMessaging() {
  return {
    platform: 'discord',
    registerChannelMappings: vi.fn(),
    onMessage: vi.fn(),
    sendToChannel: vi.fn(),
  } as any;
}

function createClaudeProject() {
  return {
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    tmuxSession: 'bridge',
    agents: { claude: true },
    discordChannels: { claude: 'ch-claude' },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        channelId: 'ch-claude',
        tmuxWindow: 'myapp-claude',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };
}

function createOpencodeContainerProject() {
  return {
    projectName: 'discode',
    projectPath: '/Users/gui/discode',
    tmuxSession: 'bridge',
    agents: { opencode: true },
    discordChannels: { opencode: 'ch-opencode' },
    instances: {
      opencode: {
        instanceId: 'opencode',
        agentType: 'opencode',
        tmuxWindow: 'discode-opencode',
        channelId: 'ch-opencode',
        eventHook: true,
        containerMode: true,
        containerId: 'e69378dfe934',
        containerName: 'discode-discode-opencode',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };
}

function createMultiAgentProject() {
  return {
    projectName: 'multi',
    projectPath: '/home/user/multi',
    tmuxSession: 'bridge',
    agents: { claude: true, gemini: true },
    discordChannels: { claude: 'ch-claude', gemini: 'ch-gemini' },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        channelId: 'ch-claude',
        tmuxWindow: 'multi-claude',
      },
      gemini: {
        instanceId: 'gemini',
        agentType: 'gemini',
        channelId: 'ch-gemini',
        tmuxWindow: 'multi-gemini',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('BridgeProjectBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstallAgentIntegration.mockReset();
    mockInstallAgentIntegration.mockReturnValue({
      infoMessages: [],
      warningMessages: [],
      eventHookInstalled: false,
    });
  });

  describe('bootstrapProjects', () => {
    it('installs agent integration for each recognized agent type', () => {
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging, 18470);

      bootstrap.bootstrapProjects();

      expect(mockInstallAgentIntegration).toHaveBeenCalledWith(
        'claude',
        '/home/user/myapp',
        'install',
      );
    });

    it('installs integration for multiple agent types', () => {
      const stateManager = createMockStateManager([createMultiAgentProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging, 18470);

      bootstrap.bootstrapProjects();

      expect(mockInstallAgentIntegration).toHaveBeenCalledWith('claude', '/home/user/multi', 'install');
      expect(mockInstallAgentIntegration).toHaveBeenCalledWith('gemini', '/home/user/multi', 'install');
    });

    it('installs file instruction for each agent type', () => {
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(mockInstallFileInstruction).toHaveBeenCalledWith('/home/user/myapp', 'claude');
    });

    it('installs send script with project name and port', () => {
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging, 19000);

      bootstrap.bootstrapProjects();

      expect(mockInstallDiscodeSendScript).toHaveBeenCalledWith(
        '/home/user/myapp',
        { projectName: 'myapp', port: 19000 },
      );
    });

    it('registers channel mappings with instanceId', () => {
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(messaging.registerChannelMappings).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            channelId: 'ch-claude',
            projectName: 'myapp',
            agentType: 'claude',
            instanceId: 'claude',
          }),
        ]),
      );
    });

    it('registers mappings for multi-agent project', () => {
      const stateManager = createMockStateManager([createMultiAgentProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      const mappings = messaging.registerChannelMappings.mock.calls[0][0];
      expect(mappings).toHaveLength(2);
      expect(mappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channelId: 'ch-claude', agentType: 'claude' }),
          expect.objectContaining({ channelId: 'ch-gemini', agentType: 'gemini' }),
        ]),
      );
    });

    it('updates eventHook flag when integration reports it installed', () => {
      mockInstallAgentIntegration.mockReturnValue({
        infoMessages: [],
        warningMessages: [],
        eventHookInstalled: true,
      });
      const project = createClaudeProject();
      const stateManager = createMockStateManager([project]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(stateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          instances: expect.objectContaining({
            claude: expect.objectContaining({ eventHook: true }),
          }),
        }),
      );
    });

    it('does not save state when eventHook flag is unchanged', () => {
      mockInstallAgentIntegration.mockReturnValue({
        infoMessages: [],
        warningMessages: [],
        eventHookInstalled: false,
      });
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(stateManager.setProject).not.toHaveBeenCalled();
    });

    it('skips integration for projects with unrecognized agents', () => {
      const project = {
        projectName: 'custom',
        projectPath: '/test/custom',
        tmuxSession: 'bridge',
        agents: { myCustomAgent: true },
        discordChannels: { myCustomAgent: 'ch-custom' },
        instances: {
          myCustomAgent: {
            instanceId: 'myCustomAgent',
            agentType: 'myCustomAgent',
            channelId: 'ch-custom',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      const stateManager = createMockStateManager([project]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(mockInstallAgentIntegration).not.toHaveBeenCalled();
      expect(mockInstallFileInstruction).not.toHaveBeenCalled();
      expect(mockInstallDiscodeSendScript).not.toHaveBeenCalled();
    });

    it('handles installFileInstruction failure gracefully', () => {
      mockInstallFileInstruction.mockImplementation(() => { throw new Error('permission denied'); });
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      // Should not throw
      expect(() => bootstrap.bootstrapProjects()).not.toThrow();
      // Integration and send script still installed
      expect(mockInstallAgentIntegration).toHaveBeenCalled();
      expect(mockInstallDiscodeSendScript).toHaveBeenCalled();
    });

    it('handles installDiscodeSendScript failure gracefully', () => {
      mockInstallDiscodeSendScript.mockImplementation(() => { throw new Error('write failed'); });
      const stateManager = createMockStateManager([createClaudeProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      expect(() => bootstrap.bootstrapProjects()).not.toThrow();
    });

    it('registers channel mapping for opencode container instance', () => {
      const stateManager = createMockStateManager([createOpencodeContainerProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(messaging.registerChannelMappings).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            channelId: 'ch-opencode',
            projectName: 'discode',
            agentType: 'opencode',
            instanceId: 'opencode',
          }),
        ]),
      );
    });

    it('installs opencode integration for container project', () => {
      const stateManager = createMockStateManager([createOpencodeContainerProject()]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging, 18470);

      bootstrap.bootstrapProjects();

      expect(mockInstallAgentIntegration).toHaveBeenCalledWith(
        'opencode',
        '/Users/gui/discode',
        'install',
      );
    });

    it('does not register mappings for empty project list', () => {
      const stateManager = createMockStateManager([]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.bootstrapProjects();

      expect(messaging.registerChannelMappings).not.toHaveBeenCalled();
    });
  });

  describe('reloadChannelMappings', () => {
    it('reloads state and re-registers channel mappings', () => {
      const project = createClaudeProject();
      const stateManager = createMockStateManager([project]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.reloadChannelMappings();

      expect(stateManager.reload).toHaveBeenCalled();
      expect(messaging.registerChannelMappings).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            channelId: 'ch-claude',
            projectName: 'myapp',
          }),
        ]),
      );
    });

    it('reloads channel mappings for opencode container instance', () => {
      const project = createOpencodeContainerProject();
      const stateManager = createMockStateManager([project]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.reloadChannelMappings();

      expect(stateManager.reload).toHaveBeenCalled();
      expect(messaging.registerChannelMappings).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            channelId: 'ch-opencode',
            projectName: 'discode',
            agentType: 'opencode',
            instanceId: 'opencode',
          }),
        ]),
      );
    });

    it('handles empty projects after reload', () => {
      const stateManager = createMockStateManager([]);
      const messaging = createMockMessaging();
      const bootstrap = new BridgeProjectBootstrap(stateManager, messaging);

      bootstrap.reloadChannelMappings();

      expect(stateManager.reload).toHaveBeenCalled();
      expect(messaging.registerChannelMappings).not.toHaveBeenCalled();
    });
  });
});
