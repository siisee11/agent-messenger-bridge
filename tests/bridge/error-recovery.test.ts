/**
 * Tests for message delivery error handling and recovery.
 *
 * Covers:
 * - PendingMessageTracker reaction lifecycle (⏳ → ✅ / ❌)
 * - Message router delivery failure handling and user guidance
 * - Hook server resilience when messaging or tracker calls fail
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';

// ── Mock setup for message-router ───────────────────────────────────

const mockDownloadFileAttachments = vi.fn().mockResolvedValue([]);
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

vi.mock('../../src/container/index.js', () => ({
  injectFile: vi.fn().mockReturnValue(true),
  WORKSPACE_DIR: '/workspace',
}));

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging() {
  return {
    platform: 'discord' as const,
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRuntime() {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
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

// ── PendingMessageTracker tests ────────────────────────────────────

describe('PendingMessageTracker', () => {
  it('adds ⏳ reaction when marking message as pending', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

    expect(messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳');
  });

  it('replaces ⏳ with ✅ on markCompleted', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '✅');
  });

  it('replaces ⏳ with ❌ on markError', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await tracker.markError('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '❌');
  });

  it('removes pending entry after markCompleted', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('project', 'claude');

    // Second markCompleted should be a no-op (already removed)
    messaging.replaceOwnReactionOnMessage.mockClear();
    await tracker.markCompleted('project', 'claude');
    expect(messaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when no pending message exists', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    // No markPending called — markCompleted/markError should be silent
    await tracker.markCompleted('project', 'claude');
    await tracker.markError('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('tracks pending messages by instanceId when provided', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1', 'claude');
    await tracker.markPending('project', 'claude', 'ch-2', 'msg-2', 'claude-2');

    // Complete only the first instance
    await tracker.markCompleted('project', 'claude', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '✅');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledTimes(1);

    // Second instance should still be pending
    await tracker.markError('project', 'claude', 'claude-2');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-2', 'msg-2', '⏳', '❌');
  });

  it('overwrites previous pending when same key is marked pending again', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-old');
    await tracker.markPending('project', 'claude', 'ch-1', 'msg-new');

    await tracker.markCompleted('project', 'claude');

    // Should use the newer message ID
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-new', '⏳', '✅');
  });

  describe('getPending', () => {
    it('returns pending entry with startMessageId when sendToChannelWithId succeeds', async () => {
      const messaging = {
        ...createMockMessaging(),
        sendToChannelWithId: vi.fn().mockResolvedValue('bot-start-msg-ts'),
      };
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      const entry = tracker.getPending('project', 'claude');
      expect(entry).toBeDefined();
      expect(entry!.channelId).toBe('ch-1');
      expect(entry!.messageId).toBe('msg-1');
      expect(entry!.startMessageId).toBe('bot-start-msg-ts');
    });

    it('returns pending entry without startMessageId when sendToChannelWithId is absent', async () => {
      const messaging = createMockMessaging(); // no sendToChannelWithId
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      const entry = tracker.getPending('project', 'claude');
      expect(entry).toBeDefined();
      expect(entry!.startMessageId).toBeUndefined();
    });

    it('returns pending entry without startMessageId when sendToChannelWithId throws', async () => {
      const messaging = {
        ...createMockMessaging(),
        sendToChannelWithId: vi.fn().mockRejectedValue(new Error('API error')),
      };
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      const entry = tracker.getPending('project', 'claude');
      expect(entry).toBeDefined();
      expect(entry!.channelId).toBe('ch-1');
      expect(entry!.startMessageId).toBeUndefined();
    });

    it('hasPending returns false after markCompleted but getPending returns recently-completed entry', async () => {
      const messaging = {
        ...createMockMessaging(),
        sendToChannelWithId: vi.fn().mockResolvedValue('start-ts'),
      };
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      expect(tracker.getPending('project', 'claude')).toBeDefined();

      await tracker.markCompleted('project', 'claude');
      // hasPending is false (active map is cleared)
      expect(tracker.hasPending('project', 'claude')).toBe(false);
      // But getPending still returns from recently-completed cache for thread replies
      const entry = tracker.getPending('project', 'claude');
      expect(entry).toBeDefined();
      expect(entry!.startMessageId).toBe('start-ts');
    });

    it('distinguishes instances in getPending', async () => {
      const messaging = {
        ...createMockMessaging(),
        sendToChannelWithId: vi.fn()
          .mockResolvedValueOnce('start-ts-1')
          .mockResolvedValueOnce('start-ts-2'),
      };
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1', 'claude');
      await tracker.markPending('project', 'claude', 'ch-2', 'msg-2', 'claude-2');

      const entry1 = tracker.getPending('project', 'claude', 'claude');
      const entry2 = tracker.getPending('project', 'claude', 'claude-2');
      expect(entry1?.startMessageId).toBe('start-ts-1');
      expect(entry2?.startMessageId).toBe('start-ts-2');
    });

    it('sends start message via sendToChannelWithId during markPending', async () => {
      const messaging = {
        ...createMockMessaging(),
        sendToChannelWithId: vi.fn().mockResolvedValue('start-ts'),
      };
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', '⏳ Processing...');
    });
  });

  describe('hasPending', () => {
    it('returns true when a message is pending', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      expect(tracker.hasPending('project', 'claude')).toBe(true);
    });

    it('returns false when no message is pending', () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      expect(tracker.hasPending('project', 'claude')).toBe(false);
    });

    it('returns false after markCompleted', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markCompleted('project', 'claude');

      expect(tracker.hasPending('project', 'claude')).toBe(false);
    });

    it('returns false after markError', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markError('project', 'claude');

      expect(tracker.hasPending('project', 'claude')).toBe(false);
    });

    it('distinguishes between different instances', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1', 'claude');
      await tracker.markPending('project', 'claude', 'ch-2', 'msg-2', 'claude-2');

      await tracker.markCompleted('project', 'claude', 'claude');

      expect(tracker.hasPending('project', 'claude', 'claude')).toBe(false);
      expect(tracker.hasPending('project', 'claude', 'claude-2')).toBe(true);
    });
  });
});

// ── Message router delivery failure tests ───────────────────────────

describe('BridgeMessageRouter delivery failure', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: any;
  let router: BridgeMessageRouter;
  let messageCallback: Function;

  const project = {
    projectName: 'test',
    projectPath: '/test/path',
    tmuxSession: 'bridge',
    discordChannels: { claude: 'ch-1' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        tmuxWindow: 'test-claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    messaging = createMockMessaging();
    runtime = createMockRuntime();
    stateManager = {
      getProject: vi.fn().mockReturnValue(project),
      updateLastActive: vi.fn(),
    };
    pendingTracker = createMockPendingTracker();

    router = new BridgeMessageRouter({
      messaging,
      runtime,
      stateManager,
      pendingTracker,
      sanitizeInput: (content: string) => content.trim() || null,
    });

    router.register();
    messageCallback = messaging.onMessage.mock.calls[0][0];
  });

  it('marks error and sends guidance when typeKeysToWindow throws', async () => {
    runtime.typeKeysToWindow.mockImplementation(() => {
      throw new Error('tmux session error');
    });

    await messageCallback('claude', 'hello', 'test', 'ch-1', 'msg-1', 'claude');

    expect(pendingTracker.markError).toHaveBeenCalledWith('test', 'claude', 'claude');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining("couldn't deliver your message"),
    );
  });

  it('provides restart guidance when window/pane not found', async () => {
    runtime.typeKeysToWindow.mockImplementation(() => {
      throw new Error("can't find window: test-claude");
    });

    await messageCallback('claude', 'hello', 'test', 'ch-1', 'msg-1', 'claude');

    const sentMessage = messaging.sendToChannel.mock.calls[0][1];
    expect(sentMessage).toContain('discode new --name test');
    expect(sentMessage).toContain('discode attach test');
  });

  it('provides generic guidance for non-window errors', async () => {
    runtime.typeKeysToWindow.mockImplementation(() => {
      throw new Error('unexpected tmux failure');
    });

    await messageCallback('claude', 'hello', 'test', 'ch-1', 'msg-1', 'claude');

    const sentMessage = messaging.sendToChannel.mock.calls[0][1];
    expect(sentMessage).toContain('confirm the agent is running');
    expect(sentMessage).not.toContain('discode attach');
  });

  it('sends warning when project is not found in state', async () => {
    stateManager.getProject.mockReturnValue(undefined);

    await messageCallback('claude', 'hello', 'missing-project', 'ch-1', undefined, undefined);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('not found in state'),
    );
    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('sends warning when agent instance mapping not found', async () => {
    // Clear all legacy maps too — normalizeProjectState falls back to legacy
    // maps (agents, discordChannels) when instances is empty.
    stateManager.getProject.mockReturnValue({
      ...project,
      agents: {},
      instances: {},
      discordChannels: {},
    });

    await messageCallback('claude', 'hello', 'test', 'ch-unknown', undefined, undefined);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-unknown',
      expect.stringContaining('instance mapping not found'),
    );
  });

  it('sends warning for empty/invalid messages', async () => {
    await messageCallback('claude', '   ', 'test', 'ch-1', undefined, undefined);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Invalid message'),
    );
    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });
});

// ── Hook server error resilience tests ──────────────────────────────

describe('hook server error resilience', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    const rawDir = join(tmpdir(), `discode-err-recovery-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
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

  const project = {
    projectName: 'test',
    projectPath: '/tmp/test',
    tmuxSession: 'bridge',
    agents: { claude: true },
    discordChannels: { claude: 'ch-1' },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };

  it('does not crash when sendToChannel throws during session.idle', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.sendToChannel.mockRejectedValue(new Error('Discord API error'));
    const stateManager = createMockStateManager({ test: project });

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
    });

    // Should return 500 (internal error) but not crash the server
    expect(res.status).toBe(500);

    // Verify server is still alive by making another request
    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('does not crash when sendToChannel throws during session.error', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.sendToChannel.mockRejectedValue(new Error('Slack API error'));
    const stateManager = createMockStateManager({ test: project });

    startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: createMockPendingTracker() as any,
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.error',
      text: 'Agent crashed',
    });

    expect(res.status).toBe(500);

    // Server should still be operational
    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('delivers message even when markCompleted fails', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.markCompleted.mockRejectedValue(new Error('Reaction API failed'));
    const stateManager = createMockStateManager({ test: project });

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
      text: 'Important response',
    });

    // Should still succeed — markCompleted failure is fire-and-forget
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'Important response');
  });

  it('delivers error message even when markError fails', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.markError.mockRejectedValue(new Error('Reaction API failed'));
    const stateManager = createMockStateManager({ test: project });

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
      text: 'Something failed',
    });

    // Should still succeed — markError failure is fire-and-forget
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Something failed'),
    );
  });

  it('returns 400 for malformed JSON body', async () => {
    startServer();
    await new Promise((r) => setTimeout(r, 50));

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = 'this is not json{{{';
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/opencode-event',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

    expect(res.status).toBe(400);
    expect(res.body).toContain('Invalid JSON');
  });

  it('returns 400 for missing projectName in opencode-event', async () => {
    startServer();
    await new Promise((r) => setTimeout(r, 50));

    const res = await postJSON(port, '/opencode-event', {
      type: 'session.idle',
      text: 'No project',
    });

    expect(res.status).toBe(400);
  });

  it('returns false (400) when project is not found', async () => {
    const stateManager = createMockStateManager({});
    startServer({ stateManager: stateManager as any });
    await new Promise((r) => setTimeout(r, 50));

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'nonexistent',
      type: 'session.idle',
      text: 'Hello',
    });

    expect(res.status).toBe(400);
  });

  it('does not send message when session.idle text is empty', async () => {
    const mockMessaging = createMockMessaging();
    const stateManager = createMockStateManager({ test: project });

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
      text: '',
    });

    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not crash when replyInThread throws during tool.activity', async () => {
    const mockMessaging = {
      ...createMockMessaging(),
      replyInThread: vi.fn().mockRejectedValue(new Error('Discord API error')),
    };
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-1',
      messageId: 'msg-1',
      startMessageId: 'start-ts',
    });
    const stateManager = createMockStateManager({ test: project });

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

    // Should return 200 (failure is caught), not crash the server
    expect(res.status).toBe(200);

    // Verify server is still alive
    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('tool.activity continues to work after markCompleted clears pending entry', async () => {
    // This tests the recently-completed cache scenario:
    // 1. markPending → 2. markCompleted → 3. tool.activity should still find the entry
    const mockMessaging = {
      ...createMockMessaging(),
      sendToChannelWithId: vi.fn().mockResolvedValue('start-ts'),
      replyInThread: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new PendingMessageTracker(mockMessaging as any);
    const stateManager = createMockStateManager({ test: project });

    startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: tracker as any,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate the full lifecycle: user message → markPending → buffer fallback → markCompleted
    await tracker.markPending('test', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('test', 'claude');

    // Now tool.activity arrives — it should still find the entry via recently-completed cache
    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(res.status).toBe(200);
    // replyInThread called: once by "⏳ Processing..." in markPending is sendToChannelWithId,
    // and once by tool.activity
    expect(mockMessaging.replyInThread).toHaveBeenCalledWith('ch-1', 'start-ts', '📖 Read(`src/index.ts`)');
  });

  it('does not crash when ensurePending throws during tool.activity', async () => {
    const mockMessaging = {
      ...createMockMessaging(),
      replyInThread: vi.fn().mockResolvedValue(undefined),
    };
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending.mockRejectedValue(new Error('Slack API down'));
    const stateManager = createMockStateManager({ test: project });

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

    // ensurePending failure should bubble up as 500 but not crash the server
    expect(res.status).toBe(500);

    // Server should still be alive
    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('does not crash when ensurePending throws during session.idle', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending.mockRejectedValue(new Error('Slack API down'));
    const stateManager = createMockStateManager({ test: project });

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
    });

    expect(res.status).toBe(500);

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('tmux-initiated full lifecycle: ensurePending → tool.activity → session.idle', async () => {
    // Integration-style test with real PendingMessageTracker
    const mockMessaging = {
      ...createMockMessaging(),
      sendToChannelWithId: vi.fn().mockResolvedValue('auto-start-ts'),
      replyInThread: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new PendingMessageTracker(mockMessaging as any);
    const stateManager = createMockStateManager({ test: project });

    startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: tracker as any,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Step 1: First tool.activity from tmux — triggers ensurePending
    const res1 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
    expect(res1.status).toBe(200);
    expect(mockMessaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', '⏳ Processing...');
    expect(mockMessaging.replyInThread).toHaveBeenCalledWith('ch-1', 'auto-start-ts', '📖 Read(`src/index.ts`)');

    // Step 2: Second tool.activity — no duplicate ensurePending
    mockMessaging.sendToChannelWithId.mockClear();
    const res2 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '✏️ Edit(`src/config.ts`) +3 lines',
    });
    expect(res2.status).toBe(200);
    // Should NOT send another "Processing..." message
    expect(mockMessaging.sendToChannelWithId).not.toHaveBeenCalled();
    expect(mockMessaging.replyInThread).toHaveBeenCalledWith('ch-1', 'auto-start-ts', '✏️ Edit(`src/config.ts`) +3 lines');

    // Step 3: session.idle — completes the turn
    const res3 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done!',
      intermediateText: 'Let me fix that.',
      thinking: 'Analyzing the issue...',
    });
    expect(res3.status).toBe(200);

    // intermediateText as thread reply
    expect(mockMessaging.replyInThread).toHaveBeenCalledWith('ch-1', 'auto-start-ts', 'Let me fix that.');
    // thinking as thread reply (wrapped in code block)
    const thinkingCall = mockMessaging.replyInThread.mock.calls.find(
      (c: any) => typeof c[2] === 'string' && c[2].includes('Analyzing the issue'),
    );
    expect(thinkingCall).toBeDefined();
    // Main text as channel message
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'Done!');

    // No reaction change (tmux-initiated, empty messageId)
    expect(mockMessaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('does not crash when replyInThread throws during intermediateText', async () => {
    const mockMessaging = {
      ...createMockMessaging(),
      replyInThread: vi.fn().mockRejectedValue(new Error('Discord API error')),
    };
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-1',
      messageId: 'msg-1',
      startMessageId: 'start-ts',
    });
    const stateManager = createMockStateManager({ test: project });

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
      intermediateText: 'This fails',
      thinking: 'This also fails',
    });

    // intermediateText + thinking both fail, but main text should still be attempted
    // However both replyInThread and sendToChannel may throw, so 500 is expected
    // The important thing is the server doesn't crash
    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });
});
