import type { AgentRuntime } from './interface.js';

export type RuntimeWindowView = {
  windowId: string;
  sessionName: string;
  windowName: string;
  status?: string;
  pid?: number;
  startedAt?: Date;
  exitedAt?: Date;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export class RuntimeControlPlane {
  private activeWindowId?: string;

  constructor(private runtime?: AgentRuntime) {}

  isEnabled(): boolean {
    return !!this.runtime?.listWindows && !!this.runtime?.getWindowBuffer;
  }

  listWindows(): { activeWindowId?: string; windows: RuntimeWindowView[] } {
    if (!this.runtime?.listWindows) {
      return { activeWindowId: undefined, windows: [] };
    }

    const windows = this.runtime.listWindows().map((window) => ({
      windowId: this.toWindowId(window.sessionName, window.windowName),
      sessionName: window.sessionName,
      windowName: window.windowName,
      status: window.status,
      pid: window.pid,
      startedAt: window.startedAt,
      exitedAt: window.exitedAt,
      exitCode: window.exitCode,
      signal: window.signal,
    }));

    if (windows.length === 0) {
      this.activeWindowId = undefined;
      return { activeWindowId: undefined, windows };
    }

    if (!this.activeWindowId || !windows.some((window) => window.windowId === this.activeWindowId)) {
      this.activeWindowId = windows[0].windowId;
    }

    return {
      activeWindowId: this.activeWindowId,
      windows,
    };
  }

  focusWindow(windowId: string): boolean {
    if (!this.runtime) return false;
    const parsed = this.parseWindowId(windowId);
    if (!parsed) return false;
    if (!this.runtime.windowExists(parsed.sessionName, parsed.windowName)) return false;

    this.activeWindowId = this.toWindowId(parsed.sessionName, parsed.windowName);
    return true;
  }

  getActiveWindowId(): string | undefined {
    return this.activeWindowId;
  }

  sendInput(params: {
    windowId?: string;
    text?: string;
    submit?: boolean;
  }): { windowId: string } {
    if (!this.runtime) {
      throw new Error('Runtime control unavailable');
    }

    const targetWindowId = params.windowId || this.activeWindowId;
    if (!targetWindowId) {
      throw new Error('Missing windowId');
    }

    const parsed = this.parseWindowId(targetWindowId);
    if (!parsed) {
      throw new Error('Invalid windowId');
    }

    if (!this.runtime.windowExists(parsed.sessionName, parsed.windowName)) {
      throw new Error('Window not found');
    }

    const text = typeof params.text === 'string' ? params.text : '';
    const submit = params.submit !== false;

    if (text.length > 0) {
      this.runtime.typeKeysToWindow(parsed.sessionName, parsed.windowName, text);
    }
    if (submit) {
      this.runtime.sendEnterToWindow(parsed.sessionName, parsed.windowName);
    }

    this.activeWindowId = this.toWindowId(parsed.sessionName, parsed.windowName);
    return { windowId: this.activeWindowId };
  }

  getBuffer(windowId: string, since: number = 0): {
    windowId: string;
    since: number;
    next: number;
    chunk: string;
  } {
    if (!this.runtime?.getWindowBuffer) {
      throw new Error('Runtime control unavailable');
    }

    const parsed = this.parseWindowId(windowId);
    if (!parsed) {
      throw new Error('Invalid windowId');
    }

    if (!this.runtime.windowExists(parsed.sessionName, parsed.windowName)) {
      throw new Error('Window not found');
    }

    const raw = this.runtime.getWindowBuffer(parsed.sessionName, parsed.windowName);
    const safeSince = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const start = Math.min(safeSince, raw.length);
    const chunk = raw.slice(start);

    return {
      windowId: this.toWindowId(parsed.sessionName, parsed.windowName),
      since: start,
      next: raw.length,
      chunk,
    };
  }

  stopWindow(windowId: string): boolean {
    if (!this.runtime?.stopWindow) {
      throw new Error('Runtime stop unavailable');
    }

    const parsed = this.parseWindowId(windowId);
    if (!parsed) {
      throw new Error('Invalid windowId');
    }

    if (!this.runtime.windowExists(parsed.sessionName, parsed.windowName)) {
      throw new Error('Window not found');
    }

    const stopped = this.runtime.stopWindow(parsed.sessionName, parsed.windowName);
    if (!stopped) {
      throw new Error('Failed to stop window');
    }
    return true;
  }

  private toWindowId(sessionName: string, windowName: string): string {
    return `${sessionName}:${windowName}`;
  }

  private parseWindowId(windowId: string): { sessionName: string; windowName: string } | null {
    if (!windowId || typeof windowId !== 'string') return null;
    const idx = windowId.indexOf(':');
    if (idx <= 0 || idx >= windowId.length - 1) return null;

    const sessionName = windowId.slice(0, idx);
    const windowName = windowId.slice(idx + 1);
    if (!sessionName || !windowName) return null;

    return { sessionName, windowName };
  }
}
