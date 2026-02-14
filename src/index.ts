/**
 * Main entry point for discode
 */

import { DiscordClient } from './discord/client.js';
import { TmuxManager } from './tmux/manager.js';
import { stateManager as defaultStateManager } from './state/index.js';
import { config as defaultConfig } from './config/index.js';
import { agentRegistry as defaultAgentRegistry, AgentRegistry } from './agents/index.js';
import { CapturePoller } from './capture/index.js';
import { splitForDiscord, extractFilePaths } from './capture/parser.js';
import { CodexSubmitter } from './codex/submitter.js';
import { installOpencodePlugin } from './opencode/plugin-installer.js';
import { installClaudePlugin } from './claude/plugin-installer.js';
import { installGeminiHook } from './gemini/hook-installer.js';
import { installCodexHook } from './codex/plugin-installer.js';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { parse } from 'url';
import type { ProjectAgents } from './types/index.js';
import type { IStateManager } from './types/interfaces.js';
import type { BridgeConfig } from './types/index.js';
import { escapeShellArg } from './infra/shell-escape.js';
import {
  buildNextInstanceId,
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectAgentTypes,
  listProjectInstances,
  normalizeProjectState,
} from './state/instances.js';
import { downloadFileAttachments, buildFileMarkers } from './infra/file-downloader.js';
import { installFileInstruction } from './infra/file-instruction.js';

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
  private httpServer?: ReturnType<typeof createServer>;
  private stateManager: IStateManager;
  private registry: AgentRegistry;
  private bridgeConfig: BridgeConfig;
  private pendingMessageByInstance: Map<string, { channelId: string; messageId: string }> = new Map();

  constructor(deps?: AgentBridgeDeps) {
    this.bridgeConfig = deps?.config || defaultConfig;
    this.discord = deps?.discord || new DiscordClient(this.bridgeConfig.discord.token);
    this.tmux = deps?.tmux || new TmuxManager(this.bridgeConfig.tmux.sessionPrefix);
    this.stateManager = deps?.stateManager || defaultStateManager;
    this.registry = deps?.registry || defaultAgentRegistry;
    this.codexSubmitter = deps?.codexSubmitter || new CodexSubmitter(this.tmux);
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

    // Connect to Discord
    await this.discord.connect();
    console.log('✅ Discord connected');

    // Load channel mappings from saved state
    const projects = this.stateManager.listProjects().map((rawProject) => {
      const project = normalizeProjectState(rawProject);
      const agentTypes = new Set(listProjectAgentTypes(project));
      if (!agentTypes.has('opencode') && !agentTypes.has('claude') && !agentTypes.has('gemini') && !agentTypes.has('codex')) {
        return project;
      }

      let opencodeInstalled = false;
      let claudeInstalled = false;
      let geminiHookInstalled = false;
      let codexHookInstalled = false;

      if (agentTypes.has('opencode')) {
        try {
          const pluginPath = installOpencodePlugin(project.projectPath);
          console.log(`🧩 Installed OpenCode plugin: ${pluginPath}`);
          opencodeInstalled = true;
        } catch (error) {
          console.warn(`Failed to install OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (agentTypes.has('claude')) {
        try {
          const pluginPath = installClaudePlugin(project.projectPath);
          console.log(`🪝 Installed Claude Code plugin: ${pluginPath}`);
          claudeInstalled = true;
        } catch (error) {
          console.warn(`Failed to install Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (agentTypes.has('gemini')) {
        try {
          const hookPath = installGeminiHook(project.projectPath);
          console.log(`🪝 Installed Gemini CLI hook: ${hookPath}`);
          geminiHookInstalled = true;
        } catch (error) {
          console.warn(`Failed to install Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (agentTypes.has('codex')) {
        try {
          const hookPath = installCodexHook();
          console.log(`🪝 Installed Codex notify hook: ${hookPath}`);
          codexHookInstalled = true;
        } catch (error) {
          console.warn(`Failed to install Codex notify hook: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Install file-handling instructions for each active agent
      for (const at of agentTypes) {
        try {
          installFileInstruction(project.projectPath, at);
        } catch {
          // Non-critical: skip silently
        }
      }

      const nextInstances: NonNullable<typeof project.instances> = { ...(project.instances || {}) };
      let changed = false;

      for (const instance of listProjectInstances(project)) {
        const shouldEnableHook =
          (instance.agentType === 'opencode' && opencodeInstalled) ||
          (instance.agentType === 'claude' && claudeInstalled) ||
          (instance.agentType === 'gemini' && geminiHookInstalled) ||
          (instance.agentType === 'codex' && codexHookInstalled);

        if (shouldEnableHook && !instance.eventHook) {
          nextInstances[instance.instanceId] = {
            ...instance,
            eventHook: true,
          };
          changed = true;
        }
      }

      if (!changed) return project;

      const next = normalizeProjectState({
        ...project,
        instances: nextInstances,
      });
      this.stateManager.setProject(next);
      return next;
    });
    const mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[] = [];
    for (const project of projects) {
      for (const instance of listProjectInstances(project)) {
        if (instance.discordChannelId) {
          mappings.push({
            channelId: instance.discordChannelId,
            projectName: project.projectName,
            agentType: instance.agentType,
            instanceId: instance.instanceId,
          });
        }
      }
    }
    if (mappings.length > 0) {
      this.discord.registerChannelMappings(mappings);
    }

    // Set up message routing (Discord → Agent via tmux)
    this.discord.onMessage(async (agentType, content, projectName, channelId, messageId, mappedInstanceId, attachments) => {
      console.log(
        `📨 [${projectName}/${agentType}${mappedInstanceId ? `#${mappedInstanceId}` : ''}] ${content.substring(0, 50)}...`,
      );

      const project = this.stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await this.discord.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      const normalizedProject = normalizeProjectState(project);
      const mappedInstance =
        (mappedInstanceId ? getProjectInstance(normalizedProject, mappedInstanceId) : undefined) ||
        findProjectInstanceByChannel(normalizedProject, channelId) ||
        getPrimaryInstanceForAgent(normalizedProject, agentType);
      if (!mappedInstance) {
        await this.discord.sendToChannel(channelId, '⚠️ Agent instance mapping not found for this channel');
        return;
      }
      const resolvedAgentType = mappedInstance.agentType;
      const instanceKey = mappedInstance.instanceId;
      const windowName = mappedInstance.tmuxWindow || instanceKey;

      // Download file attachments and append markers to the message
      let enrichedContent = content;
      if (attachments && attachments.length > 0) {
        try {
          const downloaded = await downloadFileAttachments(attachments, project.projectPath);
          if (downloaded.length > 0) {
            const markers = buildFileMarkers(downloaded);
            enrichedContent = content + markers;
            console.log(`📎 [${projectName}/${agentType}] ${downloaded.length} file(s) attached`);
          }
        } catch (error) {
          console.warn(`Failed to process file attachments:`, error);
        }
      }

      // Sanitize input
      const sanitized = this.sanitizeInput(enrichedContent);
      if (!sanitized) {
        await this.discord.sendToChannel(channelId, `⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters`);
        return;
      }

      // Get agent adapter
      if (messageId) {
        this.pendingMessageByInstance.set(this.pendingKey(projectName, instanceKey), { channelId, messageId });
        await this.discord.addReactionToMessage(channelId, messageId, '⏳');
      }

      // Send to tmux
      try {
        if (resolvedAgentType === 'codex') {
          const ok = await this.codexSubmitter.submit(normalizedProject.tmuxSession, windowName, sanitized);
          if (!ok) {
            await this.markAgentMessageError(projectName, resolvedAgentType, instanceKey);
            await this.discord.sendToChannel(
              channelId,
              `⚠️ Codex에 메시지를 제출하지 못했습니다. Codex가 busy 상태일 수 있어요.\n` +
              `tmux로 붙어서 Enter를 한 번 눌러보거나, 잠시 후 다시 보내주세요.`
            );
          }
        } else if (resolvedAgentType === 'opencode') {
          await this.submitToOpencode(normalizedProject.tmuxSession, windowName, sanitized);
        } else {
          this.tmux.sendKeysToWindow(normalizedProject.tmuxSession, windowName, sanitized, resolvedAgentType);
        }
      } catch (error) {
        await this.markAgentMessageError(projectName, resolvedAgentType, instanceKey);
        await this.discord.sendToChannel(
          channelId,
          `⚠️ tmux로 메시지 전달 실패: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.stateManager.updateLastActive(projectName);
    });

    // Start HTTP server (minimal - just reload endpoint)
    this.startServer();

    // Start capture poller (Agent → Discord via tmux capture)
    this.poller.start();

    console.log('✅ Discode is running');
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

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        void (async () => {
          try {
          // Route: /reload (re-read state and update channel mappings)
          if (pathname === '/reload') {
            this.reloadChannelMappings();
            res.writeHead(200);
            res.end('OK');
            return;
          }

            // Route: /opencode-event (OpenCode plugin -> Discord)
            if (pathname === '/opencode-event') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const ok = await this.handleOpencodeEvent(payload);
              if (ok) {
                res.writeHead(200);
                res.end('OK');
              } else {
                res.writeHead(400);
                res.end('Invalid event payload');
              }
              return;
            }

          res.writeHead(404);
          res.end('Not found');
        } catch (error) {
          console.error('Request processing error:', error);
          res.writeHead(500);
          res.end('Internal error');
          }
        })();
      });
    });

    this.httpServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });

    this.httpServer.listen(port, '127.0.0.1');
  }

  private reloadChannelMappings(): void {
    this.stateManager.reload();
    const projects = this.stateManager.listProjects().map((project) => normalizeProjectState(project));
    const mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[] = [];
    for (const project of projects) {
      for (const instance of listProjectInstances(project)) {
        if (instance.discordChannelId) {
          mappings.push({
            channelId: instance.discordChannelId,
            projectName: project.projectName,
            agentType: instance.agentType,
            instanceId: instance.instanceId,
          });
        }
      }
    }
    if (mappings.length > 0) {
      this.discord.registerChannelMappings(mappings);
    }
    console.log(`🔄 Reloaded channel mappings (${mappings.length} channels)`);
  }

  private getEventText(payload: Record<string, unknown>): string | undefined {
    const direct = payload.text;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct;

    const message = payload.message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    return undefined;
  }

  private async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    if (!payload || typeof payload !== 'object') return false;

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;

    if (!projectName) return false;

    const project = this.stateManager.getProject(projectName);
    if (!project) return false;

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.discordChannelId;
    if (!channelId) return false;

    const text = this.getEventText(event);
    console.log(
      `🔍 [${projectName}/${instance?.agentType || agentType}${instance ? `#${instance.instanceId}` : ''}] event=${eventType} text=${text ? `(${text.length} chars) ${text.substring(0, 100)}` : '(empty)'}`,
    );

    if (eventType === 'session.error') {
      await this.markAgentMessageError(projectName, instance?.agentType || agentType, instance?.instanceId);
      const msg = text || 'unknown error';
      await this.discord.sendToChannel(channelId, `⚠️ OpenCode session error: ${msg}`);
      return true;
    }

    if (eventType === 'session.idle') {
      await this.markAgentMessageCompleted(projectName, instance?.agentType || agentType, instance?.instanceId);
      if (text && text.trim().length > 0) {
        const trimmed = text.trim();

        // Extract file paths from the response text
        const filePaths = extractFilePaths(trimmed).filter((p) => existsSync(p));

        const chunks = splitForDiscord(trimmed);
        for (const chunk of chunks) {
          await this.discord.sendToChannel(channelId, chunk);
        }

        // Send detected files as Discord attachments
        if (filePaths.length > 0) {
          await this.discord.sendToChannelWithFiles(channelId, '', filePaths);
        }
      }
      return true;
    }

    return true;
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

  private pendingKey(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
  }

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.trunc(n);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async submitToOpencode(tmuxSession: string, windowName: string, prompt: string): Promise<void> {
    // OpenCode can occasionally drop an immediate Enter while rendering.
    this.tmux.typeKeysToWindow(tmuxSession, windowName, prompt.trimEnd(), 'opencode');
    const delayMs = this.getEnvInt('AGENT_DISCORD_OPENCODE_SUBMIT_DELAY_MS', 75);
    await this.sleep(delayMs);
    this.tmux.sendEnterToWindow(tmuxSession, windowName, 'opencode');
  }

  private async markAgentMessageCompleted(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    await this.discord.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '✅');
    this.pendingMessageByInstance.delete(key);
  }

  private async markAgentMessageError(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    await this.discord.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '❌');
    this.pendingMessageByInstance.delete(key);
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
