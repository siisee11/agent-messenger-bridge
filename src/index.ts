/**
 * Main entry point for discord-agent-bridge
 */

import { DiscordClient } from './discord/client.js';
import { TmuxManager } from './tmux/manager.js';
import { stateManager as defaultStateManager } from './state/index.js';
import { config as defaultConfig } from './config/index.js';
import { agentRegistry as defaultAgentRegistry, AgentRegistry } from './agents/index.js';
import { CapturePoller } from './capture/index.js';
import { createServer } from 'http';
import { parse } from 'url';
import type { ProjectAgents } from './types/index.js';
import type { IStateManager } from './types/interfaces.js';
import type { BridgeConfig } from './types/index.js';

export interface AgentBridgeDeps {
  discord?: DiscordClient;
  tmux?: TmuxManager;
  stateManager?: IStateManager;
  registry?: AgentRegistry;
  config?: BridgeConfig;
}

export class AgentBridge {
  private discord: DiscordClient;
  private tmux: TmuxManager;
  private poller: CapturePoller;
  private httpServer?: ReturnType<typeof createServer>;
  private stateManager: IStateManager;
  private registry: AgentRegistry;
  private bridgeConfig: BridgeConfig;

  constructor(deps?: AgentBridgeDeps) {
    this.bridgeConfig = deps?.config || defaultConfig;
    this.discord = deps?.discord || new DiscordClient(this.bridgeConfig.discord.token);
    this.tmux = deps?.tmux || new TmuxManager('agent-');
    this.stateManager = deps?.stateManager || defaultStateManager;
    this.registry = deps?.registry || defaultAgentRegistry;
    this.poller = new CapturePoller(this.tmux, this.discord, 30000, this.stateManager);
  }

  /**
   * Sanitize Discord message input before passing to tmux
   */
  public sanitizeInput(content: string): string | null {
    // Reject empty/whitespace-only messages
    if (!content || content.trim().length === 0) {
      return null;
    }

    // Limit message length to prevent abuse
    if (content.length > 10000) {
      return null;
    }

    // Strip null bytes
    const sanitized = content.replace(/\0/g, '');

    return sanitized;
  }

  /**
   * Connect to Discord only (for init command)
   */
  async connect(): Promise<void> {
    await this.discord.connect();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Discord Agent Bridge...');

    // Connect to Discord
    await this.discord.connect();
    console.log('✅ Discord connected');

    // Load channel mappings from saved state
    const projects = this.stateManager.listProjects();
    const mappings: { channelId: string; projectName: string; agentType: string }[] = [];
    for (const project of projects) {
      for (const [agentType, channelId] of Object.entries(project.discordChannels)) {
        if (channelId) {
          mappings.push({ channelId, projectName: project.projectName, agentType });
        }
      }
    }
    if (mappings.length > 0) {
      this.discord.registerChannelMappings(mappings);
    }

    // Set up message routing (Discord → Agent via tmux)
    this.discord.onMessage(async (agentType, content, projectName, channelId) => {
      console.log(`📨 [${projectName}/${agentType}] ${content.substring(0, 50)}...`);

      const project = this.stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await this.discord.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      // Sanitize input
      const sanitized = this.sanitizeInput(content);
      if (!sanitized) {
        await this.discord.sendToChannel(channelId, `⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters`);
        return;
      }

      // Get agent adapter
      const adapter = this.registry.get(agentType);
      const agentDisplayName = adapter?.config.displayName || agentType;

      // Send confirmation to Discord
      const preview = sanitized.length > 100 ? sanitized.substring(0, 100) + '...' : sanitized;
      await this.discord.sendToChannel(channelId, `**${agentDisplayName}** - 📨 받은 메시지: \`${preview}\``);

      // Send to tmux
      this.tmux.sendKeysToWindow(project.tmuxSession, agentType, sanitized);
      this.stateManager.updateLastActive(projectName);
    });

    // Start HTTP server (minimal - just reload endpoint)
    this.startServer();

    // Start capture poller (Agent → Discord via tmux capture)
    this.poller.start();

    console.log('✅ Discord Agent Bridge is running');
    console.log(`📡 Server listening on port ${this.bridgeConfig.hookServerPort || 18470}`);
    console.log(`🤖 Registered agents: ${this.registry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  private startServer(): void {
    const port = this.bridgeConfig.hookServerPort || 18470;

    this.httpServer = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      const { pathname } = parse(req.url || '');

      // Consume body
      req.on('data', () => {});
      req.on('end', () => {
        try {
          // Route: /reload (re-read state and update channel mappings)
          if (pathname === '/reload') {
            this.reloadChannelMappings();
            res.writeHead(200);
            res.end('OK');
            return;
          }

          res.writeHead(404);
          res.end('Not found');
        } catch (error) {
          console.error('Request processing error:', error);
          res.writeHead(500);
          res.end('Internal error');
        }
      });
    });

    this.httpServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });

    this.httpServer.listen(port, '127.0.0.1');
  }

  private reloadChannelMappings(): void {
    this.stateManager.reload();
    const projects = this.stateManager.listProjects();
    const mappings: { channelId: string; projectName: string; agentType: string }[] = [];
    for (const project of projects) {
      for (const [agentType, channelId] of Object.entries(project.discordChannels)) {
        if (channelId) {
          mappings.push({ channelId, projectName: project.projectName, agentType });
        }
      }
    }
    if (mappings.length > 0) {
      this.discord.registerChannelMappings(mappings);
    }
    console.log(`🔄 Reloaded channel mappings (${mappings.length} channels)`);
  }

  async setupProject(
    projectName: string,
    projectPath: string,
    agents: ProjectAgents,
    channelDisplayName?: string,
    overridePort?: number,
    yolo = false
  ): Promise<{ channelName: string; channelId: string; agentName: string; tmuxSession: string }> {
    const guildId = this.stateManager.getGuildId();
    if (!guildId) {
      throw new Error('Server ID not configured. Run: agent-discord config --server <id>');
    }

    // Create tmux session
    const tmuxSession = this.tmux.getOrCreateSession(projectName);

    // Collect enabled agents (should be only one)
    const enabledAgents = this.registry.getAll().filter(a => agents[a.config.name]);
    const adapter = enabledAgents[0];

    if (!adapter) {
      throw new Error('No agent specified');
    }

    // Create Discord channel with custom name or default
    const channelName = channelDisplayName || `${projectName}-${adapter.config.channelSuffix}`;
    const channels = await this.discord.createAgentChannels(
      guildId,
      projectName,
      [adapter.config],
      channelName
    );

    const channelId = channels[adapter.config.name];

    // Set environment variables on the tmux session
    const port = overridePort || this.bridgeConfig.hookServerPort || 18470;
    this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PROJECT', projectName);
    this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PORT', String(port));
    if (yolo) {
      this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_YOLO', '1');
    }

    // Start agent in tmux window
    const discordChannels: { [key: string]: string | undefined } = {
      [adapter.config.name]: channelId,
    };

    this.tmux.startAgentInWindow(
      tmuxSession,
      adapter.config.name,
      adapter.getStartCommand(projectPath, yolo)
    );

    // Save state
    const projectState = {
      projectName,
      projectPath,
      tmuxSession,
      discordChannels,
      agents,
      createdAt: new Date(),
      lastActive: new Date(),
    };
    this.stateManager.setProject(projectState);

    return {
      channelName,
      channelId,
      agentName: adapter.config.displayName,
      tmuxSession,
    };
  }

  async stop(): Promise<void> {
    this.poller.stop();
    this.httpServer?.close();
    await this.discord.disconnect();
  }
}

export async function main() {
  const bridge = new AgentBridge();

  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    try {
      await bridge.stop();
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
    process.exit(0);
  });

  await bridge.start();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
