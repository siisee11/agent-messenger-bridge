/**
 * Tests for AgentBridge main class
 */

import { AgentBridge } from '../src/index.js';
import type { IStateManager } from '../src/types/interfaces.js';
import type { BridgeConfig, ProjectState } from '../src/types/index.js';

// Mock helpers
function createMockConfig(): BridgeConfig {
  return {
    discord: { token: 'test-token' },
    tmux: { sessionPrefix: 'agent-' },
    hookServerPort: 19999,
  };
}

function createMockStateManager(): IStateManager {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn().mockReturnValue('guild-123'),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function createMockDiscord() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    registerChannelMappings: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
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

function createMockTmux() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('agent-test'),
    createWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    capturePaneFromWindow: vi.fn(),
    startAgentInWindow: vi.fn(),
    setSessionEnv: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    sendKeys: vi.fn(),
    capturePane: vi.fn(),
    sessionExists: vi.fn(),
    listWindows: vi.fn(),
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

describe('AgentBridge', () => {
  describe('sanitizeInput', () => {
    it('returns null for empty string', () => {
      const bridge = new AgentBridge({
        discord: createMockDiscord(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge.sanitizeInput('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      const bridge = new AgentBridge({
        discord: createMockDiscord(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge.sanitizeInput('   \t\n  ')).toBeNull();
    });

    it('returns null for string > 10000 chars', () => {
      const bridge = new AgentBridge({
        discord: createMockDiscord(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const longString = 'a'.repeat(10001);
      expect(bridge.sanitizeInput(longString)).toBeNull();
    });

    it('strips null bytes', () => {
      const bridge = new AgentBridge({
        discord: createMockDiscord(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const input = 'hello\0world\0test';
      expect(bridge.sanitizeInput(input)).toBe('helloworldtest');
    });

    it('returns valid content unchanged', () => {
      const bridge = new AgentBridge({
        discord: createMockDiscord(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const validContent = 'This is valid content with unicode 한글 emojis 🚀';
      expect(bridge.sanitizeInput(validContent)).toBe(validContent);
    });
  });

  describe('constructor', () => {
    it('creates with all dependencies injected', () => {
      const mockDiscord = createMockDiscord();
      const mockTmux = createMockTmux();
      const mockStateManager = createMockStateManager();
      const mockRegistry = createMockRegistry();
      const mockConfig = createMockConfig();

      const bridge = new AgentBridge({
        discord: mockDiscord,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: mockConfig,
      });

      expect(bridge).toBeInstanceOf(AgentBridge);
    });

    it('creates with mocked dependencies', () => {
      // Just verify the class is constructable with mocked deps
      const bridge = new AgentBridge({
        discord: createMockDiscord(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge).toBeInstanceOf(AgentBridge);
      expect(typeof bridge.sanitizeInput).toBe('function');
    });
  });

  describe('start', () => {
    let bridge: AgentBridge;
    let mockDiscord: any;
    let mockStateManager: any;

    beforeEach(() => {
      mockDiscord = createMockDiscord();
      mockStateManager = createMockStateManager();
      bridge = new AgentBridge({
        discord: mockDiscord,
        tmux: createMockTmux(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });
    });

    afterEach(async () => {
      await bridge.stop();
    });

    it('connects discord and registers channel mappings from state', async () => {
      const projects: ProjectState[] = [
        {
          projectName: 'test-project',
          projectPath: '/test',
          tmuxSession: 'agent-test',
          discordChannels: { claude: 'ch-123', cursor: 'ch-456' },
          agents: { claude: true },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      ];
      mockStateManager.listProjects.mockReturnValue(projects);

      await bridge.start();

      expect(mockDiscord.connect).toHaveBeenCalledOnce();
      expect(mockDiscord.registerChannelMappings).toHaveBeenCalledWith([
        { channelId: 'ch-123', projectName: 'test-project', agentType: 'claude' },
        { channelId: 'ch-456', projectName: 'test-project', agentType: 'cursor' },
      ]);
    });

    it('sets up message callback via discord.onMessage', async () => {
      await bridge.start();

      expect(mockDiscord.onMessage).toHaveBeenCalledOnce();
      expect(mockDiscord.onMessage).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('setupProject', () => {
    let bridge: AgentBridge;
    let mockDiscord: any;
    let mockTmux: any;
    let mockStateManager: any;
    let mockRegistry: any;

    beforeEach(() => {
      mockDiscord = createMockDiscord();
      mockTmux = createMockTmux();
      mockStateManager = createMockStateManager();
      mockRegistry = createMockRegistry();
      bridge = new AgentBridge({
        discord: mockDiscord,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: createMockConfig(),
      });
    });

    it('creates tmux session, discord channel, saves state', async () => {
      const result = await bridge.setupProject(
        'test-project',
        '/test/path',
        { claude: true }
      );

      expect(mockTmux.getOrCreateSession).toHaveBeenCalledWith('test-project');
      expect(mockDiscord.createAgentChannels).toHaveBeenCalledWith(
        'guild-123',
        'test-project',
        [mockRegistry._mockAdapter.config],
        'test-project-claude'
      );
      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test-project',
          projectPath: '/test/path',
          tmuxSession: 'agent-test',
        })
      );
      expect(result).toEqual({
        channelName: 'test-project-claude',
        channelId: 'ch-123',
        agentName: 'Claude Code',
        tmuxSession: 'agent-test',
      });
    });

    it('throws when no guild ID configured', async () => {
      mockStateManager.getGuildId.mockReturnValue(undefined);

      await expect(
        bridge.setupProject('test-project', '/test/path', { claude: true })
      ).rejects.toThrow('Server ID not configured');
    });

    it('throws when no agent specified', async () => {
      mockRegistry.getAll.mockReturnValue([]);

      await expect(
        bridge.setupProject('test-project', '/test/path', {})
      ).rejects.toThrow('No agent specified');
    });
  });

  describe('stop', () => {
    it('stops poller and disconnects discord', async () => {
      const mockDiscord = createMockDiscord();
      const bridge = new AgentBridge({
        discord: mockDiscord,
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      // Start first to create HTTP server
      await bridge.start();

      // Now stop
      await bridge.stop();

      expect(mockDiscord.disconnect).toHaveBeenCalledOnce();
    });
  });
});
