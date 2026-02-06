/**
 * Main entry point for discord-agent-bridge
 */

import { DiscordClient } from './discord/client.js';
import { TmuxManager } from './tmux/manager.js';
import { stateManager } from './state/index.js';
import { config } from './config/index.js';
import { agentRegistry } from './agents/index.js';
import { CapturePoller } from './capture/index.js';
import { createServer } from 'http';
import { parse } from 'url';
import type { ProjectAgents } from './types/index.js';

export class AgentBridge {
  private discord: DiscordClient;
  private tmux: TmuxManager;
  private poller: CapturePoller;
  private httpServer?: ReturnType<typeof createServer>;

  constructor() {
    this.discord = new DiscordClient(config.discord.token);
    this.tmux = new TmuxManager('agent-');
    this.poller = new CapturePoller(this.tmux, this.discord);
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
    const projects = stateManager.listProjects();
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

      const project = stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await this.discord.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      // Get agent adapter
      const adapter = agentRegistry.get(agentType);
      const agentDisplayName = adapter?.config.displayName || agentType;

      // Send confirmation to Discord
      const preview = content.length > 100 ? content.substring(0, 100) + '...' : content;
      await this.discord.sendToChannel(channelId, `**${agentDisplayName}** - 📨 받은 메시지: \`${preview}\``);

      // Send to tmux
      this.tmux.sendKeysToWindow(project.tmuxSession, agentType, content);
      stateManager.updateLastActive(projectName);
    });

    // Start HTTP server (minimal - just reload endpoint)
    this.startServer();

    // Start capture poller (Agent → Discord via tmux capture)
    this.poller.start();

    console.log('✅ Discord Agent Bridge is running');
    console.log(`📡 Server listening on port ${config.hookServerPort || 18470}`);
    console.log(`🤖 Registered agents: ${agentRegistry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  private startServer(): void {
    const port = config.hookServerPort || 18470;

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

    this.httpServer.listen(port, '127.0.0.1');
  }

  private reloadChannelMappings(): void {
    stateManager.reload();
    const projects = stateManager.listProjects();
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
    const guildId = stateManager.getGuildId();
    if (!guildId) {
      throw new Error('Server ID not configured. Run: agent-discord config --server <id>');
    }

    // Create tmux session
    const tmuxSession = this.tmux.getOrCreateSession(projectName);

    // Collect enabled agents (should be only one)
    const enabledAgents = agentRegistry.getAll().filter(a => agents[a.config.name]);
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
    const port = overridePort || config.hookServerPort || 18470;
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
    stateManager.setProject(projectState);

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
    await bridge.stop();
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
