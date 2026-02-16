/**
 * Main entry point for discode
 */

import { DiscordClient } from './discord/client.js';
import { TmuxManager } from './tmux/manager.js';
import { stateManager as defaultStateManager } from './state/index.js';
import { config as defaultConfig } from './config/index.js';
import { agentRegistry as defaultAgentRegistry, AgentRegistry } from './agents/index.js';
import { CapturePoller } from './capture/index.js';
import { CodexSubmitter } from './codex/submitter.js';
import { installOpencodePlugin } from './opencode/plugin-installer.js';
import { installClaudePlugin } from './claude/plugin-installer.js';
import { installGeminiHook } from './gemini/hook-installer.js';
import { installCodexHook } from './codex/plugin-installer.js';
import type { ProjectAgents } from './types/index.js';
import type { IStateManager } from './types/interfaces.js';
import type { BridgeConfig } from './types/index.js';
import { escapeShellArg } from './infra/shell-escape.js';
import {
  buildNextInstanceId,
  getProjectInstance,
  normalizeProjectState,
} from './state/instances.js';
import { installFileInstruction } from './infra/file-instruction.js';
import { PendingMessageTracker } from './bridge/pending-message-tracker.js';
import { BridgeProjectBootstrap } from './bridge/project-bootstrap.js';
import { BridgeMessageRouter } from './bridge/message-router.js';
import { BridgeHookServer } from './bridge/hook-server.js';

export interface AgentBridgeDeps {
  discord?: DiscordClient;
  tmux?: TmuxManager;
  codexSubmitter?: CodexSubmitter;
  stateManager?: IStateManager;
  registry?: AgentRegistry;
  config?: BridgeConfig;
}

export class AgentBridge {
  private discord: DiscordClient;
  private tmux: TmuxManager;
  private codexSubmitter: CodexSubmitter;
  private poller: CapturePoller;
  private pendingTracker: PendingMessageTracker;
  private projectBootstrap: BridgeProjectBootstrap;
  private messageRouter: BridgeMessageRouter;
  private hookServer: BridgeHookServer;
  private stateManager: IStateManager;
  private registry: AgentRegistry;
  private bridgeConfig: BridgeConfig;

  constructor(deps?: AgentBridgeDeps) {
    this.bridgeConfig = deps?.config || defaultConfig;
    this.discord = deps?.discord || new DiscordClient(this.bridgeConfig.discord.token);
    this.tmux = deps?.tmux || new TmuxManager(this.bridgeConfig.tmux.sessionPrefix);
    this.stateManager = deps?.stateManager || defaultStateManager;
    this.registry = deps?.registry || defaultAgentRegistry;
    this.codexSubmitter = deps?.codexSubmitter || new CodexSubmitter(this.tmux);
    this.pendingTracker = new PendingMessageTracker(this.discord);
    this.projectBootstrap = new BridgeProjectBootstrap(this.stateManager, this.discord);
    this.messageRouter = new BridgeMessageRouter({
      discord: this.discord,
      tmux: this.tmux,
      codexSubmitter: this.codexSubmitter,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      sanitizeInput: (content) => this.sanitizeInput(content),
    });
    this.hookServer = new BridgeHookServer({
      port: this.bridgeConfig.hookServerPort || 18470,
      discord: this.discord,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      reloadChannelMappings: () => this.projectBootstrap.reloadChannelMappings(),
    });
    this.poller = new CapturePoller(this.tmux, this.discord, 30000, this.stateManager, {
      onAgentComplete: async (projectName, agentType, instanceId) => {
        await this.markAgentMessageCompleted(projectName, agentType, instanceId);
      },
      onAgentStopped: async (projectName, agentType, instanceId) => {
        await this.markAgentMessageError(projectName, agentType, instanceId);
      },
    });
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
    console.log('🚀 Starting Discode...');

    await this.discord.connect();
    console.log('✅ Discord connected');

    this.projectBootstrap.bootstrapProjects();
    this.messageRouter.register();
    this.hookServer.start();
    this.poller.start();

    console.log('✅ Discode is running');
    console.log(`📡 Server listening on port ${this.bridgeConfig.hookServerPort || 18470}`);
    console.log(`🤖 Registered agents: ${this.registry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  async setupProject(
    projectName: string,
    projectPath: string,
    agents: ProjectAgents,
    channelDisplayName?: string,
    overridePort?: number,
    options?: { instanceId?: string },
  ): Promise<{ channelName: string; channelId: string; agentName: string; tmuxSession: string }> {
    const guildId = this.stateManager.getGuildId();
    if (!guildId) {
      throw new Error('Server ID not configured. Run: discode config --server <id>');
    }

    // Collect enabled agents (should be only one)
    const enabledAgents = this.registry.getAll().filter(a => agents[a.config.name]);
    const adapter = enabledAgents[0];

    if (!adapter) {
      throw new Error('No agent specified');
    }

    const existingProject = this.stateManager.getProject(projectName);
    const normalizedExisting = existingProject ? normalizeProjectState(existingProject) : undefined;

    const requestedInstanceId = options?.instanceId?.trim();
    const instanceId = requestedInstanceId || buildNextInstanceId(normalizedExisting, adapter.config.name);
    if (normalizedExisting && getProjectInstance(normalizedExisting, instanceId)) {
      throw new Error(`Instance already exists: ${instanceId}`);
    }

    // Create tmux session (shared mode)
    const sharedSessionName = this.bridgeConfig.tmux.sharedSessionName || 'bridge';
    const windowName = this.toProjectScopedName(projectName, adapter.config.name, instanceId);
    const tmuxSession = this.tmux.getOrCreateSession(sharedSessionName, windowName);

    // Create Discord channel with custom name or default
    const channelName = channelDisplayName || this.toProjectScopedName(projectName, adapter.config.channelSuffix, instanceId);
    const channels = await this.discord.createAgentChannels(
      guildId,
      projectName,
      [adapter.config],
      channelName,
      { [adapter.config.name]: instanceId },
    );

    const channelId = channels[adapter.config.name];

    const port = overridePort || this.bridgeConfig.hookServerPort || 18470;
    // Avoid setting AGENT_DISCORD_PROJECT on shared session env (ambiguous across windows).
    this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PORT', String(port));

    // Start agent in tmux window
    const exportPrefix = this.buildExportPrefix({
      AGENT_DISCORD_PROJECT: projectName,
      AGENT_DISCORD_PORT: String(port),
      AGENT_DISCORD_AGENT: adapter.config.name,
      AGENT_DISCORD_INSTANCE: instanceId,
      ...(
        adapter.config.name === 'opencode' && this.bridgeConfig.opencode?.permissionMode === 'allow'
          ? { OPENCODE_PERMISSION: '{"*":"allow"}' }
          : {}
      ),
    });
    const permissionAllow = this.bridgeConfig.opencode?.permissionMode === 'allow';
    let claudePluginDir: string | undefined;
    let claudeHookEnabled = false;
    let geminiHookEnabled = false;

    if (adapter.config.name === 'opencode') {
      try {
        const pluginPath = installOpencodePlugin(projectPath);
        console.log(`🧩 Installed OpenCode plugin: ${pluginPath}`);
      } catch (error) {
        console.warn(`Failed to install OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (adapter.config.name === 'claude') {
      try {
        claudePluginDir = installClaudePlugin(projectPath);
        claudeHookEnabled = true;
        console.log(`🪝 Installed Claude Code plugin: ${claudePluginDir}`);
      } catch (error) {
        console.warn(`Failed to install Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (adapter.config.name === 'gemini') {
      try {
        const hookPath = installGeminiHook(projectPath);
        geminiHookEnabled = true;
        console.log(`🪝 Installed Gemini CLI hook: ${hookPath}`);
      } catch (error) {
        console.warn(`Failed to install Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let codexHookEnabled = false;
    if (adapter.config.name === 'codex') {
      try {
        const hookPath = installCodexHook();
        codexHookEnabled = true;
        console.log(`🪝 Installed Codex notify hook: ${hookPath}`);
      } catch (error) {
        console.warn(`Failed to install Codex notify hook: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Install file-handling instructions for the agent
    try {
      installFileInstruction(projectPath, adapter.config.name);
      console.log(`📎 Installed file instructions for ${adapter.config.displayName}`);
    } catch (error) {
      console.warn(`Failed to install file instructions: ${error instanceof Error ? error.message : String(error)}`);
    }

    const startCommand = this.withClaudePluginDir(adapter.getStartCommand(projectPath, permissionAllow), claudePluginDir);

    this.tmux.startAgentInWindow(
      tmuxSession,
      windowName,
      `${exportPrefix}${startCommand}`
    );

    // Save state
    const baseProject = normalizedExisting || {
      projectName,
      projectPath,
      tmuxSession,
      createdAt: new Date(),
      lastActive: new Date(),
      agents: {},
      discordChannels: {},
      instances: {},
    };
    const nextInstances = {
      ...(baseProject.instances || {}),
      [instanceId]: {
        instanceId,
        agentType: adapter.config.name,
        tmuxWindow: windowName,
        discordChannelId: channelId,
        eventHook: adapter.config.name === 'opencode' || claudeHookEnabled || geminiHookEnabled || codexHookEnabled,
      },
    };
    const projectState = normalizeProjectState({
      ...baseProject,
      projectName,
      projectPath,
      tmuxSession,
      instances: nextInstances,
      lastActive: new Date(),
    });
    this.stateManager.setProject(projectState);

    return {
      channelName,
      channelId,
      agentName: adapter.config.displayName,
      tmuxSession,
    };
  }

  private toSharedWindowName(projectName: string, agentType: string): string {
    // Target strings are interpolated into `session:window` and passed to tmux.
    // Keep window names simple (avoid ':' which would break target parsing).
    const raw = `${projectName}-${agentType}`;
    const safe = raw
      .replace(/[:\n\r\t]/g, '-')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
    return safe.length > 0 ? safe : agentType;
  }

  private toProjectScopedName(projectName: string, base: string, instanceId: string): string {
    if (instanceId === base) return this.toSharedWindowName(projectName, base);
    if (instanceId.startsWith(`${base}-`)) return this.toSharedWindowName(projectName, instanceId);
    return this.toSharedWindowName(projectName, `${base}-${instanceId}`);
  }

  private buildExportPrefix(env: Record<string, string | undefined>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      parts.push(`export ${key}=${escapeShellArg(value)}`);
    }
    return parts.length > 0 ? parts.join('; ') + '; ' : '';
  }

  private withClaudePluginDir(command: string, pluginDir?: string): string {
    if (!pluginDir || pluginDir.length === 0) return command;
    if (/--plugin-dir\b/.test(command)) return command;
    // Match `claude` only when it appears as a shell command (after && or ; or at start),
    // not when it's part of a file path like /Users/gui/claude/...
    const pattern = /((?:^|&&|;)\s*)claude\b/;
    if (!pattern.test(command)) return command;
    return command.replace(pattern, `$1claude --plugin-dir ${escapeShellArg(pluginDir)}`);
  }

  private async markAgentMessageCompleted(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    await this.pendingTracker.markCompleted(projectName, agentType, instanceId);
  }

  private async markAgentMessageError(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    await this.pendingTracker.markError(projectName, agentType, instanceId);
  }

  async stop(): Promise<void> {
    this.poller.stop();
    this.hookServer.stop();
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
