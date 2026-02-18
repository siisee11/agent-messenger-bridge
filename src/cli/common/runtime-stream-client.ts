import { createConnection, type Socket } from 'net';
import { join } from 'path';
import { homedir } from 'os';
import type { TerminalStyledLine } from '../../runtime/vt-screen.js';

type FrameMessage = {
  type: 'frame';
  windowId: string;
  seq: number;
  lines: string[];
};

type PatchMessage = {
  type: 'patch';
  windowId: string;
  seq: number;
  lineCount: number;
  ops: Array<{ index: number; line: string }>;
};

type FrameStyledMessage = {
  type: 'frame-styled';
  windowId: string;
  seq: number;
  lines: TerminalStyledLine[];
  cursorRow?: number;
  cursorCol?: number;
};

type PatchStyledMessage = {
  type: 'patch-styled';
  windowId: string;
  seq: number;
  lineCount: number;
  ops: Array<{ index: number; line: TerminalStyledLine }>;
  cursorRow?: number;
  cursorCol?: number;
};

type WindowExitMessage = {
  type: 'window-exit';
  windowId: string;
  code?: number | null;
  signal?: string | null;
};

type RuntimeStreamMessage =
  | FrameMessage
  | PatchMessage
  | FrameStyledMessage
  | PatchStyledMessage
  | WindowExitMessage
  | { type: 'hello'; ok: boolean }
  | { type: 'focus'; ok: boolean; windowId: string }
  | { type: 'input'; ok: boolean; windowId: string }
  | { type: 'error'; code: string; message: string };

type RuntimeStreamClientHandlers = {
  onFrame?: (frame: FrameMessage) => void;
  onPatch?: (patch: PatchMessage) => void;
  onFrameStyled?: (frame: FrameStyledMessage) => void;
  onPatchStyled?: (patch: PatchStyledMessage) => void;
  onWindowExit?: (event: WindowExitMessage) => void;
  onError?: (error: string) => void;
  onStateChange?: (state: 'connected' | 'disconnected') => void;
};

export class RuntimeStreamClient {
  private socket?: Socket;
  private readBuffer = '';
  private connected = false;

  constructor(
    private socketPath: string,
    private handlers: RuntimeStreamClientHandlers = {},
  ) {}

  async connect(timeoutMs: number = 1200): Promise<boolean> {
    if (this.connected) return true;

    return await new Promise<boolean>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve(ok);
      };

      const socket = createConnection(this.socketPath, () => {
        this.socket = socket;
        this.connected = true;
        this.handlers.onStateChange?.('connected');
        this.send({ type: 'hello', version: 1 });
        finish(true);
      });

      timer = setTimeout(() => {
        socket.destroy();
        finish(false);
      }, timeoutMs);

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        this.readBuffer += chunk;
        let idx = this.readBuffer.indexOf('\n');
        while (idx >= 0) {
          const line = this.readBuffer.slice(0, idx).trim();
          this.readBuffer = this.readBuffer.slice(idx + 1);
          if (line.length > 0) {
            this.handleLine(line);
          }
          idx = this.readBuffer.indexOf('\n');
        }
      });

      socket.on('error', () => {
        this.connected = false;
        this.socket = undefined;
        this.handlers.onStateChange?.('disconnected');
        this.handlers.onError?.('runtime stream socket error');
        finish(false);
      });

      socket.on('close', () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.connected = false;
        this.socket = undefined;
        this.handlers.onStateChange?.('disconnected');
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
    this.handlers.onStateChange?.('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribe(windowId: string, cols: number, rows: number): void {
    this.send({ type: 'subscribe', windowId, cols, rows });
  }

  focus(windowId: string): void {
    this.send({ type: 'focus', windowId });
  }

  input(windowId: string, bytes: Buffer): void {
    this.send({
      type: 'input',
      windowId,
      bytesBase64: bytes.toString('base64'),
    });
  }

  resize(windowId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', windowId, cols, rows });
  }

  private send(payload: unknown): void {
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.connected = false;
      this.socket = undefined;
    }
  }

  private handleLine(line: string): void {
    let msg: RuntimeStreamMessage;
    try {
      msg = JSON.parse(line) as RuntimeStreamMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    if (msg.type === 'frame') {
      this.handlers.onFrame?.(msg);
      return;
    }
    if (msg.type === 'patch') {
      this.handlers.onPatch?.(msg);
      return;
    }
    if (msg.type === 'frame-styled') {
      this.handlers.onFrameStyled?.(msg);
      return;
    }
    if (msg.type === 'patch-styled') {
      this.handlers.onPatchStyled?.(msg);
      return;
    }
    if (msg.type === 'window-exit') {
      this.handlers.onWindowExit?.(msg);
      return;
    }
    if (msg.type === 'error') {
      this.handlers.onError?.(`${msg.code}: ${msg.message}`);
    }
  }
}

export function getDefaultRuntimeSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\discode-runtime';
  }
  return join(homedir(), '.discode', 'runtime.sock');
}
