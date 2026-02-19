/**
 * Tests for the terminal buffer fallback mechanism.
 *
 * When the Stop hook doesn't fire (e.g., interactive prompts like /model),
 * the buffer fallback captures the terminal content and sends it to Slack
 * after detecting that the terminal buffer is stable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function createMockMessaging() {
  return {
    platform: 'slack',
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockRuntime(bufferContent?: string | (() => string)) {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    getWindowBuffer: vi.fn().mockImplementation(() => {
      if (typeof bufferContent === 'function') return bufferContent();
      return bufferContent ?? '';
    }),
  } as any;
}

function createProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    tmuxSession: 'bridge',
    discordChannels: { claude: 'ch-1' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

function createMultiInstanceProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    tmuxSession: 'bridge',
    discordChannels: { claude: 'ch-1', 'claude-2': 'ch-2' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude',
        channelId: 'ch-1',
      },
      'claude-2': {
        instanceId: 'claude-2',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude-2',
        channelId: 'ch-2',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

const MODEL_MENU = [
  '❯ /model',
  '───────────────────────────────',
  ' Select model',
  '',
  '   1. Default (recommended)  Opus 4.6',
  '   2. Sonnet                 Sonnet 4.6',
  '   3. Haiku                  Haiku 4.5',
  ' ❯ 4. opus ✔                Custom model',
  '',
  ' Enter to confirm · Esc to exit',
].join('\n');

const HELP_OUTPUT = [
  'Available commands:',
  '  /model   - Switch models',
  '  /help    - Show this help',
  '  /clear   - Clear conversation',
  '  /config  - Show configuration',
].join('\n');

// ── Tests ───────────────────────────────────────────────────────────

describe('buffer fallback for interactive prompts', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: PendingMessageTracker;
  let router: BridgeMessageRouter;
  let messageCallback: Function;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Zero-out the submit delay so the sleep inside submitToAgent
    // doesn't block when using fake timers.
    process.env.DISCODE_SUBMIT_DELAY_MS = '0';

    messaging = createMockMessaging();
    runtime = createMockRuntime(MODEL_MENU);
    stateManager = {
      getProject: vi.fn().mockReturnValue(createProject()),
      updateLastActive: vi.fn(),
    };
    pendingTracker = new PendingMessageTracker(messaging);

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

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DISCODE_SUBMIT_DELAY_MS;
  });

  // ── Core behavior ───────────────────────────────────────────────

  it('sends terminal buffer to Slack when Stop hook does not fire', async () => {
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // First timer fires at 3s — captures snapshot A
    await vi.advanceTimersByTimeAsync(3000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Second timer fires at 5s — snapshot B === snapshot A → stable → send
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
    // Should be wrapped in a code block
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringMatching(/^```\n[\s\S]+\n```$/),
    );
  });

  it('marks pending as completed after sending buffer', async () => {
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Advance past both checks
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // Pending should be resolved — hourglass replaced with checkmark
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
      'ch-1', 'msg-1', '⏳', '✅',
    );
  });

  it('does not send buffer when Stop hook fires before fallback', async () => {
    await messageCallback('claude', 'hello world', 'myapp', 'ch-1', 'msg-1', undefined);

    // Simulate Stop hook firing at 2s (before the 3s fallback check)
    await vi.advanceTimersByTimeAsync(2000);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    // Advance past fallback timers
    await vi.advanceTimersByTimeAsync(5000);

    // sendToChannel should NOT be called by the fallback
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send buffer when Stop hook fires between first and second check', async () => {
    await messageCallback('claude', 'hello world', 'myapp', 'ch-1', 'msg-1', undefined);

    // First check fires at 3s — takes snapshot
    await vi.advanceTimersByTimeAsync(3000);

    // Stop hook fires at 4s (between first and second check)
    await vi.advanceTimersByTimeAsync(1000);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    // Second check at 5s — hasPending is false → no-op
    await vi.advanceTimersByTimeAsync(1000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── Stability detection ─────────────────────────────────────────

  it('retries when buffer is changing (agent still processing)', async () => {
    let callCount = 0;
    runtime.getWindowBuffer.mockImplementation(() => {
      callCount++;
      // First two snapshots are different (agent is thinking)
      // Third snapshot matches second (stable)
      if (callCount <= 1) return 'thinking...';
      return MODEL_MENU;
    });

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // First check at 3s — snapshot A = 'thinking...'
    await vi.advanceTimersByTimeAsync(3000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Second check at 5s — snapshot B = MODEL_MENU (different from A, reschedule)
    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Third check at 7s — snapshot C = MODEL_MENU (same as B, stable → send)
    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  it('gives up after max checks when buffer keeps changing', async () => {
    let callCount = 0;
    runtime.getWindowBuffer.mockImplementation(() => {
      callCount++;
      return `frame-${callCount}`;
    });

    await messageCallback('claude', 'long task', 'myapp', 'ch-1', 'msg-1', undefined);

    // Advance through all checks (initial + maxChecks stable checks)
    await vi.advanceTimersByTimeAsync(3000); // check 1
    await vi.advanceTimersByTimeAsync(2000); // check 2
    await vi.advanceTimersByTimeAsync(2000); // check 3 (maxChecks reached)
    await vi.advanceTimersByTimeAsync(2000); // extra time — nothing should happen

    // Should never send buffer since it kept changing
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send when buffer is whitespace-only', async () => {
    runtime.getWindowBuffer.mockReturnValue('   \n  \n   \n');

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── Timer management ────────────────────────────────────────────

  it('cancels previous fallback when new message arrives', async () => {
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Advance 2s (before first fallback fires)
    await vi.advanceTimersByTimeAsync(2000);

    // New message arrives — this should cancel the previous fallback timer
    runtime.getWindowBuffer.mockReturnValue('new prompt content');
    await messageCallback('claude', '1', 'myapp', 'ch-1', 'msg-2', undefined);

    // Advance past the old fallback time (3s from original message)
    await vi.advanceTimersByTimeAsync(1000);

    // The old fallback should NOT have fired
    // The NEW fallback's first check fires at 3s from the second message
    await vi.advanceTimersByTimeAsync(2000); // total 5s from msg-2

    // Second check of new fallback
    await vi.advanceTimersByTimeAsync(2000);

    // Should see the new buffer content, not the old /model menu
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('new prompt content'),
    );
  });

  it('does not fire fallback after timer is cancelled by new message', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Advance 2.5s
    await vi.advanceTimersByTimeAsync(2500);

    // Stop hook fires for the second message, clearing pending
    runtime.getWindowBuffer.mockReturnValue('idle screen');
    await messageCallback('claude', '1', 'myapp', 'ch-1', 'msg-2', undefined);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    // Advance past all timers
    await vi.advanceTimersByTimeAsync(10000);

    // Neither the old nor new fallback should have sent anything
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── No pending (no messageId) ───────────────────────────────────

  it('does not fire fallback when message has no messageId', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);

    // Send message with no messageId — no pending is tracked
    await messageCallback('claude', '/model', 'myapp', 'ch-1', undefined, undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // Fallback fires but hasPending returns false → no send
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── Empty / error conditions ────────────────────────────────────

  it('does not send when buffer is empty', async () => {
    runtime.getWindowBuffer.mockReturnValue('');

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles getWindowBuffer throwing gracefully', async () => {
    runtime.getWindowBuffer.mockImplementation(() => {
      throw new Error('window not found');
    });

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Should not throw
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles sendToChannel failure in fallback gracefully', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);
    messaging.sendToChannel.mockRejectedValueOnce(new Error('Slack API error'));

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Should not throw even when sendToChannel rejects
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // sendToChannel was called but failed — the error is swallowed
    expect(messaging.sendToChannel).toHaveBeenCalled();
  });

  it('does not fallback when runtime has no getWindowBuffer', async () => {
    const bareRuntime = {
      sendKeysToWindow: vi.fn(),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      // no getWindowBuffer or getWindowFrame
    } as any;

    const r = new BridgeMessageRouter({
      messaging,
      runtime: bareRuntime,
      stateManager,
      pendingTracker,
      sanitizeInput: (content: string) => content.trim() || null,
    });
    r.register();
    const cb = messaging.onMessage.mock.calls[1][0];

    await cb('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── Pty runtime (getWindowFrame) ────────────────────────────────

  it('uses getWindowFrame when available (pty runtime)', async () => {
    const styledFrame = {
      cols: 80,
      rows: 24,
      lines: [
        { segments: [{ text: 'Select model' }] },
        { segments: [{ text: '  1. Default' }] },
        { segments: [{ text: '' }] },
      ],
      cursorRow: 0,
      cursorCol: 0,
    };

    runtime.getWindowFrame = vi.fn().mockReturnValue(styledFrame);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(runtime.getWindowFrame).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  it('falls back to getWindowBuffer when getWindowFrame throws', async () => {
    runtime.getWindowFrame = vi.fn().mockImplementation(() => {
      throw new Error('screen not ready');
    });
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(runtime.getWindowFrame).toHaveBeenCalled();
    expect(runtime.getWindowBuffer).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  it('falls back to getWindowBuffer when getWindowFrame returns null', async () => {
    runtime.getWindowFrame = vi.fn().mockReturnValue(null);
    runtime.getWindowBuffer.mockReturnValue(HELP_OUTPUT);

    await messageCallback('claude', '/help', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Available commands'),
    );
  });

  it('concatenates multiple segments in pty frame lines', async () => {
    const styledFrame = {
      cols: 80,
      rows: 24,
      lines: [
        { segments: [{ text: '  1. ' }, { text: 'Default' }, { text: ' (recommended)' }] },
        { segments: [{ text: '  2. Sonnet' }] },
        { segments: [{ text: '' }] },
      ],
      cursorRow: 0,
      cursorCol: 0,
    };

    runtime.getWindowFrame = vi.fn().mockReturnValue(styledFrame);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('  1. Default (recommended)'),
    );
  });

  // ── Multi-instance isolation ────────────────────────────────────

  it('maintains separate fallback timers per instance', async () => {
    stateManager.getProject.mockReturnValue(createMultiInstanceProject());

    let instance1Buffer = '/model menu instance 1';
    let instance2Buffer = '/help output instance 2';

    runtime.getWindowBuffer.mockImplementation((_session: string, windowName: string) => {
      if (windowName === 'myapp-claude') return instance1Buffer;
      if (windowName === 'myapp-claude-2') return instance2Buffer;
      return '';
    });

    // Send /model to instance 1
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Send /help to instance 2
    await messageCallback('claude', '/help', 'myapp', 'ch-2', 'msg-2', undefined);

    // Advance past both fallback timers
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // Both instances should have sent their buffer content
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('instance 1'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-2',
      expect.stringContaining('instance 2'),
    );
  });

  it('cancelling one instance fallback does not affect another', async () => {
    stateManager.getProject.mockReturnValue(createMultiInstanceProject());

    runtime.getWindowBuffer.mockImplementation((_session: string, windowName: string) => {
      if (windowName === 'myapp-claude') return MODEL_MENU;
      if (windowName === 'myapp-claude-2') return HELP_OUTPUT;
      return '';
    });

    // Send to instance 1
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);
    // Send to instance 2
    await messageCallback('claude', '/help', 'myapp', 'ch-2', 'msg-2', undefined);

    // Resolve instance 1 via Stop hook before fallback
    await vi.advanceTimersByTimeAsync(2000);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    // Advance past fallback timers
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    // Instance 1 should NOT send (Stop hook resolved it)
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
    // Instance 2 should still send via fallback
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-2',
      expect.stringContaining('Available commands'),
    );
  });

  // ── ANSI stripping ──────────────────────────────────────────────

  it('strips ANSI escape codes from buffer output', async () => {
    const ansiBuffer = '\x1b[1m\x1b[36mSelect model\x1b[0m\n  1. Default\n';
    runtime.getWindowBuffer.mockReturnValue(ansiBuffer);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sentText = messaging.sendToChannel.mock.calls[0][1];
    expect(sentText).not.toContain('\x1b');
    expect(sentText).toContain('Select model');
    expect(sentText).toContain('1. Default');
  });

  // ── Various interactive commands ────────────────────────────────

  it('handles /help command output', async () => {
    runtime.getWindowBuffer.mockReturnValue(HELP_OUTPUT);

    await messageCallback('claude', '/help', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Available commands'),
    );
  });

  // ── Submit delay (typeKeysToWindow + Enter) ───────────────────

  it('submits claude messages via typeKeysToWindow + sendEnterToWindow', async () => {
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', '/model', 'claude',
    );
    expect(runtime.sendEnterToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', 'claude',
    );
    // sendKeysToWindow should NOT be used (no delay → slash commands not recognised)
    expect(runtime.sendKeysToWindow).not.toHaveBeenCalled();
  });

  it('respects DISCODE_SUBMIT_DELAY_MS env var for claude agents', async () => {
    process.env.DISCODE_SUBMIT_DELAY_MS = '200';

    // Don't await — the sleep(200ms) inside submitToAgent will block
    const promise = messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    // Advance past the submit delay + all fallback timers
    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    // Both type and enter should have been called with 200ms delay between them
    expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', '/model', 'claude',
    );
    expect(runtime.sendEnterToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', 'claude',
    );

    // Verify type was called before enter
    const typeOrder = runtime.typeKeysToWindow.mock.invocationCallOrder[0];
    const enterOrder = runtime.sendEnterToWindow.mock.invocationCallOrder[0];
    expect(typeOrder).toBeLessThan(enterOrder);
  });

  it('trims trailing whitespace from prompt before typing', async () => {
    await messageCallback('claude', '  /model  ', 'myapp', 'ch-1', 'msg-1', undefined);

    // sanitizeInput trims both sides, then submitToAgent trims the end
    expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', '/model', 'claude',
    );
  });

  // ── Command block extraction ──────────────────────────────────

  it('extracts only the last command block from full screen buffer', async () => {
    const fullScreen = [
      '╭─── Claude Code v2.1.45 ───╮',
      '│     Welcome back gui!     │',
      '╰───────────────────────────╯',
      '',
      '❯ /model',
      '  ⎿  Set model to opus',
      '',
      '❯ hello',
      '',
      '● Hello!',
      '',
      '❯ /model',
      '───────────────────────────────',
      ' Select model',
      '',
      '   1. Default (recommended)',
      ' ❯ 4. opus ✔',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(fullScreen);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    // Should NOT contain the welcome banner or previous conversation
    expect(sent).not.toContain('Welcome back');
    expect(sent).not.toContain('Hello!');
    // Should start with the last ❯ /model block
    expect(sent).toContain('❯ /model');
    expect(sent).toContain('Select model');
    expect(sent).toContain('Enter to confirm');
  });

  it('sends full buffer when no prompt marker found', async () => {
    const noPrompt = [
      'Some output without prompt markers',
      'Another line of output',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(noPrompt);

    await messageCallback('claude', 'test', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    expect(sent).toContain('Some output without prompt markers');
    expect(sent).toContain('Another line of output');
  });

  it('does not confuse menu selection marker with prompt marker', async () => {
    // The " ❯ 4." inside the menu has leading spaces — should NOT be treated as a prompt
    const menuOnly = [
      ' Select model',
      '',
      '   1. Default (recommended)',
      ' ❯ 4. opus ✔',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(menuOnly);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    // No prompt marker at column 0 → entire buffer is sent
    expect(sent).toContain('Select model');
    expect(sent).toContain('❯ 4. opus');
    expect(sent).toContain('Enter to confirm');
  });

  it('strips trailing blank lines from extracted command block', async () => {
    const withTrailing = [
      '❯ /help',
      'Available commands:',
      '  /model   - Switch models',
      '',
      '',
      '',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(withTrailing);

    await messageCallback('claude', '/help', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    // Trailing blanks should be stripped — content ends at last non-empty line
    expect(sent).toMatch(/Switch models\n```$/);
  });

  it('extracts command block from real-world /model screen capture', async () => {
    const realCapture = [
      '╭─── Claude Code v2.1.45 ─────────────────────────────────────────╮',
      '│                           │ Tips for getting started            │',
      '│     Welcome back gui!     │ Run /init to create a CLAUDE.md    │',
      '│             ✻             │                                     │',
      '│   Opus 4.6 · Claude Max   │                                     │',
      '╰─────────────────────────────────────────────────────────────────╯',
      '',
      '❯ /model',
      '  ⎿  Set model to opus (claude-opus-4-6)',
      '',
      '❯ ㅎㅇ',
      '',
      '● ㅎㅇ! 무엇을 도와드릴까요?',
      '',
      '❯ /model',
      '──────────────────────────────────────────────────────────',
      ' Select model',
      ' Switch between Claude models.',
      '',
      '   1. Default (recommended)  Opus 4.6',
      '   2. Sonnet                 Sonnet 4.6',
      '   3. Haiku                  Haiku 4.5',
      ' ❯ 4. opus ✔                 Custom model',
      '',
      ' ▌▌▌ High effort (default) ← → to adjust',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(realCapture);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    // Should not contain banner, previous /model result, or conversation
    expect(sent).not.toContain('Welcome back');
    expect(sent).not.toContain('Set model to opus');
    expect(sent).not.toContain('무엇을 도와드릴까요');
    // Should contain the menu from the last prompt
    expect(sent).toContain('❯ /model');
    expect(sent).toContain('Select model');
    expect(sent).toContain('opus ✔');
    expect(sent).toContain('High effort');
    expect(sent).toContain('Enter to confirm');
  });

  it('extracts single prompt line without trailing output', async () => {
    const promptOnly = [
      '╭─── Claude Code ───╮',
      '╰───────────────────╯',
      '',
      '❯ ',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(promptOnly);

    await messageCallback('claude', 'test', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // Buffer is stable but extracted block is just "❯ " which trims to empty
    // The fallback should still send it since the extraction result is non-empty ("❯ ")
    const sent = messaging.sendToChannel.mock.calls[0]?.[1];
    if (sent) {
      expect(sent).not.toContain('Claude Code');
    }
  });
});
