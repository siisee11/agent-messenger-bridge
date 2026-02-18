import { createServer } from 'http';
import { parse } from 'url';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { splitForDiscord, splitForSlack, extractFilePaths, stripFilePaths } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import { RuntimeControlPlane } from '../runtime/control-plane.js';
import { agentRegistry } from '../agents/index.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import { buildAgentLaunchEnv, buildExportPrefix, withClaudePluginDir } from '../policy/agent-launch.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker } from './pending-message-tracker.js';

export interface BridgeHookServerDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  reloadChannelMappings: () => void;
  runtime?: AgentRuntime;
}

export class BridgeHookServer {
  private httpServer?: ReturnType<typeof createServer>;
  private runtimeControl: RuntimeControlPlane;

  private static readonly MAX_BODY_BYTES = 256 * 1024;

  constructor(private deps: BridgeHookServerDeps) {
    this.runtimeControl = new RuntimeControlPlane(deps.runtime);
  }

  start(): void {
    this.httpServer = createServer(async (req, res) => {
      const parsed = parse(req.url || '', true);
      const pathname = parsed.pathname;

      if (req.method === 'GET' && pathname === '/runtime/windows') {
        this.handleRuntimeWindows(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/runtime/buffer') {
        const windowId = this.readQueryString(parsed.query.windowId);
        const sinceRaw = this.readQueryString(parsed.query.since);
        const since = sinceRaw ? parseInt(sinceRaw, 10) : 0;
        this.handleRuntimeBuffer(res, windowId, Number.isFinite(since) ? since : 0);
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body += chunk.toString('utf8');
        if (body.length > BridgeHookServer.MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413);
          res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        void (async () => {
          try {
            if (pathname === '/reload') {
              this.deps.reloadChannelMappings();
              res.writeHead(200);
              res.end('OK');
              return;
            }

            if (pathname === '/runtime/focus') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = this.handleRuntimeFocus(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

            if (pathname === '/runtime/input') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = this.handleRuntimeInput(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

            if (pathname === '/runtime/stop') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = this.handleRuntimeStop(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

            if (pathname === '/runtime/ensure') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = this.handleRuntimeEnsure(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

            if (pathname === '/send-files') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = await this.handleSendFiles(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

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

    this.httpServer.listen(this.deps.port, '127.0.0.1');
  }

  stop(): void {
    this.httpServer?.close();
    this.httpServer = undefined;
  }

  private writeJson(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void }, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  private readQueryString(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return undefined;
  }

  private handleRuntimeWindows(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void }): void {
    if (!this.runtimeControl.isEnabled()) {
      this.writeJson(res, 501, { error: 'Runtime control unavailable' });
      return;
    }

    const result = this.runtimeControl.listWindows();
    this.writeJson(res, 200, result);
  }

  private handleRuntimeFocus(payload: unknown): { status: number; message: string } {
    if (!this.runtimeControl.isEnabled()) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const windowId = typeof (payload as Record<string, unknown>).windowId === 'string'
      ? ((payload as Record<string, unknown>).windowId as string)
      : undefined;
    if (!windowId) {
      return { status: 400, message: 'Missing windowId' };
    }

    const focused = this.runtimeControl.focusWindow(windowId);
    if (!focused) {
      return { status: 404, message: 'Window not found' };
    }

    return { status: 200, message: 'OK' };
  }

  private handleRuntimeInput(payload: unknown): { status: number; message: string } {
    if (!this.runtimeControl.isEnabled()) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const event = payload as Record<string, unknown>;
    const windowId = typeof event.windowId === 'string' ? event.windowId : undefined;
    const text = typeof event.text === 'string' ? event.text : undefined;
    const submit = typeof event.submit === 'boolean' ? event.submit : undefined;

    if (!windowId && !this.runtimeControl.getActiveWindowId()) {
      return { status: 400, message: 'Missing windowId' };
    }
    if (!text && submit === false) {
      return { status: 400, message: 'No input to send' };
    }

    try {
      this.runtimeControl.sendInput({ windowId, text, submit });
      return { status: 200, message: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        return { status: 404, message: 'Window not found' };
      }
      return { status: 400, message };
    }
  }

  private handleRuntimeBuffer(
    res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void },
    windowId: string | undefined,
    since: number,
  ): void {
    if (!this.runtimeControl.isEnabled()) {
      this.writeJson(res, 501, { error: 'Runtime control unavailable' });
      return;
    }
    if (!windowId) {
      this.writeJson(res, 400, { error: 'Missing windowId' });
      return;
    }

    try {
      const result = this.runtimeControl.getBuffer(windowId, since);
      this.writeJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        this.writeJson(res, 404, { error: 'Window not found' });
        return;
      }
      this.writeJson(res, 400, { error: message });
    }
  }

  private handleRuntimeStop(payload: unknown): { status: number; message: string } {
    if (!this.runtimeControl.isEnabled()) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const windowId = typeof (payload as Record<string, unknown>).windowId === 'string'
      ? ((payload as Record<string, unknown>).windowId as string)
      : undefined;
    if (!windowId) {
      return { status: 400, message: 'Missing windowId' };
    }

    try {
      this.runtimeControl.stopWindow(windowId);
      return { status: 200, message: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        return { status: 404, message: 'Window not found' };
      }
      if (message.includes('Runtime stop unavailable')) {
        return { status: 501, message: 'Runtime stop unavailable' };
      }
      return { status: 400, message };
    }
  }

  private handleRuntimeEnsure(payload: unknown): { status: number; message: string } {
    if (!this.deps.runtime) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const input = payload as Record<string, unknown>;
    const projectName = typeof input.projectName === 'string' ? input.projectName : undefined;
    const instanceId = typeof input.instanceId === 'string' ? input.instanceId : undefined;
    const permissionAllow = input.permissionAllow === true;
    if (!projectName) {
      return { status: 400, message: 'Missing projectName' };
    }

    const existingProject = this.deps.stateManager.getProject(projectName);
    if (!existingProject) {
      return { status: 404, message: 'Project not found' };
    }

    const project = normalizeProjectState(existingProject);
    const instance = instanceId
      ? getProjectInstance(project, instanceId)
      : listProjectInstances(project)[0];
    if (!instance) {
      return { status: 404, message: 'Instance not found' };
    }

    const adapter = agentRegistry.get(instance.agentType);
    if (!adapter) {
      return { status: 404, message: 'Agent adapter not found' };
    }

    const windowName = instance.tmuxWindow;
    const sessionName = project.tmuxSession;
    if (!windowName || !sessionName) {
      return { status: 400, message: 'Invalid project state' };
    }

    this.deps.runtime.setSessionEnv(sessionName, 'AGENT_DISCORD_PORT', String(this.deps.port));
    if (this.deps.runtime.windowExists(sessionName, windowName)) {
      return { status: 200, message: 'OK' };
    }

    const integration = installAgentIntegration(instance.agentType, project.projectPath, 'reinstall');
    const startCommand = withClaudePluginDir(
      adapter.getStartCommand(project.projectPath, permissionAllow),
      integration.claudePluginDir,
    );
    const envPrefix = buildExportPrefix(buildAgentLaunchEnv({
      projectName,
      port: this.deps.port,
      agentType: instance.agentType,
      instanceId: instance.instanceId,
      permissionAllow,
    }));

    this.deps.runtime.startAgentInWindow(sessionName, windowName, `${envPrefix}${startCommand}`);
    return { status: 200, message: 'OK' };
  }

  /**
   * Validate an array of file paths: each must exist and reside within the project directory.
   */
  private validateFilePaths(paths: string[], projectPath: string): string[] {
    if (!projectPath) return [];
    return paths.filter((p) => {
      if (!existsSync(p)) return false;
      try {
        const real = realpathSync(p);
        return real.startsWith(projectPath + '/') || real === projectPath;
      } catch {
        return false;
      }
    });
  }

  private async handleSendFiles(payload: unknown): Promise<{ status: number; message: string }> {
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const files = Array.isArray(event.files) ? (event.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];

    if (!projectName) return { status: 400, message: 'Missing projectName' };
    if (files.length === 0) return { status: 400, message: 'No files provided' };

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return { status: 404, message: 'Project not found' };

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.channelId;
    if (!channelId) return { status: 404, message: 'No channel found for project/agent' };

    const projectPath = project.projectPath ? resolve(project.projectPath) : '';
    const validFiles = this.validateFilePaths(files, projectPath);
    if (validFiles.length === 0) return { status: 400, message: 'No valid files' };

    console.log(
      `📤 [${projectName}/${instance?.agentType || agentType}] send-files: ${validFiles.length} file(s)`,
    );

    await this.deps.messaging.sendToChannelWithFiles(channelId, '', validFiles);
    return { status: 200, message: 'OK' };
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

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return false;

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.channelId;
    if (!channelId) return false;

    const text = this.getEventText(event);
    console.log(
      `🔍 [${projectName}/${instance?.agentType || agentType}${instance ? `#${instance.instanceId}` : ''}] event=${eventType} text=${text ? `(${text.length} chars) ${text.substring(0, 100)}` : '(empty)'}`,
    );

    if (eventType === 'session.error') {
      // Fire reaction update in background – don't block message delivery
      this.deps.pendingTracker.markError(projectName, instance?.agentType || agentType, instance?.instanceId).catch(() => {});
      const msg = text || 'unknown error';
      await this.deps.messaging.sendToChannel(channelId, `⚠️ OpenCode session error: ${msg}`);
      return true;
    }

    if (eventType === 'session.idle') {
      // Fire reaction update in background – don't block message delivery
      this.deps.pendingTracker.markCompleted(projectName, instance?.agentType || agentType, instance?.instanceId).catch(() => {});
      if (text && text.trim().length > 0) {
        const trimmed = text.trim();
        // Use turnText (all assistant text from the turn) for file path extraction
        // to handle the race condition where displayText doesn't contain file paths
        const turnText = typeof event.turnText === 'string' ? event.turnText.trim() : '';
        const fileSearchText = turnText || trimmed;
        const projectPath = project.projectPath ? resolve(project.projectPath) : '';
        const filePaths = this.validateFilePaths(extractFilePaths(fileSearchText), projectPath);

        // Strip file paths from the display text to avoid leaking absolute paths
        const displayText = filePaths.length > 0 ? stripFilePaths(trimmed, filePaths) : trimmed;

        const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
        const chunks = split(displayText);
        for (const chunk of chunks) {
          if (chunk.trim().length > 0) {
            await this.deps.messaging.sendToChannel(channelId, chunk);
          }
        }

        if (filePaths.length > 0) {
          await this.deps.messaging.sendToChannelWithFiles(channelId, '', filePaths);
        }
      }
      return true;
    }

    return true;
  }
}
