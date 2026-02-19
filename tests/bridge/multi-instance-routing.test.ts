/**
 * Tests for platform → agent message routing with multiple instances
 * of the same agent type.
 *
 * Verifies that when a project has claude + claude-2 (both Claude Code),
 * messages arriving on each channel are delivered to the correct
 * tmux window and container.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────

const mockDownloadFileAttachments = vi.fn().mockResolvedValue([]);
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

const mockInjectFile = vi.fn().mockReturnValue(true);

vi.mock('../../src/container/index.js', () => ({
  injectFile: (...args: any[]) => mockInjectFile(...args),
  WORKSPACE_DIR: '/workspace',
}));

// ── Imports ─────────────────────────────────────────────────────────

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { normalizeProjectState } from '../../src/state/instances.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging() {
  return {
    platform: 'discord',
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockRuntime() {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
}

function createMultiInstanceProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    tmuxSession: 'bridge',
    discordChannels: { claude: 'ch-primary', 'claude-2': 'ch-secondary' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude',
        channelId: 'ch-primary',
      },
      'claude-2': {
        instanceId: 'claude-2',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude-2',
        channelId: 'ch-secondary',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

function createMultiInstanceContainerProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    tmuxSession: 'bridge',
    discordChannels: { claude: 'ch-primary', 'claude-2': 'ch-secondary' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude',
        channelId: 'ch-primary',
        containerMode: true,
        containerId: 'container-aaa',
        containerName: 'discode-myapp-claude',
      },
      'claude-2': {
        instanceId: 'claude-2',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude-2',
        channelId: 'ch-secondary',
        containerMode: true,
        containerId: 'container-bbb',
        containerName: 'discode-myapp-claude-2',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('multi-instance platform → agent routing', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: any;
  let router: BridgeMessageRouter;
  let messageCallback: Function;

  beforeEach(() => {
    vi.clearAllMocks();

    messaging = createMockMessaging();
    runtime = createMockRuntime();
    stateManager = {
      getProject: vi.fn(),
      updateLastActive: vi.fn(),
    };
    pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    };

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

  describe('channel-based routing (findProjectInstanceByChannel)', () => {
    it('routes ch-primary message to claude tmux window', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      await messageCallback('claude', 'fix the login bug', 'myapp', 'ch-primary', 'msg-1', undefined);

      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude',
        'fix the login bug',
        'claude',
      );
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude',
        'claude',
      );
    });

    it('routes ch-secondary message to claude-2 tmux window', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      await messageCallback('claude', 'add unit tests', 'myapp', 'ch-secondary', 'msg-2', undefined);

      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude-2',
        'add unit tests',
        'claude',
      );
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude-2',
        'claude',
      );
    });

    it('does not cross-deliver between instances', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      await messageCallback('claude', 'message for instance 2', 'myapp', 'ch-secondary', 'msg-3', undefined);

      // Should send to claude-2 window only, never to claude window
      expect(runtime.typeKeysToWindow).toHaveBeenCalledTimes(1);
      const [, windowName] = runtime.typeKeysToWindow.mock.calls[0];
      expect(windowName).toBe('myapp-claude-2');
      expect(windowName).not.toBe('myapp-claude');
    });
  });

  describe('explicit instanceId routing (mappedInstanceId)', () => {
    it('routes by mappedInstanceId when provided', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      // mappedInstanceId = 'claude-2' overrides channel-based lookup
      await messageCallback('claude', 'explicit routing', 'myapp', 'ch-secondary', 'msg-4', 'claude-2');

      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude-2',
        'explicit routing',
        'claude',
      );
    });

    it('falls back to channel-based routing when mappedInstanceId is undefined', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      await messageCallback('claude', 'no explicit id', 'myapp', 'ch-secondary', 'msg-5', undefined);

      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude-2',
        'no explicit id',
        'claude',
      );
    });
  });

  describe('pending tracker uses correct instanceId', () => {
    it('marks pending with primary instance key for ch-primary', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      await messageCallback('claude', 'hello', 'myapp', 'ch-primary', 'msg-10', undefined);

      expect(pendingTracker.markPending).toHaveBeenCalledWith(
        'myapp', 'claude', 'ch-primary', 'msg-10', 'claude',
      );
    });

    it('marks pending with secondary instance key for ch-secondary', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());

      await messageCallback('claude', 'hello', 'myapp', 'ch-secondary', 'msg-11', undefined);

      expect(pendingTracker.markPending).toHaveBeenCalledWith(
        'myapp', 'claude', 'ch-secondary', 'msg-11', 'claude-2',
      );
    });

    it('marks error with correct instanceId on delivery failure', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceProject());
      runtime.typeKeysToWindow.mockImplementation(() => {
        throw new Error("can't find window");
      });

      await messageCallback('claude', 'hello', 'myapp', 'ch-secondary', 'msg-12', undefined);

      expect(pendingTracker.markError).toHaveBeenCalledWith('myapp', 'claude', 'claude-2');
    });
  });

  describe('container mode file injection per instance', () => {
    it('injects files into primary container for ch-primary message', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceContainerProject());

      const downloaded = [
        { localPath: '/home/user/myapp/.discode/files/img.png', originalName: 'img.png', contentType: 'image/png' },
      ];
      mockDownloadFileAttachments.mockResolvedValue(downloaded);
      mockBuildFileMarkers.mockReturnValue('\n[file:img.png]');

      const attachments = [
        { url: 'https://cdn.discord.com/img.png', filename: 'img.png', contentType: 'image/png', size: 1024 },
      ];

      await messageCallback('claude', 'check this', 'myapp', 'ch-primary', undefined, undefined, attachments);

      expect(mockInjectFile).toHaveBeenCalledWith(
        'container-aaa',
        '/home/user/myapp/.discode/files/img.png',
        '/workspace/.discode/files',
      );
      // Should NOT inject into the other container
      expect(mockInjectFile).toHaveBeenCalledTimes(1);
    });

    it('injects files into secondary container for ch-secondary message', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceContainerProject());

      const downloaded = [
        { localPath: '/home/user/myapp/.discode/files/doc.pdf', originalName: 'doc.pdf', contentType: 'application/pdf' },
      ];
      mockDownloadFileAttachments.mockResolvedValue(downloaded);
      mockBuildFileMarkers.mockReturnValue('\n[file:doc.pdf]');

      const attachments = [
        { url: 'https://cdn.discord.com/doc.pdf', filename: 'doc.pdf', contentType: 'application/pdf', size: 2048 },
      ];

      await messageCallback('claude', 'review this', 'myapp', 'ch-secondary', undefined, undefined, attachments);

      expect(mockInjectFile).toHaveBeenCalledWith(
        'container-bbb',
        '/home/user/myapp/.discode/files/doc.pdf',
        '/workspace/.discode/files',
      );
      expect(mockInjectFile).toHaveBeenCalledTimes(1);
    });

    it('sends message with file markers to correct instance window', async () => {
      stateManager.getProject.mockReturnValue(createMultiInstanceContainerProject());

      const downloaded = [
        { localPath: '/home/user/myapp/.discode/files/img.png', originalName: 'img.png', contentType: 'image/png' },
      ];
      mockDownloadFileAttachments.mockResolvedValue(downloaded);
      mockBuildFileMarkers.mockReturnValue('\n[file:img.png]');

      const attachments = [
        { url: 'https://cdn.discord.com/img.png', filename: 'img.png', contentType: 'image/png', size: 1024 },
      ];

      await messageCallback('claude', 'check this', 'myapp', 'ch-secondary', undefined, undefined, attachments);

      // Message with file marker should go to claude-2 window
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
        'bridge',
        'myapp-claude-2',
        'check this\n[file:img.png]',
        'claude',
      );
    });
  });
});
