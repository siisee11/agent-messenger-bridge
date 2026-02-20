import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';

function createMockMessaging() {
  return {
    platform: 'slack' as const,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('start-msg-ts'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPendingTracker() {
  return {
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    hasPending: vi.fn().mockReturnValue(true),
    ensurePending: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockReturnValue(undefined),
  };
}

function createMockStateManager(projects: Record<string, any> = {}) {
  return {
    getProject: vi.fn((name: string) => projects[name]),
    setProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue(Object.values(projects)),
    reload: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function postJSON(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getRequest(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function postRaw(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('BridgeHookServer', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    // Use realpathSync to resolve macOS symlinks (/var → /private/var)
    // so that validateFilePaths' realpathSync check doesn't fail.
    const rawDir = join(tmpdir(), `discode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
    // Use a random high port to avoid conflicts
    port = 19000 + Math.floor(Math.random() * 1000);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function startServer(deps: Partial<BridgeHookServerDeps> = {}): BridgeHookServer {
    const fullDeps: BridgeHookServerDeps = {
      port,
      messaging: createMockMessaging() as any,
      stateManager: createMockStateManager() as any,
      pendingTracker: createMockPendingTracker() as any,
      reloadChannelMappings: vi.fn(),
      ...deps,
    };
    server = new BridgeHookServer(fullDeps);
    server.start();
    return server;
  }

  describe('POST /reload', () => {
    it('calls reloadChannelMappings and returns 200', async () => {
      const reloadFn = vi.fn();
      startServer({ reloadChannelMappings: reloadFn });

      // Wait for server to start
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/reload', {});
      expect(res.status).toBe(200);
      expect(res.body).toBe('OK');
      expect(reloadFn).toHaveBeenCalledOnce();
    });
  });

  describe('POST /send-files', () => {
    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { files: ['/tmp/f.png'] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('projectName');
    });

    it('returns 400 for empty files array', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: [] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('No files');
    });

    it('returns 404 for unknown project', async () => {
      startServer({ stateManager: createMockStateManager({}) as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'nonexistent', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('Project not found');
    });

    it('returns 404 when no channel found for project', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: {},
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('No channel');
    });

    it('sends files for valid project with channelId', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'test.png');
      writeFileSync(testFile, 'fake-png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', {
        projectName: 'test',
        agentType: 'claude',
        files: [testFile],
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('rejects files outside the project directory', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      // File outside projectPath
      const outsideFile = join(realpathSync(tmpdir()), 'outside.txt');
      writeFileSync(outsideFile, 'outside');
      try {
        const res = await postJSON(port, '/send-files', {
          projectName: 'test',
          agentType: 'claude',
          files: [outsideFile],
        });
        expect(res.status).toBe(400);
        expect(res.body).toContain('No valid files');
      } finally {
        rmSync(outsideFile, { force: true });
      }
    });
  });

  describe('POST /opencode-event', () => {
    it('handles session.idle with text', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Hello from agent');
    });

    it('strips file paths from display text in session.idle', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.png');
      writeFileSync(testFile, 'png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const textWithPath = `Here is the output: ${testFile}`;
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: textWithPath,
      });
      expect(res.status).toBe(200);

      // The sent text should not contain the file path
      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(testFile);
      expect(sentText).toContain('Here is the output:');

      // File should be sent separately
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('handles session.error', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something went wrong',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markError).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Something went wrong'),
      );
    });

    it('handles session.notification with permission_prompt', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
        text: 'Claude needs permission to use Bash',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Claude needs permission to use Bash'),
      );
      // Should contain the lock emoji for permission_prompt
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^🔐/);
    });

    it('handles session.notification with idle_prompt', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Claude is idle',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^💤/);
    });

    it('handles session.notification with auth_success', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'auth_success',
        text: 'Auth succeeded',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^🔑/);
      expect(sentMsg).toContain('Auth succeeded');
    });

    it('handles session.notification with elicitation_dialog', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'elicitation_dialog',
        text: 'Claude wants to ask a question',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^❓/);
    });

    it('handles session.notification without text (falls back to notificationType)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('permission_prompt');
    });

    it('handles session.notification without notificationType', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        text: 'Some notification',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      // Should use bell emoji for unknown type
      expect(sentMsg).toMatch(/^🔔/);
    });

    it('handles session.notification with both text and notificationType missing', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      // Bell emoji for unknown type, message falls back to notificationType "unknown"
      expect(sentMsg).toMatch(/^🔔/);
      expect(sentMsg).toContain('unknown');
    });

    it('handles session.notification with unknown type using bell emoji', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'some_new_type',
        text: 'New notification',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^🔔/);
    });

    it('sends promptText after notification message for session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Claude Code needs your attention',
        promptText: '❓ *Approach*\nWhich approach?\n• *Fast* — Quick\n• *Safe* — Reliable',
      });
      expect(res.status).toBe(200);
      // First call: the notification message itself
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Claude Code needs your attention');
      // Second call: the prompt details
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
      const promptMsg = mockMessaging.sendToChannel.mock.calls[1][1];
      expect(promptMsg).toContain('Which approach?');
      expect(promptMsg).toContain('*Fast*');
      expect(promptMsg).toContain('*Safe*');
    });

    it('does not send promptText when empty in session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
        text: 'Claude needs permission',
      });
      expect(res.status).toBe(200);
      // Only one message: the notification itself (no promptText)
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Claude needs permission');
    });

    it('does not send promptText when not a string in session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Notification',
        promptText: 12345,
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('sends ExitPlanMode promptText in session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Claude Code needs your attention',
        promptText: '📋 Plan approval needed',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('Plan approval needed');
    });

    it('handles session.start event', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'startup',
        model: 'claude-sonnet-4-6',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Session started'),
      );
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('startup');
      expect(sentMsg).toContain('claude-sonnet-4-6');
    });

    it('handles session.start without model', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'resume',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('resume');
      expect(sentMsg).not.toContain(',');
    });

    it('handles session.start without source (defaults to unknown)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('unknown');
      expect(sentMsg).not.toContain(',');
    });

    it('handles session.end event', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
        reason: 'logout',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Session ended'),
      );
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('logout');
    });

    it('handles session.end without reason (defaults to unknown)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('unknown');
    });

    it('handles session.end with prompt_input_exit reason', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
        reason: 'prompt_input_exit',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('prompt_input_exit');
    });

    it('posts thinking as thread reply on start message', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns startMessageId — the bot's "Processing..." message
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Let me reason about this question...',
      });
      expect(res.status).toBe(200);
      // Thinking should be posted as thread reply on the START message (not user's message)
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        expect.stringContaining('Reasoning'),
      );
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        expect.stringContaining('Let me reason about this question...'),
      );
      // Final response should be a new channel message (not in thread)
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('wraps thinking content in code block', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: 'Step 1: read the file\nStep 2: fix the bug',
      });
      expect(res.status).toBe(200);
      const allContent = mockMessaging.replyInThread.mock.calls
        .map((call: any) => call[2])
        .join('');
      // Header should be outside the code block
      expect(allContent).toContain(':brain: *Reasoning*');
      // Thinking text should be inside triple-backtick code block
      expect(allContent).toContain('```\nStep 1: read the file\nStep 2: fix the bug\n```');
    });

    it('wraps truncated thinking in code block with truncation marker outside', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const longThinking = 'y'.repeat(15000);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: longThinking,
      });
      expect(res.status).toBe(200);
      const allContent = mockMessaging.replyInThread.mock.calls
        .map((call: any) => call[2])
        .join('');
      // Should contain opening and closing code fences
      expect(allContent).toContain('```\n');
      expect(allContent).toContain('\n```');
      // Truncation marker should be present inside the code block
      expect(allContent).toContain('_(truncated)_');
    });

    it('does not post thinking when no startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns entry WITHOUT startMessageId (sendToChannelWithId failed)
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      expect(res.status).toBe(200);
      // Should NOT post thinking (no startMessageId to thread on)
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      // Should still post the main response
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('does not post thinking when no pending message', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns undefined (no pending message at all)
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('does not post empty thinking', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('truncates long thinking content', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const longThinking = 'x'.repeat(15000);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: longThinking,
      });
      expect(res.status).toBe(200);
      // Collect all thread reply content
      const allThinkingContent = mockMessaging.replyInThread.mock.calls
        .map((call: any) => call[2])
        .join('');
      expect(allThinkingContent).toContain('Reasoning');
      expect(allThinkingContent).toContain('_(truncated)_');
      expect(allThinkingContent.length).toBeLessThan(15000);
    });

    it('does not post whitespace-only thinking', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: '   \n  ',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('does not post thinking when thinking is not a string', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 12345,
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('splits long thinking into multiple thread replies', async () => {
      const mockMessaging = createMockMessaging();
      // Slack platform — limit is ~3900 chars per message
      mockMessaging.platform = 'slack' as const;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Generate thinking with newlines that exceeds Slack's ~3900 char limit
      const lines = Array.from({ length: 80 }, (_, i) => `Reasoning step ${i}: ${'x'.repeat(60)}`);
      const longThinking = lines.join('\n');
      expect(longThinking.length).toBeGreaterThan(3900);

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: longThinking,
      });
      expect(res.status).toBe(200);
      // Should be split into at least 2 thread replies
      expect(mockMessaging.replyInThread.mock.calls.length).toBeGreaterThanOrEqual(2);
      // All replies should target the start message
      for (const call of mockMessaging.replyInThread.mock.calls) {
        expect(call[0]).toBe('ch-123');
        expect(call[1]).toBe('start-msg-ts');
      }
    });

    it('uses Discord splitting for discord platform thinking', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'discord' as const;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Discord limit is ~1900 chars. Create thinking between 1900-3900 to verify Discord splitting (not Slack).
      const thinking = 'x'.repeat(2500);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking,
      });
      expect(res.status).toBe(200);
      // With Discord splitting (1900 limit) + header, should need multiple chunks
      expect(mockMessaging.replyInThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not post thinking when replyInThread method is absent', async () => {
      const mockMessaging = createMockMessaging();
      // Remove replyInThread to simulate a client that doesn't support it
      delete (mockMessaging as any).replyInThread;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      expect(res.status).toBe(200);
      // Main response should still be sent
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('calls getPending before markCompleted to preserve startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const callOrder: string[] = [];
      mockPendingTracker.getPending.mockImplementation(() => {
        callOrder.push('getPending');
        return { channelId: 'ch-123', messageId: 'msg-user-1', startMessageId: 'start-msg-ts' };
      });
      mockPendingTracker.markCompleted.mockImplementation(async () => {
        callOrder.push('markCompleted');
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: 'Thought about it',
      });

      // getPending must be called before markCompleted
      expect(callOrder.indexOf('getPending')).toBeLessThan(callOrder.indexOf('markCompleted'));
    });

    it('sends thinking and main response to correct channels independently', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The final answer',
        thinking: 'Internal reasoning',
      });
      expect(res.status).toBe(200);

      // Thinking goes to thread via replyInThread
      expect(mockMessaging.replyInThread).toHaveBeenCalled();
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      for (const call of threadCalls) {
        expect(call[1]).toBe('start-msg-ts'); // thread parent is start message
      }

      // Main response goes to channel via sendToChannel (NOT in thread)
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The final answer');
    });

    it('handles replyInThread failure gracefully', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.replyInThread.mockRejectedValue(new Error('Slack API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      // Should still succeed — thinking failure is non-fatal
      expect(res.status).toBe(200);
      // Main response should still be sent as channel message
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', { type: 'session.idle' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON body', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postRaw(port, '/opencode-event', 'not valid json');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid JSON');
    });

    it('returns 400 for non-object payload', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postRaw(port, '/opencode-event', '"just a string"');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid event payload');
    });

    it('returns 400 for unknown project', async () => {
      startServer({ stateManager: createMockStateManager({}) as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'nonexistent',
        agentType: 'claude',
        type: 'session.idle',
        text: 'hello',
      });
      expect(res.status).toBe(400);
    });

    it('prefers text over message field in getEventText', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'from text field',
        message: 'from message field',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'from text field');
    });

    it('falls back to message field when text is missing', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        message: 'fallback message',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'fallback message');
    });

    it('handles session.error without text (defaults to "unknown error")', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('unknown error'),
      );
    });

    it('handles session.idle with empty text (no message sent)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('handles unknown event type gracefully', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'some.future.event',
        text: 'hello',
      });
      // Unknown event types still return 200 (true) per the catch-all return
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('uses turnText for file path extraction when text has no paths', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.png');
      writeFileSync(testFile, 'fake-png');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Here is the chart',
        turnText: `Created ${testFile}`,
      });
      expect(res.status).toBe(200);
      // Text message should be sent
      expect(mockMessaging.sendToChannel).toHaveBeenCalled();
      // File from turnText should be sent
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('sends promptText as additional message after response text', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Which approach?',
        promptText: '❓ *Approach*\nWhich approach?\n\n• *Fast* — Quick\n• *Safe* — Reliable',
      });
      expect(res.status).toBe(200);
      // First call: response text, second call: prompt text
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(2);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Which approach?');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Approach*');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Fast*');
    });

    it('does not send extra message when promptText is empty', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
        promptText: '',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello from agent');
    });

    it('uses Discord splitting for promptText on discord platform', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'discord' as const;
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Create promptText > 1900 chars (Discord limit) to trigger splitting
      const lines = Array.from({ length: 40 }, (_, i) => `• *Option ${i}* — ${'x'.repeat(40)}`);
      const longPrompt = `❓ *Big question*\nPick one?\n${lines.join('\n')}`;
      expect(longPrompt.length).toBeGreaterThan(1900);

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Choose one',
        promptText: longPrompt,
      });
      expect(res.status).toBe(200);
      // First call: response text, subsequent calls: split promptText chunks
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Choose one');
    });

    it('does not send promptText that is whitespace only', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello',
        promptText: '   \n  ',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello');
    });

    it('sends thinking + text + promptText in correct order', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Here are options.',
        thinking: 'Analyzing requirements...',
        promptText: '❓ Pick an approach?',
      });
      expect(res.status).toBe(200);

      // Thinking → thread reply
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        expect.stringContaining('Analyzing requirements'),
      );
      // Text → first channel message, promptText → second channel message
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(2);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Here are options.');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('Pick an approach?');
    });

    it('sends promptText with files in correct order', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'diagram.png');
      writeFileSync(testFile, 'png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: `Here is the diagram: ${testFile}`,
        turnText: `Created ${testFile}`,
        promptText: '❓ Does this look correct?',
      });
      expect(res.status).toBe(200);

      // Text (with file path stripped) → channel message
      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(testFile);
      // Files sent
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
      // PromptText → additional channel message
      const lastCall = mockMessaging.sendToChannel.mock.calls[mockMessaging.sendToChannel.mock.calls.length - 1];
      expect(lastCall[1]).toContain('Does this look correct?');
    });

    it('does not send promptText when type is not string', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello',
        promptText: 12345,
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello');
    });

    it('posts tool.activity as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        '📖 Read(`src/index.ts`)',
      );
      // tool.activity should not send channel messages
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('ignores tool.activity when no pending entry', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns undefined (no pending entry)
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('ignores tool.activity when text is empty', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('ignores tool.activity when no startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        // no startMessageId
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('handles tool.activity replyInThread failure gracefully', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.replyInThread.mockRejectedValue(new Error('Slack API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should not crash — failure is caught
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
    });

    it('ignores tool.activity when replyInThread method is absent', async () => {
      const mockMessaging = createMockMessaging();
      delete (mockMessaging as any).replyInThread;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      // No crash, no channel message sent
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('tool.activity does not call markCompleted', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      // tool.activity should NOT call markCompleted — only session.idle does
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
    });

    it('tool.activity uses text from message field as fallback', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        message: '💻 `npm test`',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        '💻 `npm test`',
      );
    });

    it('session.idle no longer processes toolSummary field', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done!',
        toolSummary: '📖 Read(`src/index.ts`)',
      });
      // toolSummary is no longer handled in session.idle — should NOT appear as thread reply
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      const hasActivity = threadCalls.some((c: any) => c[2].includes('Activity'));
      expect(hasActivity).toBe(false);
    });

    it('posts intermediateText as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Final response',
        intermediateText: '현재 분석 인프라를 파악하겠습니다.',
      });
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      expect(threadCalls.some((c: any) => c[2] === '현재 분석 인프라를 파악하겠습니다.')).toBe(true);
    });

    it('does not post intermediateText when empty', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response only',
        intermediateText: '',
      });
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      // Only thinking could appear as thread reply, not intermediate (it's empty)
      expect(threadCalls.length).toBe(0);
    });

    it('posts intermediateText before thinking in thread', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Final answer',
        intermediateText: 'Let me check the code.',
        thinking: 'Reasoning about the problem...',
      });
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      // intermediateText should come before thinking
      const intermediateIdx = threadCalls.findIndex((c: any) => c[2] === 'Let me check the code.');
      const thinkingIdx = threadCalls.findIndex((c: any) => c[2].includes('Reasoning'));
      expect(intermediateIdx).toBeGreaterThanOrEqual(0);
      expect(thinkingIdx).toBeGreaterThanOrEqual(0);
      expect(intermediateIdx).toBeLessThan(thinkingIdx);
    });

    it('auto-creates pending entry for tmux-initiated tool.activity', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // No pending entry — simulating tmux-initiated prompt
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
        // After ensurePending, getPending returns a new entry
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
          startMessageId: 'auto-start-msg',
        });
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(mockPendingTracker.ensurePending).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'claude');
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith('ch-123', 'auto-start-msg', '📖 Read(`src/index.ts`)');
    });

    it('auto-creates pending entry for tmux-initiated session.idle', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
          startMessageId: 'auto-start-msg',
        });
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response from tmux',
      });

      expect(mockPendingTracker.ensurePending).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'claude');
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response from tmux');
    });

    it('does not call ensurePending when pending already exists', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('does not call ensurePending for session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
        text: 'Allow?',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('does not call ensurePending for session.error', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something broke',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('does not call ensurePending for session.start', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'tmux',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('ignores intermediateText when not a string', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response',
        intermediateText: 42,
      });

      // intermediateText is not a string — should not appear as thread reply
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      expect(threadCalls.every((c: any) => typeof c[2] === 'string' && !c[2].includes('42'))).toBe(true);
    });

    it('skips intermediateText when no startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        // no startMessageId
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response',
        intermediateText: 'Should not appear',
      });

      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('handles intermediateText replyInThread failure gracefully', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.replyInThread.mockRejectedValue(new Error('Slack API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Still delivered',
        intermediateText: 'This fails to post',
      });

      // Main text should still be delivered despite intermediateText failure
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Still delivered');
    });

    it('skips intermediateText when replyInThread method is absent', async () => {
      const mockMessaging = createMockMessaging();
      delete (mockMessaging as any).replyInThread;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response',
        intermediateText: 'No thread support',
      });

      expect(res.status).toBe(200);
      // Main text should still be sent to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response');
    });

    it('sends promptText even when text is empty', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        promptText: '📋 Plan approval needed',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Plan approval needed');
    });

    it('skips empty text chunks', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: '   ',
      });
      expect(res.status).toBe(200);
      // No message should be sent for whitespace-only text
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('uses Slack splitting for slack platform', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'slack' as const;
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Create a message that's > 1900 chars (Discord limit) but < 3900 (Slack limit)
      const longText = 'x'.repeat(2500);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: longText,
      });
      expect(res.status).toBe(200);
      // With Slack splitting (3900 limit), the message should be sent as a single chunk
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP method filtering', () => {
    it('rejects non-POST requests', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/reload', method: 'GET' },
          (res) => resolve({ status: res.statusCode || 0 }),
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(405);
    });
  });

  describe('request limits', () => {
    it('returns 413 when body is too large', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const huge = JSON.stringify({ text: 'x'.repeat(300_000) });
      const res = await postRaw(port, '/runtime/input', huge);
      expect(res.status).toBe(413);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/unknown', {});
      expect(res.status).toBe(404);
    });
  });

  describe('runtime control API', () => {
    function createMockRuntime() {
      const windows = [
        {
          sessionName: 'bridge',
          windowName: 'project-claude',
          status: 'running',
          pid: 1234,
        },
      ];

      return {
        getOrCreateSession: vi.fn().mockReturnValue('bridge'),
        setSessionEnv: vi.fn(),
        windowExists: vi.fn((sessionName: string, windowName: string) => sessionName === 'bridge' && windowName === 'project-claude'),
        startAgentInWindow: vi.fn(),
        sendKeysToWindow: vi.fn(),
        typeKeysToWindow: vi.fn(),
        sendEnterToWindow: vi.fn(),
        stopWindow: vi.fn().mockReturnValue(true),
        listWindows: vi.fn().mockReturnValue(windows),
        getWindowBuffer: vi.fn().mockReturnValue('hello-runtime'),
      };
    }

    it('returns runtime windows via GET /runtime/windows', async () => {
      startServer({ runtime: createMockRuntime() as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await getRequest(port, '/runtime/windows');
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { windows: Array<{ windowId: string }> };
      expect(parsed.windows[0].windowId).toBe('bridge:project-claude');
    });

    it('focuses and sends input to runtime window', async () => {
      const runtime = createMockRuntime();
      startServer({ runtime: runtime as any });
      await new Promise((r) => setTimeout(r, 50));

      const focusRes = await postJSON(port, '/runtime/focus', { windowId: 'bridge:project-claude' });
      expect(focusRes.status).toBe(200);

      const inputRes = await postJSON(port, '/runtime/input', {
        text: 'hello',
        submit: true,
      });
      expect(inputRes.status).toBe(200);
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith('bridge', 'project-claude', 'hello');
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith('bridge', 'project-claude');
    });

    it('returns buffer slices via GET /runtime/buffer', async () => {
      startServer({ runtime: createMockRuntime() as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await getRequest(port, '/runtime/buffer?windowId=bridge:project-claude&since=5');
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { chunk: string; next: number };
      expect(parsed.chunk).toBe('-runtime');
      expect(parsed.next).toBe(13);
    });

    it('returns 501 when runtime control is unavailable', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await getRequest(port, '/runtime/windows');
      expect(res.status).toBe(501);
    });

    it('stops runtime window via POST /runtime/stop', async () => {
      const runtime = createMockRuntime();
      startServer({ runtime: runtime as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/runtime/stop', { windowId: 'bridge:project-claude' });
      expect(res.status).toBe(200);
      expect(runtime.stopWindow).toHaveBeenCalledWith('bridge', 'project-claude');
    });

    it('ensures runtime window via POST /runtime/ensure', async () => {
      const runtime = createMockRuntime();
      runtime.windowExists = vi.fn().mockReturnValue(false);

      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          createdAt: new Date().toISOString(),
          lastActive: new Date().toISOString(),
          instances: {
            opencode: {
              instanceId: 'opencode',
              agentType: 'opencode',
              tmuxWindow: 'test-opencode',
              channelId: 'C123',
            },
          },
        },
      });

      startServer({ runtime: runtime as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/runtime/ensure', { projectName: 'test', instanceId: 'opencode' });
      expect(res.status).toBe(200);
      expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
        'bridge',
        'test-opencode',
        expect.stringContaining('opencode'),
      );
    });
  });
});
