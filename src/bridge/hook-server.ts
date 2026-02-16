import { createServer } from 'http';
import { parse } from 'url';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { splitForDiscord, splitForSlack, extractFilePaths } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker } from './pending-message-tracker.js';

export interface BridgeHookServerDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  reloadChannelMappings: () => void;
}

export class BridgeHookServer {
  private httpServer?: ReturnType<typeof createServer>;

  constructor(private deps: BridgeHookServerDeps) {}

  start(): void {
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
            if (pathname === '/reload') {
              this.deps.reloadChannelMappings();
              res.writeHead(200);
              res.end('OK');
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
        const filePaths = extractFilePaths(fileSearchText).filter((p) => {
          if (!existsSync(p)) return false;
          if (!projectPath) return false;
          try {
            const real = realpathSync(p);
            return real.startsWith(projectPath + '/') || real === projectPath;
          } catch {
            return false;
          }
        });

        const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
        const chunks = split(trimmed);
        for (const chunk of chunks) {
          await this.deps.messaging.sendToChannel(channelId, chunk);
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
