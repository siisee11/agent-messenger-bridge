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
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPendingTracker() {
  return {
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
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

    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', { type: 'session.idle' });
      expect(res.status).toBe(400);
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
