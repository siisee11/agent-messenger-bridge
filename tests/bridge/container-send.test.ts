/**
 * Tests for container-mode agent → platform message sending.
 *
 * Verifies that agents running inside Docker containers can send messages
 * and files back to Discord/Slack via the hook server, using the
 * AGENT_DISCORD_HOSTNAME environment variable for host resolution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import { getDiscodeSendScriptSource } from '../../src/infra/send-script.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging(platform: 'discord' | 'slack' = 'discord') {
  return {
    platform,
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

// ── Tests ───────────────────────────────────────────────────────────

describe('container agent → platform send', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    const rawDir = join(tmpdir(), `discode-container-send-${Date.now()}`);
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

  function createContainerProject() {
    return {
      projectName: 'test-project',
      projectPath: tempDir,
      tmuxSession: 'bridge',
      agents: { claude: true },
      discordChannels: { claude: 'ch-container' },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'test-project-claude',
          channelId: 'ch-container',
          containerMode: true,
          containerId: 'container-abc123',
          containerName: 'discode-test-project-claude',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    };
  }

  describe('send-script AGENT_DISCORD_HOSTNAME support', () => {
    it('reads hostname from AGENT_DISCORD_HOSTNAME env var', () => {
      const source = getDiscodeSendScriptSource({ projectName: 'test', port: 18470 });
      expect(source).toContain('process.env.AGENT_DISCORD_HOSTNAME');
      expect(source).toContain('"127.0.0.1"');
    });

    it('uses hostname variable for http.request', () => {
      const source = getDiscodeSendScriptSource({ projectName: 'test', port: 18470 });
      expect(source).toContain('hostname: hostname');
    });
  });

  describe('/opencode-event from container agent', () => {
    it('routes session.idle from container instance to correct channel', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Done! I fixed the bug.',
      });

      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompleted).toHaveBeenCalledWith('test-project', 'claude', 'claude');
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-container', 'Done! I fixed the bug.');
    });

    it('routes session.error from container instance to correct channel', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.error',
        text: 'API rate limit exceeded',
      });

      expect(res.status).toBe(200);
      expect(mockPendingTracker.markError).toHaveBeenCalledWith('test-project', 'claude', 'claude');
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-container',
        expect.stringContaining('API rate limit exceeded'),
      );
    });

    it('resolves channel by instanceId for multi-instance container project', async () => {
      const mockMessaging = createMockMessaging();
      const project = {
        projectName: 'multi',
        projectPath: tempDir,
        tmuxSession: 'bridge',
        agents: { claude: true },
        discordChannels: { claude: 'ch-primary' },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'multi-claude',
            channelId: 'ch-primary',
            containerMode: true,
            containerId: 'container-aaa',
          },
          'claude-2': {
            instanceId: 'claude-2',
            agentType: 'claude',
            tmuxWindow: 'multi-claude-2',
            channelId: 'ch-secondary',
            containerMode: true,
            containerId: 'container-bbb',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      const stateManager = createMockStateManager({ multi: project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Send from second container instance
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'multi',
        agentType: 'claude',
        instanceId: 'claude-2',
        type: 'session.idle',
        text: 'Response from instance 2',
      });

      expect(res.status).toBe(200);
      // Should route to the second instance's channel, not the primary
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-secondary', 'Response from instance 2');
    });

    it('splits long messages for Discord platform limit', async () => {
      const mockMessaging = createMockMessaging('discord');
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Create multi-line text exceeding Discord's ~1900 char limit.
      // splitForDiscord splits at newline boundaries.
      const lines = Array.from({ length: 40 }, (_, i) => `Line ${i}: ${'x'.repeat(80)}`);
      const longText = lines.join('\n');
      expect(longText.length).toBeGreaterThan(1900);

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: longText,
      });

      expect(res.status).toBe(200);
      // Should be split into multiple chunks
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Combined text (joined with newline) should equal original
      const combined = mockMessaging.sendToChannel.mock.calls.map((c: any[]) => c[1]).join('\n');
      expect(combined).toBe(longText);
    });
  });

  describe('/opencode-event thinking from container agent', () => {
    it('posts thinking as thread reply for container instance', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-container',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Fixed the bug.',
        thinking: 'Let me analyze the error stack trace...',
      });

      expect(res.status).toBe(200);
      // Thinking should be posted as thread reply
      expect((mockMessaging as any).replyInThread).toHaveBeenCalledWith(
        'ch-container',
        'start-msg-ts',
        expect.stringContaining('analyze the error stack trace'),
      );
      // Main response should be a channel message
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-container', 'Fixed the bug.');
    });

    it('wraps thinking in code block for container instance', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-container',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Fixed it.',
        thinking: 'Reading the stack trace...',
      });

      expect(res.status).toBe(200);
      const allContent = (mockMessaging as any).replyInThread.mock.calls
        .map((c: any) => c[2])
        .join('');
      expect(allContent).toContain(':brain: *Reasoning*');
      expect(allContent).toContain('```\nReading the stack trace...\n```');
    });

    it('routes thinking thread reply to correct instance channel in multi-instance setup', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-secondary',
        messageId: 'msg-user-2',
        startMessageId: 'start-msg-ts-2',
      });
      const project = {
        projectName: 'multi',
        projectPath: tempDir,
        tmuxSession: 'bridge',
        agents: { claude: true },
        discordChannels: { claude: 'ch-primary' },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'multi-claude',
            channelId: 'ch-primary',
            containerMode: true,
            containerId: 'container-aaa',
          },
          'claude-2': {
            instanceId: 'claude-2',
            agentType: 'claude',
            tmuxWindow: 'multi-claude-2',
            channelId: 'ch-secondary',
            containerMode: true,
            containerId: 'container-bbb',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      const stateManager = createMockStateManager({ multi: project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'multi',
        agentType: 'claude',
        instanceId: 'claude-2',
        type: 'session.idle',
        text: 'Response from instance 2',
        thinking: 'Instance 2 reasoning',
      });

      expect(res.status).toBe(200);
      // Thinking should go to secondary channel's thread
      expect((mockMessaging as any).replyInThread).toHaveBeenCalledWith(
        'ch-secondary',
        'start-msg-ts-2',
        expect.stringContaining('Instance 2 reasoning'),
      );
      // Main response to secondary channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-secondary', 'Response from instance 2');
    });

    it('sends promptText from container instance', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Which approach?',
        promptText: '❓ *Approach*\nWhich one?\n\n• *Fast* — Quick\n• *Safe* — Reliable',
      });

      expect(res.status).toBe(200);
      // First call: response text, second call: prompt text
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(2);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Which approach?');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Approach*');
    });

    it('sends thinking + promptText + text from container instance', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-container',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Here are two approaches.',
        thinking: 'Let me evaluate options...',
        promptText: '❓ Pick one?\n• *A*\n• *B*',
      });

      expect(res.status).toBe(200);
      // Thinking → thread reply
      expect((mockMessaging as any).replyInThread).toHaveBeenCalledWith(
        'ch-container',
        'start-msg-ts',
        expect.stringContaining('evaluate options'),
      );
      // Text + promptText → channel messages
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(2);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Here are two approaches.');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('Pick one?');
    });

    it('posts tool.activity from container instance as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-container',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(res.status).toBe(200);
      expect((mockMessaging as any).replyInThread).toHaveBeenCalledTimes(1);
      expect((mockMessaging as any).replyInThread).toHaveBeenCalledWith(
        'ch-container',
        'start-msg-ts',
        '📖 Read(`src/index.ts`)',
      );
      // tool.activity should not send channel messages
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('ignores tool.activity from container when no pending entry', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns undefined
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/config.ts`) +3 lines',
      });

      expect(res.status).toBe(200);
      expect((mockMessaging as any).replyInThread).not.toHaveBeenCalled();
    });

    it('routes tool.activity to correct instance channel in multi-instance setup', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-claude-2',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = {
        projectName: 'multi',
        projectPath: tempDir,
        tmuxSession: 'bridge',
        agents: { claude: true },
        discordChannels: { claude: 'ch-claude' },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'multi-claude',
            channelId: 'ch-claude',
          },
          'claude-2': {
            instanceId: 'claude-2',
            agentType: 'claude',
            tmuxWindow: 'multi-claude-2',
            channelId: 'ch-claude-2',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      const stateManager = createMockStateManager({ multi: project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'multi',
        agentType: 'claude',
        instanceId: 'claude-2',
        type: 'tool.activity',
        text: '💻 `npm run build`',
      });

      expect(res.status).toBe(200);
      expect((mockMessaging as any).replyInThread).toHaveBeenCalledWith(
        'ch-claude-2',
        'start-msg-ts',
        '💻 `npm run build`',
      );
    });

    it('tool.activity does not trigger markCompleted on container instance', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-container',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
      expect(mockPendingTracker.markError).not.toHaveBeenCalled();
    });

    it('posts intermediateText from container instance as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-container',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Final answer',
        intermediateText: 'Checking the codebase first.',
      });

      const threadCalls = (mockMessaging as any).replyInThread.mock.calls;
      expect(threadCalls.some((c: any) => c[2] === 'Checking the codebase first.')).toBe(true);
      // Main text goes to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-container', 'Final answer');
    });

    it('delivers response even without thinking in container mode', async () => {
      const mockMessaging = createMockMessaging();
      (mockMessaging as any).replyInThread = vi.fn().mockResolvedValue(undefined);
      const mockPendingTracker = createMockPendingTracker();
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: 'Quick fix applied.',
      });

      expect(res.status).toBe(200);
      expect((mockMessaging as any).replyInThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-container', 'Quick fix applied.');
    });
  });

  describe('/send-files from container agent', () => {
    it('sends files from container instance to correct channel', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'screenshot.png');
      writeFileSync(testFile, 'fake-png-data');

      const mockMessaging = createMockMessaging();
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        files: [testFile],
      });

      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-container', '', [testFile]);
    });

    it('routes files to correct instance channel in multi-instance setup', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.txt');
      writeFileSync(testFile, 'content');

      const mockMessaging = createMockMessaging();
      const project = {
        projectName: 'multi',
        projectPath: tempDir,
        tmuxSession: 'bridge',
        agents: { claude: true },
        discordChannels: { claude: 'ch-1' },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            channelId: 'ch-1',
            containerMode: true,
            containerId: 'c-aaa',
          },
          'claude-2': {
            instanceId: 'claude-2',
            agentType: 'claude',
            channelId: 'ch-2',
            containerMode: true,
            containerId: 'c-bbb',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      const stateManager = createMockStateManager({ multi: project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', {
        projectName: 'multi',
        agentType: 'claude',
        instanceId: 'claude-2',
        files: [testFile],
      });

      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-2', '', [testFile]);
    });

    it('strips file paths from session.idle text and sends files separately', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const outputFile = join(filesDir, 'result.png');
      writeFileSync(outputFile, 'png-data');

      const mockMessaging = createMockMessaging();
      const project = createContainerProject();
      const stateManager = createMockStateManager({ 'test-project': project });

      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test-project',
        agentType: 'claude',
        instanceId: 'claude',
        type: 'session.idle',
        text: `Here is the result: ${outputFile}`,
        turnText: `I created the image at ${outputFile}`,
      });

      expect(res.status).toBe(200);

      // Text sent to channel should not contain the absolute file path
      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(outputFile);
      expect(sentText).toContain('Here is the result');

      // File should be sent separately
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-container', '', [outputFile]);
    });
  });
});
