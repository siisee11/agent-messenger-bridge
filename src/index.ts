/**
 * Main entry point for discord-agent-bridge
 */

import { DiscordClient } from './discord/client.js';
import { TmuxManager } from './tmux/manager.js';
import { stateManager } from './state/index.js';
import { config } from './config/index.js';
import { agentRegistry } from './agents/index.js';
import { createServer } from 'http';
import { parse } from 'url';
import type { ProjectAgents } from './types/index.js';

export class AgentBridge {
  private discord: DiscordClient;
  private tmux: TmuxManager;
  private httpServer?: ReturnType<typeof createServer>;

  constructor() {
    this.discord = new DiscordClient(config.discord.token);
    this.tmux = new TmuxManager('agent-');
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

    // Set up message routing
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

    // Start HTTP server for receiving hook outputs
    this.startHookServer();

    console.log('✅ Discord Agent Bridge is running');
    console.log(`📡 Hook server listening on port ${config.hookServerPort || 3847}`);
    console.log(`🤖 Registered agents: ${agentRegistry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  private startHookServer(): void {
    const port = config.hookServerPort || 3847;

    // Build regex pattern from registered agents
    const agentNames = agentRegistry.getAll().map(a => a.config.hookEndpoint).join('|');
    const hookPattern = new RegExp(`^/hook/([^/]+)/(${agentNames})$`);

    const approvePattern = new RegExp(`^/approve/([^/]+)/(${agentNames})$`);
    const notifyPattern = new RegExp(`^/notify/([^/]+)/(${agentNames})$`);

    this.httpServer = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      const { pathname } = parse(req.url || '');

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);

          // Route: /notify/{projectName}/{agentType} (fire-and-forget notification)
          const notifyMatch = pathname?.match(notifyPattern);
          if (notifyMatch) {
            const [, projectName, agentType] = notifyMatch;
            await this.handleNotify(projectName, agentType, data);
            res.writeHead(200);
            res.end('OK');
            return;
          }

          // Route: /approve/{projectName}/{agentType}
          const approveMatch = pathname?.match(approvePattern);
          if (approveMatch) {
            const [, projectName, agentType] = approveMatch;
            const approved = await this.handleApprovalRequest(projectName, agentType, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ approved }));
            return;
          }

          // Route: /hook/{projectName}/{agentType}
          const hookMatch = pathname?.match(hookPattern);
          if (hookMatch) {
            const [, projectName, agentType] = hookMatch;
            await this.handleHookOutput(projectName, agentType, data);
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

  private async handleHookOutput(
    projectName: string,
    agentType: string,
    hookData: any
  ): Promise<void> {
    const project = stateManager.getProject(projectName);
    if (!project) return;

    const channelId = project.discordChannels[agentType];
    if (!channelId) return;

    // Get adapter and format output
    const adapter = agentRegistry.get(agentType);
    const message = adapter
      ? adapter.formatHookOutput(hookData)
      : this.formatGenericHookOutput(hookData, agentType);

    await this.discord.sendToChannel(channelId, message);
  }

  private async handleNotify(
    projectName: string,
    agentType: string,
    data: any
  ): Promise<void> {
    const project = stateManager.getProject(projectName);
    if (!project) return;

    const channelId = project.discordChannels[agentType];
    if (!channelId) return;

    const message = data.message || '';
    if (message) {
      console.log(`📢 [${projectName}/${agentType}] Notification sent`);
      await this.discord.sendToChannel(channelId, message);
    }
  }

  private async handleApprovalRequest(
    projectName: string,
    agentType: string,
    data: any
  ): Promise<boolean> {
    const project = stateManager.getProject(projectName);
    if (!project) {
      console.warn(`Approval request for unknown project: ${projectName}, auto-approving`);
      return true;
    }

    const channelId = project.discordChannels[agentType];
    if (!channelId) {
      console.warn(`No channel for ${agentType} in ${projectName}, auto-approving`);
      return true;
    }

    const toolName = data.tool_name || data.toolName || 'unknown';
    const toolInput = data.tool_input || data.input || '';

    console.log(`🔒 [${projectName}/${agentType}] Approval request for: ${toolName}`);

    const approved = await this.discord.sendApprovalRequest(channelId, toolName, toolInput);

    console.log(`🔒 [${projectName}/${agentType}] ${toolName}: ${approved ? 'APPROVED' : 'DENIED'}`);

    return approved;
  }

  private formatGenericHookOutput(hookData: any, agentType: string): string {
    const toolName = hookData.tool_name || hookData.toolName || 'unknown';
    let output = hookData.tool_response || hookData.output || '';

    if (typeof output === 'object') {
      output = JSON.stringify(output, null, 2);
    }

    const maxLength = 1900;
    const truncatedOutput = output.length > maxLength
      ? output.substring(0, maxLength) + '\n... (truncated)'
      : output;

    return `🔧 **${toolName}** (${agentType})\n\`\`\`\n${truncatedOutput}\n\`\`\``;
  }

  async setupProject(
    projectName: string,
    projectPath: string,
    agents: ProjectAgents,
    channelDisplayName?: string
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

    // Set environment variables on the tmux session so agent hooks can find the bridge
    const port = config.hookServerPort || 3847;
    this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PROJECT', projectName);
    this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PORT', String(port));

    // Start agent in tmux window
    const discordChannels: { [key: string]: string | undefined } = {
      [adapter.config.name]: channelId,
    };

    this.tmux.startAgentInWindow(
      tmuxSession,
      adapter.config.name,
      adapter.getStartCommand(projectPath)
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
