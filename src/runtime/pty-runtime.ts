import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createRequire } from 'module';
import type { AgentRuntime } from './interface.js';

const require = createRequire(import.meta.url);

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ) => {
    pid: number;
    write: (data: string) => void;
    kill: (signal?: string) => void;
    onData: (cb: (data: string) => void) => void;
    onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => void;
  };
};

export type RuntimeWindowStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export type RuntimeWindowSnapshot = {
  sessionName: string;
  windowName: string;
  status: RuntimeWindowStatus;
  pid?: number;
  startedAt?: Date;
  exitedAt?: Date;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

type RuntimeWindowRecord = RuntimeWindowSnapshot & {
  process?: ChildProcessWithoutNullStreams;
  pty?: ReturnType<NodePtyModule['spawn']>;
  buffer: string;
};

type RuntimeSessionRecord = {
  env: Record<string, string>;
};

export type PtyRuntimeOptions = {
  shell?: string;
  maxBufferBytes?: number;
  useNodePty?: boolean;
};

export class PtyRuntime implements AgentRuntime {
  private shell: string;
  private maxBufferBytes: number;
  private useNodePty: boolean;
  private nodePty: NodePtyModule | null | undefined;
  private sessions = new Map<string, RuntimeSessionRecord>();
  private windows = new Map<string, RuntimeWindowRecord>();

  constructor(options?: PtyRuntimeOptions) {
    this.shell = options?.shell || process.env.SHELL || '/bin/bash';
    this.maxBufferBytes = options?.maxBufferBytes || 256 * 1024;
    this.useNodePty = options?.useNodePty !== false;
  }

  getOrCreateSession(projectName: string, firstWindowName?: string): string {
    const sessionName = projectName;
    this.ensureSession(sessionName);

    if (firstWindowName) {
      this.ensureWindowRecord(sessionName, firstWindowName);
    }

    return sessionName;
  }

  setSessionEnv(sessionName: string, key: string, value: string): void {
    const session = this.ensureSession(sessionName);
    session.env[key] = value;
  }

  windowExists(sessionName: string, windowName: string): boolean {
    return this.windows.has(this.windowKey(sessionName, windowName));
  }

  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    this.ensureSession(sessionName);
    const record = this.ensureWindowRecord(sessionName, windowName);

    if ((record.process || record.pty) && record.status === 'running') {
      return;
    }

    const env = {
      ...process.env,
      ...this.sessions.get(sessionName)?.env,
      TERM: process.env.TERM || 'xterm-256color',
      COLORTERM: process.env.COLORTERM || 'truecolor',
      COLUMNS: process.env.COLUMNS || '140',
      LINES: process.env.LINES || '40',
    };

    record.status = 'starting';
    record.startedAt = new Date();
    record.exitedAt = undefined;
    record.exitCode = undefined;
    record.signal = undefined;
    record.process = undefined;
    record.pty = undefined;

    const nodePty = this.getNodePty();
    if (nodePty) {
      try {
        const pty = nodePty.spawn(this.shell, ['-lc', agentCommand], {
          name: env.TERM,
          cols: parseInt(env.COLUMNS || '140', 10),
          rows: parseInt(env.LINES || '40', 10),
          cwd: process.cwd(),
          env,
        });
        record.pty = pty;
        record.pid = pty.pid;
        record.status = 'running';
        this.appendBuffer(record, `[runtime] process started (pid=${pty.pid ?? 'unknown'})\n`);

        pty.onData((data: string) => {
          this.appendBuffer(record, data);
        });

        pty.onExit((event) => {
          record.status = event.exitCode === 0 ? 'exited' : 'error';
          record.exitCode = event.exitCode;
          record.signal = null;
          record.exitedAt = new Date();
          record.pty = undefined;
          this.appendBuffer(record, `[runtime] process exited (code=${event.exitCode}, signal=${event.signal ?? 'null'})\n`);
        });
        return;
      } catch (error) {
        this.appendBuffer(record, `[runtime] pty spawn failed, fallback to child_process: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    const child = spawn(this.shell, ['-lc', agentCommand], {
      env,
      stdio: 'pipe',
    });

    record.process = child;
    record.pid = child.pid;

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.appendBuffer(record, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.appendBuffer(record, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    child.on('spawn', () => {
      record.status = 'running';
      this.appendBuffer(record, `[runtime] process started (pid=${child.pid ?? 'unknown'})\n`);
    });

    child.on('error', (error) => {
      record.status = 'error';
      record.exitedAt = new Date();
      record.process = undefined;
      this.appendBuffer(record, `[runtime] process error: ${error.message}\n`);
    });

    child.on('close', (code, signal) => {
      record.status = code === 0 ? 'exited' : 'error';
      record.exitCode = code;
      record.signal = signal;
      record.exitedAt = new Date();
      record.process = undefined;
      this.appendBuffer(record, `[runtime] process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`);
    });
  }

  sendKeysToWindow(sessionName: string, windowName: string, keys: string): void {
    this.typeKeysToWindow(sessionName, windowName, keys);
    this.sendEnterToWindow(sessionName, windowName);
  }

  typeKeysToWindow(sessionName: string, windowName: string, keys: string): void {
    const record = this.getRunningWindowRecord(sessionName, windowName);
    if (record.pty) {
      record.pty.write(keys);
      return;
    }
    record.process!.stdin.write(keys);
  }

  sendEnterToWindow(sessionName: string, windowName: string): void {
    const record = this.getRunningWindowRecord(sessionName, windowName);
    if (record.pty) {
      record.pty.write('\n');
      return;
    }
    record.process!.stdin.write('\n');
  }

  stopWindow(sessionName: string, windowName: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const record = this.windows.get(this.windowKey(sessionName, windowName));
    if (!record) return false;
    if (record.pty) {
      try {
        record.pty.kill(signal);
        return true;
      } catch {
        return false;
      }
    }
    if (!record.process) return false;
    return record.process.kill(signal);
  }

  listWindows(sessionName?: string): RuntimeWindowSnapshot[] {
    const items = [...this.windows.values()]
      .filter((item) => !sessionName || item.sessionName === sessionName)
      .map((item) => ({
        sessionName: item.sessionName,
        windowName: item.windowName,
        status: item.status,
        pid: item.pid,
        startedAt: item.startedAt,
        exitedAt: item.exitedAt,
        exitCode: item.exitCode,
        signal: item.signal,
      }));

    return items.sort((a, b) => {
      const bySession = a.sessionName.localeCompare(b.sessionName);
      if (bySession !== 0) return bySession;
      return a.windowName.localeCompare(b.windowName);
    });
  }

  getWindowBuffer(sessionName: string, windowName: string): string {
    const key = this.windowKey(sessionName, windowName);
    const record = this.windows.get(key);
    return record?.buffer || '';
  }

  dispose(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const record of this.windows.values()) {
      if (record.pty) {
        try {
          record.pty.kill(signal);
        } catch {
          // ignore
        }
      }
      if (record.process) {
        record.process.kill(signal);
      }
    }
  }

  private getNodePty(): NodePtyModule | null {
    if (!this.useNodePty) return null;
    if (this.nodePty !== undefined) return this.nodePty;
    try {
      this.nodePty = require('node-pty') as NodePtyModule;
    } catch {
      this.nodePty = null;
    }
    return this.nodePty;
  }

  private ensureSession(sessionName: string): RuntimeSessionRecord {
    const existing = this.sessions.get(sessionName);
    if (existing) return existing;

    const created: RuntimeSessionRecord = { env: {} };
    this.sessions.set(sessionName, created);
    return created;
  }

  private ensureWindowRecord(sessionName: string, windowName: string): RuntimeWindowRecord {
    const key = this.windowKey(sessionName, windowName);
    const existing = this.windows.get(key);
    if (existing) return existing;

    const created: RuntimeWindowRecord = {
      sessionName,
      windowName,
      status: 'idle',
      buffer: '',
    };
    this.windows.set(key, created);
    return created;
  }

  private getRunningWindowRecord(sessionName: string, windowName: string): RuntimeWindowRecord {
    const key = this.windowKey(sessionName, windowName);
    const record = this.windows.get(key);
    if (!record) {
      throw new Error(`Window not found: ${sessionName}:${windowName}`);
    }
    if ((!record.process && !record.pty) || record.status !== 'running') {
      throw new Error(`Window is not running: ${sessionName}:${windowName}`);
    }
    return record;
  }

  private appendBuffer(record: RuntimeWindowRecord, text: string): void {
    record.buffer += text;
    if (record.buffer.length > this.maxBufferBytes) {
      record.buffer = record.buffer.slice(record.buffer.length - this.maxBufferBytes);
    }
  }

  private windowKey(sessionName: string, windowName: string): string {
    return `${sessionName}:${windowName}`;
  }
}
