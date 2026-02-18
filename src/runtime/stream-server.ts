import { createServer, type Server, type Socket } from 'net';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { AgentRuntime } from './interface.js';
import type { TerminalStyledLine } from './vt-screen.js';
import { renderTerminalSnapshot } from '../capture/parser.js';

type RuntimeStreamClientState = {
  socket: Socket;
  buffer: string;
  windowId?: string;
  cols: number;
  rows: number;
  seq: number;
  lastBufferLength: number;
  lastSnapshot: string;
  lastLines: string[];
  lastEmitAt: number;
  windowMissingNotified: boolean;
  lastStyledSignature: string;
  lastStyledLines: TerminalStyledLine[];
};

type RuntimeStreamServerOptions = {
  tickMs?: number;
  minEmitIntervalMs?: number;
  enablePatchDiff?: boolean;
  patchThresholdRatio?: number;
};

type RuntimeStreamInbound =
  | { type: 'hello'; clientId?: string; version?: string }
  | { type: 'subscribe'; windowId: string; cols?: number; rows?: number }
  | { type: 'focus'; windowId: string }
  | { type: 'input'; windowId: string; bytesBase64: string }
  | { type: 'resize'; windowId: string; cols: number; rows: number };

export class RuntimeStreamServer {
  private server?: Server;
  private clients = new Set<RuntimeStreamClientState>();
  private pollTimer?: NodeJS.Timeout;
  private tickMs: number;
  private minEmitIntervalMs: number;
  private enablePatchDiff: boolean;
  private patchThresholdRatio: number;

  constructor(
    private runtime: AgentRuntime,
    private socketPath: string = getDefaultRuntimeSocketPath(),
    options?: RuntimeStreamServerOptions,
  ) {
    this.tickMs = clampNumber(options?.tickMs, 16, 200, 33);
    this.minEmitIntervalMs = clampNumber(options?.minEmitIntervalMs, 16, 250, 50);
    this.enablePatchDiff = options?.enablePatchDiff ?? process.env.DISCODE_STREAM_PATCH_DIFF === '1';
    this.patchThresholdRatio = Math.max(0.05, Math.min(0.95, options?.patchThresholdRatio ?? 0.55));
  }

  start(): void {
    this.cleanupSocketPath();

    this.server = createServer((socket) => {
      const state: RuntimeStreamClientState = {
        socket,
        buffer: '',
        cols: 120,
        rows: 40,
        seq: 0,
        lastBufferLength: -1,
        lastSnapshot: '',
        lastLines: [],
        lastEmitAt: 0,
        windowMissingNotified: false,
        lastStyledSignature: '',
        lastStyledLines: [],
      };
      this.clients.add(state);

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        state.buffer += chunk;
        let idx = state.buffer.indexOf('\n');
        while (idx >= 0) {
          const line = state.buffer.slice(0, idx).trim();
          state.buffer = state.buffer.slice(idx + 1);
          if (line.length > 0) {
            this.handleMessage(state, line);
          }
          idx = state.buffer.indexOf('\n');
        }
      });

      socket.on('close', () => {
        this.clients.delete(state);
      });

      socket.on('error', () => {
        this.clients.delete(state);
      });
    });

    this.server.listen(this.socketPath);
    this.pollTimer = setInterval(() => this.flushFrames(), this.tickMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();

    this.server?.close();
    this.server = undefined;
    this.cleanupSocketPath();
  }

  private handleMessage(client: RuntimeStreamClientState, line: string): void {
    let message: RuntimeStreamInbound;
    try {
      message = JSON.parse(line) as RuntimeStreamInbound;
    } catch {
      this.send(client, { type: 'error', code: 'bad_json', message: 'Invalid JSON' });
      return;
    }

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.send(client, { type: 'error', code: 'bad_message', message: 'Invalid message' });
      return;
    }

    switch (message.type) {
      case 'hello':
        this.send(client, { type: 'hello', ok: true });
        return;
      case 'subscribe': {
        if (!message.windowId || typeof message.windowId !== 'string') {
          this.send(client, { type: 'error', code: 'bad_subscribe', message: 'Missing windowId' });
          return;
        }
        client.windowId = message.windowId;
        client.cols = clampNumber(message.cols, 30, 240, 120);
        client.rows = clampNumber(message.rows, 10, 120, 40);
        client.lastBufferLength = -1;
        client.lastSnapshot = '';
        client.lastLines = [];
        client.windowMissingNotified = false;
        client.lastStyledSignature = '';
        client.lastStyledLines = [];
        this.flushClientFrame(client);
        return;
      }
      case 'focus': {
        if (!message.windowId || typeof message.windowId !== 'string') {
          this.send(client, { type: 'error', code: 'bad_focus', message: 'Missing windowId' });
          return;
        }
        client.windowId = message.windowId;
        client.lastBufferLength = -1;
        client.lastSnapshot = '';
        client.lastLines = [];
        client.windowMissingNotified = false;
        client.lastStyledSignature = '';
        client.lastStyledLines = [];
        this.send(client, { type: 'focus', ok: true, windowId: message.windowId });
        this.flushClientFrame(client);
        return;
      }
      case 'input': {
        const parsed = parseWindowId(message.windowId);
        if (!parsed) {
          this.send(client, { type: 'error', code: 'bad_input', message: 'Invalid windowId' });
          return;
        }
        const bytes = decodeBase64(message.bytesBase64);
        if (!bytes) {
          this.send(client, { type: 'error', code: 'bad_input', message: 'Invalid bytesBase64' });
          return;
        }
        if (!this.runtime.windowExists(parsed.sessionName, parsed.windowName)) {
          this.send(client, { type: 'error', code: 'window_not_found', message: 'Window not found' });
          return;
        }
        this.runtime.typeKeysToWindow(parsed.sessionName, parsed.windowName, bytes.toString('latin1'));
        this.send(client, { type: 'input', ok: true, windowId: message.windowId });
        return;
      }
      case 'resize': {
        if (!message.windowId || typeof message.windowId !== 'string') return;
        client.windowId = message.windowId;
        client.cols = clampNumber(message.cols, 30, 240, client.cols);
        client.rows = clampNumber(message.rows, 10, 120, client.rows);
        const parsed = parseWindowId(message.windowId);
        if (parsed) {
          this.runtime.resizeWindow?.(parsed.sessionName, parsed.windowName, client.cols, client.rows);
        }
        client.lastSnapshot = '';
        client.lastLines = [];
        client.windowMissingNotified = false;
        client.lastStyledSignature = '';
        client.lastStyledLines = [];
        this.flushClientFrame(client);
        return;
      }
      default:
        this.send(client, { type: 'error', code: 'unknown_type', message: 'Unknown message type' });
    }
  }

  private flushFrames(): void {
    for (const client of this.clients) {
      this.flushClientFrame(client);
    }
  }

  private flushClientFrame(client: RuntimeStreamClientState): void {
    if (!client.windowId) return;
    if (!this.runtime.getWindowBuffer) return;

    const parsed = parseWindowId(client.windowId);
    if (!parsed) return;
    if (!this.runtime.windowExists(parsed.sessionName, parsed.windowName)) {
      if (!client.windowMissingNotified) {
        this.send(client, {
          type: 'window-exit',
          windowId: client.windowId,
          code: null,
          signal: 'missing',
        });
        client.windowMissingNotified = true;
      }
      return;
    }
    client.windowMissingNotified = false;

    const raw = this.runtime.getWindowBuffer(parsed.sessionName, parsed.windowName);
    if (raw.length === client.lastBufferLength) return;

    const now = Date.now();
    // Coalesce bursts to reduce CPU/load and improve input responsiveness.
    if (client.lastBufferLength >= 0 && now - client.lastEmitAt < this.minEmitIntervalMs) {
      return;
    }

    const styledFrame = this.runtime.getWindowFrame?.(parsed.sessionName, parsed.windowName, client.cols, client.rows);
    if (styledFrame) {
      const styledLines = cloneStyledLines(styledFrame.lines);
      const signature = buildStyledSignature(styledLines);
      if (signature !== client.lastStyledSignature) {
        client.lastStyledSignature = signature;
        client.lastBufferLength = raw.length;
        client.lastEmitAt = now;
        client.seq += 1;

        const patch = this.enablePatchDiff
          ? buildStyledPatch(client.lastStyledLines, styledLines)
          : null;
        const usePatch = !!(
          this.enablePatchDiff
          && client.lastStyledLines.length > 0
          && patch
          && patch.ops.length > 0
          && patch.ops.length <= Math.ceil(styledLines.length * this.patchThresholdRatio)
        );

        if (usePatch && patch) {
          this.send(client, {
            type: 'patch-styled',
            windowId: client.windowId,
            seq: client.seq,
            lineCount: styledLines.length,
            ops: patch.ops,
            cursorRow: styledFrame.cursorRow,
            cursorCol: styledFrame.cursorCol,
          });
        } else {
          this.send(client, {
            type: 'frame-styled',
            windowId: client.windowId,
            seq: client.seq,
            lines: styledLines,
            cursorRow: styledFrame.cursorRow,
            cursorCol: styledFrame.cursorCol,
          });
        }

        client.lastStyledLines = styledLines;
      }
      return;
    }

    const snapshot = renderTerminalSnapshot(raw, {
      width: client.cols,
      height: client.rows,
    });

    if (snapshot === client.lastSnapshot && raw.length >= 0) {
      client.lastBufferLength = raw.length;
      return;
    }

    client.lastBufferLength = raw.length;
    const lines = snapshot.split('\n');
    client.lastSnapshot = snapshot;
    client.seq += 1;
    client.lastEmitAt = now;

    const patch = this.enablePatchDiff ? buildLinePatch(client.lastLines, lines) : null;
    const usePatch = !!(
      this.enablePatchDiff
      && client.lastLines.length > 0
      && patch
      && patch.ops.length > 0
      && patch.ops.length <= Math.ceil(lines.length * this.patchThresholdRatio)
    );

    if (usePatch && patch) {
      this.send(client, {
        type: 'patch',
        windowId: client.windowId,
        seq: client.seq,
        lineCount: lines.length,
        ops: patch.ops,
      });
    } else {
      this.send(client, {
        type: 'frame',
        windowId: client.windowId,
        seq: client.seq,
        lines,
      });
    }
    client.lastLines = lines;
  }

  private send(client: RuntimeStreamClientState, payload: unknown): void {
    try {
      client.socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  private cleanupSocketPath(): void {
    if (process.platform === 'win32') return;
    try {
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
      const dir = dirname(this.socketPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch {
      // best-effort cleanup
    }
  }
}

export function getDefaultRuntimeSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\discode-runtime';
  }
  return join(homedir(), '.discode', 'runtime.sock');
}

function parseWindowId(windowId: string): { sessionName: string; windowName: string } | null {
  const idx = windowId.indexOf(':');
  if (idx <= 0 || idx >= windowId.length - 1) return null;
  return {
    sessionName: windowId.slice(0, idx),
    windowName: windowId.slice(idx + 1),
  };
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function decodeBase64(value: string): Buffer | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function buildStyledSignature(lines: TerminalStyledLine[]): string {
  return lines
    .map((line) => line.segments.map((seg) => `${seg.text}\u001f${seg.fg || ''}\u001f${seg.bg || ''}\u001f${seg.bold ? '1' : '0'}\u001f${seg.italic ? '1' : '0'}\u001f${seg.underline ? '1' : '0'}`).join('\u001e'))
    .join('\u001d');
}

function buildLinePatch(prev: string[], next: string[]): { ops: Array<{ index: number; line: string }> } | null {
  const max = Math.max(prev.length, next.length);
  const ops: Array<{ index: number; line: string }> = [];
  for (let i = 0; i < max; i += 1) {
    const before = prev[i] || '';
    const after = next[i] || '';
    if (before !== after) {
      ops.push({ index: i, line: after });
    }
  }
  if (ops.length === 0 && prev.length === next.length) return null;
  return { ops };
}

function buildStyledPatch(prev: TerminalStyledLine[], next: TerminalStyledLine[]): { ops: Array<{ index: number; line: TerminalStyledLine }> } | null {
  const max = Math.max(prev.length, next.length);
  const ops: Array<{ index: number; line: TerminalStyledLine }> = [];
  for (let i = 0; i < max; i += 1) {
    const before = prev[i] || { segments: [] };
    const after = next[i] || { segments: [] };
    if (buildStyledSignature([before]) !== buildStyledSignature([after])) {
      ops.push({ index: i, line: cloneStyledLine(after) });
    }
  }
  if (ops.length === 0 && prev.length === next.length) return null;
  return { ops };
}

function cloneStyledLines(lines: TerminalStyledLine[]): TerminalStyledLine[] {
  return lines.map(cloneStyledLine);
}

function cloneStyledLine(line: TerminalStyledLine): TerminalStyledLine {
  return {
    segments: line.segments.map((seg) => ({
      text: seg.text,
      fg: seg.fg,
      bg: seg.bg,
      bold: seg.bold,
      italic: seg.italic,
      underline: seg.underline,
    })),
  };
}
