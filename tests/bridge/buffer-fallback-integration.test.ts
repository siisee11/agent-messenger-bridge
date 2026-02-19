/**
 * Integration test: buffer fallback with real timers and real tmux capture.
 *
 * Prerequisites: a tmux session named "bridge" with a "discode-claude" window
 * must be running with the /model selection menu showing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';

// ── Mocks ───────────────────────────────────────────────────────────

const mockDownloadFileAttachments = vi.fn().mockResolvedValue([]);
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

vi.mock('../../src/container/index.js', () => ({
  injectFile: vi.fn(),
  WORKSPACE_DIR: '/workspace',
}));

// ── Imports ─────────────────────────────────────────────────────────

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';
import { normalizeProjectState } from '../../src/state/instances.js';

// ── Helpers ─────────────────────────────────────────────────────────

function tmuxAvailable(): boolean {
  try {
    execSync('tmux has-session -t bridge 2>/dev/null');
    const output = execSync('tmux list-windows -t bridge -F "#{window_name}"').toString();
    return output.includes('discode-claude');
  } catch {
    return false;
  }
}

function capturePane(): string {
  try {
    return execSync('tmux capture-pane -t bridge:discode-claude -p').toString();
  } catch {
    return '';
  }
}

function hasModelMenu(): boolean {
  return capturePane().includes('Select model');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ───────────────────────────────────────────────────────────

describe('buffer fallback integration (real tmux)', () => {
  const hasTmux = tmuxAvailable();
  const hasMenu = hasTmux && hasModelMenu();

  beforeEach(() => {
    process.env.DISCODE_BUFFER_FALLBACK_INITIAL_MS = '1000';
    process.env.DISCODE_BUFFER_FALLBACK_STABLE_MS = '1000';
  });

  afterEach(() => {
    delete process.env.DISCODE_BUFFER_FALLBACK_INITIAL_MS;
    delete process.env.DISCODE_BUFFER_FALLBACK_STABLE_MS;
  });

  it.skipIf(!hasMenu)('captures /model menu from real tmux pane', async () => {
    const sentMessages: Array<{ channelId: string; text: string }> = [];
    const messaging = {
      platform: 'slack' as const,
      onMessage: vi.fn(),
      sendToChannel: vi.fn().mockImplementation(async (channelId: string, text: string) => {
        sentMessages.push({ channelId, text });
      }),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Runtime mock that reads from the REAL tmux pane
    const runtime = {
      sendKeysToWindow: vi.fn(),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      getWindowBuffer: vi.fn().mockImplementation(() => capturePane()),
    } as any;

    const project = normalizeProjectState({
      projectName: 'discode',
      projectPath: '/Users/gui/discode',
      tmuxSession: 'bridge',
      discordChannels: { claude: 'ch-test' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'discode-claude',
          channelId: 'ch-test',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });

    const stateManager = {
      getProject: vi.fn().mockReturnValue(project),
      updateLastActive: vi.fn(),
    };

    const pendingTracker = new PendingMessageTracker(messaging);
    const router = new BridgeMessageRouter({
      messaging,
      runtime,
      stateManager,
      pendingTracker,
      sanitizeInput: (content: string) => content.trim() || null,
    });

    router.register();
    const messageCallback = messaging.onMessage.mock.calls[0][0];

    // Trigger fallback (sendKeysToWindow is mocked, but buffer reads from real tmux)
    await messageCallback('claude', '/model', 'discode', 'ch-test', 'msg-test', undefined);

    // Wait for: initial check (1s) + stable check (1s) + margin
    await sleep(3000);

    console.log(`Sent messages: ${sentMessages.length}`);
    if (sentMessages.length > 0) {
      console.log(`Channel: ${sentMessages[0].channelId}`);
      console.log(`Contains "Select model": ${sentMessages[0].text.includes('Select model')}`);
      console.log(`Preview: ${sentMessages[0].text.substring(0, 100)}...`);
    }

    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0].text).toContain('Select model');
    expect(sentMessages[0].text).toContain('Enter to confirm');

    // Pending was resolved
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
      'ch-test', 'msg-test', '⏳', '✅',
    );
  }, 10000);
});
