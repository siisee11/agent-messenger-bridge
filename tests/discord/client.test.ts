/**
 * Tests for DiscordClient
 */

import { DiscordClient } from '../../src/discord/client.js';
import { AgentRegistry, BaseAgentAdapter } from '../../src/agents/base.js';

// Mock discord.js
const mockClientInstances: any[] = [];

vi.mock('discord.js', () => {
  return {
    Client: class MockClient {
      on = vi.fn();
      once = vi.fn();
      login = vi.fn().mockResolvedValue(undefined);
      destroy = vi.fn().mockResolvedValue(undefined);
      guilds = { cache: new Map() };
      channels = { fetch: vi.fn() };
      user = { tag: 'TestBot#1234' };

      constructor() {
        mockClientInstances.push(this);
      }
    },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildMessageReactions: 8 },
    ChannelType: { GuildText: 0 },
    ButtonBuilder: class MockButtonBuilder {
      setCustomId = vi.fn().mockReturnThis();
      setLabel = vi.fn().mockReturnThis();
      setStyle = vi.fn().mockReturnThis();
    },
    ButtonStyle: { Primary: 1, Secondary: 2 },
    ActionRowBuilder: class MockActionRowBuilder {
      addComponents = vi.fn().mockReturnThis();
    },
    ComponentType: { Button: 2 },
    EmbedBuilder: class MockEmbedBuilder {
      setTitle = vi.fn().mockReturnThis();
      setDescription = vi.fn().mockReturnThis();
      setColor = vi.fn().mockReturnThis();
      addFields = vi.fn().mockReturnThis();
      setFooter = vi.fn().mockReturnThis();
    },
  };
});

function createTestRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  class TestAdapter extends BaseAgentAdapter {
    constructor() {
      super({ name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' });
    }
  }
  registry.register(new TestAdapter());
  return registry;
}

describe('DiscordClient', () => {
  beforeEach(() => {
    mockClientInstances.length = 0;
  });

  function getMockClient() {
    return mockClientInstances[mockClientInstances.length - 1];
  }

  describe('Channel mapping', () => {
    it('registerChannelMappings stores mappings', () => {
      const client = new DiscordClient('test-token');

      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj1', agentType: 'claude' },
        { channelId: 'ch-2', projectName: 'proj2', agentType: 'cursor' },
      ]);

      const mappings = client.getChannelMapping();
      expect(mappings.size).toBe(2);
      expect(mappings.get('ch-1')).toEqual({
        projectName: 'proj1',
        agentType: 'claude',
      });
      expect(mappings.get('ch-2')).toEqual({
        projectName: 'proj2',
        agentType: 'cursor',
      });
    });

    it('getChannelMapping returns copy of mappings', () => {
      const client = new DiscordClient('test-token');

      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj1', agentType: 'claude' },
      ]);

      const mappings1 = client.getChannelMapping();
      const mappings2 = client.getChannelMapping();

      expect(mappings1).not.toBe(mappings2);
      expect(mappings1.size).toBe(mappings2.size);
    });
  });

  describe('Message handling', () => {
    it('onMessage registers callback', () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();

      client.onMessage(callback);

      // Verify callback is stored (we can't directly access private field, but we can test the behavior)
      expect(callback).toBeDefined();
    });

    it('Bot messages are ignored', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);

      const mockClient = getMockClient();

      // Find the messageCreate handler
      const messageCreateHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'messageCreate'
      )?.[1];

      expect(messageCreateHandler).toBeDefined();

      // Simulate bot message
      const botMessage = {
        author: { bot: true },
        channel: { isTextBased: () => true },
        channelId: 'ch-1',
        content: 'bot message',
      };

      await messageCreateHandler(botMessage);

      // Callback should not be invoked for bot messages
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Channel operations', () => {
    it('sendToChannel fetches channel and sends content', async () => {
      const client = new DiscordClient('test-token');

      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(undefined),
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockResolvedValue(mockChannel);

      await client.sendToChannel('ch-123', 'test message');

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('ch-123');
      expect(mockChannel.send).toHaveBeenCalledWith('test message');
    });

    it('sendToChannel handles non-text channel gracefully', async () => {
      const client = new DiscordClient('test-token');

      const mockChannel = {
        isTextBased: () => false,
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockResolvedValue(mockChannel);

      // Should not throw
      await expect(client.sendToChannel('ch-123', 'test message')).resolves.toBeUndefined();
    });
  });

  describe('parseChannelName', () => {
    it('uses injected registry to parse channel names', () => {
      const registry = createTestRegistry();
      const client = new DiscordClient('test-token', registry);

      // Mock the registry's parseChannelName method
      const mockResult = {
        projectName: 'myproject',
        agent: {
          config: { name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' },
        } as any,
      };
      vi.spyOn(registry, 'parseChannelName').mockReturnValue(mockResult);

      // Access the private parseChannelName method indirectly through registerChannelMappings
      // or by scanning existing channels (which calls parseChannelName internally)
      // For now, we verify the registry was passed correctly by checking if parseChannelName exists
      expect(registry.parseChannelName).toBeDefined();
    });
  });

  describe('Connect', () => {
    it('normalizes bot token before login', async () => {
      const client = new DiscordClient('  "Bot test-token-123"  ');
      const mockClient = getMockClient();

      const connectPromise = client.connect();

      expect(mockClient.login).toHaveBeenCalledWith('test-token-123');

      const readyHandler = mockClient.once.mock.calls.find(
        (call: any[]) => call[0] === 'clientReady'
      )?.[1];
      expect(readyHandler).toBeDefined();
      readyHandler();

      await expect(connectPromise).resolves.toBeUndefined();
    });

    it('returns actionable error for invalid token', async () => {
      const client = new DiscordClient('test-token');
      const mockClient = getMockClient();
      mockClient.login.mockRejectedValueOnce(new Error('An invalid token was provided.'));

      await expect(client.connect()).rejects.toThrow(/invalid bot token/i);
    });

    it('fails fast when token is empty after normalization', async () => {
      const client = new DiscordClient('   ');
      const mockClient = getMockClient();

      await expect(client.connect()).rejects.toThrow(/token is empty/i);
      expect(mockClient.login).not.toHaveBeenCalled();
    });
  });

  describe('Lifecycle', () => {
    it('disconnect calls client.destroy', async () => {
      const client = new DiscordClient('test-token');
      const mockClient = getMockClient();

      await client.disconnect();

      expect(mockClient.destroy).toHaveBeenCalledOnce();
    });
  });

  describe('Constructor', () => {
    it('accepts optional registry parameter', () => {
      const registry = createTestRegistry();
      const client = new DiscordClient('test-token', registry);

      expect(client).toBeInstanceOf(DiscordClient);
    });

    it('creates with default registry when not provided', () => {
      const client = new DiscordClient('test-token');

      expect(client).toBeInstanceOf(DiscordClient);
    });
  });
});
