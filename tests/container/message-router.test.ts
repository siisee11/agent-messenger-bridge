/**
 * Tests for message-router container file injection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file downloader
const mockDownloadFileAttachments = vi.fn().mockResolvedValue([]);
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

// Mock container module
const mockInjectFile = vi.fn().mockReturnValue(true);

vi.mock('../../src/container/index.js', () => ({
  injectFile: (...args: any[]) => mockInjectFile(...args),
  WORKSPACE_DIR: '/workspace',
}));

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { normalizeProjectState } from '../../src/state/instances.js';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';

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

describe('BridgeMessageRouter container file injection', () => {
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

  it('injects files into container when instance has containerMode', async () => {
    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      tmuxSession: 'session',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'test-claude',
          channelId: 'ch-1',
          containerMode: true,
          containerId: 'container-abc',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });
    stateManager.getProject.mockReturnValue(project);

    const downloadedFiles = [
      { localPath: '/test/path/.discode/files/img.png', originalName: 'img.png', contentType: 'image/png' },
    ];
    mockDownloadFileAttachments.mockResolvedValue(downloadedFiles);
    mockBuildFileMarkers.mockReturnValue('\n[file:/test/path/.discode/files/img.png]');

    const attachments = [
      { url: 'https://cdn.discord.com/img.png', filename: 'img.png', contentType: 'image/png', size: 1024 },
    ];

    await messageCallback('claude', 'check this image', 'test', 'ch-1', undefined, undefined, attachments);

    // Should inject file into container
    expect(mockInjectFile).toHaveBeenCalledWith(
      'container-abc',
      '/test/path/.discode/files/img.png',
      '/workspace/.discode/files',
    );
  });

  it('does not inject files when instance is not container mode', async () => {
    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      tmuxSession: 'session',
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
    });
    stateManager.getProject.mockReturnValue(project);

    const downloadedFiles = [
      { localPath: '/test/path/.discode/files/img.png', originalName: 'img.png', contentType: 'image/png' },
    ];
    mockDownloadFileAttachments.mockResolvedValue(downloadedFiles);
    mockBuildFileMarkers.mockReturnValue('\n[file:/test/path/.discode/files/img.png]');

    const attachments = [
      { url: 'https://cdn.discord.com/img.png', filename: 'img.png', contentType: 'image/png', size: 1024 },
    ];

    await messageCallback('claude', 'check this', 'test', 'ch-1', undefined, undefined, attachments);

    // Should NOT inject file into container
    expect(mockInjectFile).not.toHaveBeenCalled();
  });
});
