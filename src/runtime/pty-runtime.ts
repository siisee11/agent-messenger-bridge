import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { AgentRuntime } from './interface.js';

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
  buffer: string;
};

type RuntimeSessionRecord = {
  env: Record<string, string>;
};

export type PtyRuntimeOptions = {
  shell?: string;
  maxBufferBytes?: number;
};

export class PtyRuntime implements AgentRuntime {
  private shell: string;
  private maxBufferBytes: number;
  private sessions = new Map<string, RuntimeSessionRecord>();
  private windows = new Map<string, RuntimeWindowRecord>();

  constructor(options?: PtyRuntimeOptions) {
    this.shell = options?.shell || process.env.SHELL || '/bin/bash';
    this.maxBufferBytes = options?.maxBufferBytes || 256 * 1024;
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

    if (record.process && record.status === 'running') {
      return;
    }

    const env = {
      ...process.env,
      ...this.sessions.get(sessionName)?.env,
    };

    record.status = 'starting';
    record.startedAt = new Date();
    record.exitedAt = undefined;
    record.exitCode = undefined;
    record.signal = undefined;

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
    record.process!.stdin.write(keys);
  }

  sendEnterToWindow(sessionName: string, windowName: string): void {
    const record = this.getRunningWindowRecord(sessionName, windowName);
    record.process!.stdin.write('\n');
  }

  stopWindow(sessionName: string, windowName: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const record = this.windows.get(this.windowKey(sessionName, windowName));
    if (!record?.process) return false;
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
      if (record.process) {
        record.process.kill(signal);
      }
    }
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
    if (!record.process || record.status !== 'running') {
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
