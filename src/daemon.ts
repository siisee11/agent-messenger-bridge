/**
 * Daemon manager for running bridge server in background
 * Single global daemon serves all projects on a fixed port
 */

import { spawn as cpSpawn } from 'child_process';
import { createConnection as netCreateConnection } from 'net';
import { existsSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IStorage, IProcessManager } from './types/interfaces.js';
import { FileStorage } from './infra/storage.js';

const DEFAULT_PORT = 18470;

class SystemProcessManager implements IProcessManager {
  spawn(command: string, args: string[], options: any) {
    return cpSpawn(command, args, options);
  }
  createConnection(options: { port: number; host: string }) {
    return netCreateConnection(options);
  }
  kill(pid: number, signal: string) {
    process.kill(pid, signal as any);
  }
}

export class DaemonManager {
  private storage: IStorage;
  private processManager: IProcessManager;
  private daemonDir: string;
  private port: number;

  constructor(storage?: IStorage, processManager?: IProcessManager, daemonDir?: string, port?: number) {
    this.storage = storage || new FileStorage();
    this.processManager = processManager || new SystemProcessManager();
    this.daemonDir = daemonDir || join(homedir(), '.discode');
    this.port = port || DEFAULT_PORT;
  }

  /**
   * Get the fixed daemon port
   */
  getPort(): number {
    return this.port;
  }

  private pidFile(): string {
    return join(this.daemonDir, 'daemon.pid');
  }

  private logFile(): string {
    return join(this.daemonDir, 'daemon.log');
  }

  /**
   * Check if daemon is running on the default port
   */
  isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const conn = this.processManager.createConnection({ port: this.port, host: '127.0.0.1' });
      conn.on('connect', () => {
        conn.destroy();
        resolve(true);
      });
      conn.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Start the global bridge daemon
   */
  startDaemon(entryPoint: string): number {
    if (!existsSync(this.daemonDir)) {
      mkdirSync(this.daemonDir, { recursive: true });
    }

    const logFile = this.logFile();
    const pidFile = this.pidFile();

    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');

    // Use caffeinate on macOS to prevent sleep while daemon is running.
    // Prefer Node for built JS entrypoints (node-pty compatibility),
    // fallback to Bun for TS source entrypoints.
    const isMac = process.platform === 'darwin';
    const isTsEntry = /\.ts$/i.test(entryPoint);
    const nodeExec = /node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
    const runtimeCommand = isTsEntry ? 'bun' : nodeExec;
    const command = isMac ? 'caffeinate' : runtimeCommand;
    const args = isMac ? ['-ims', runtimeCommand, entryPoint] : [entryPoint];

    const child = this.processManager.spawn(command, args, {
      detached: true,
      stdio: ['ignore', out, err],
      env: {
        ...process.env,
        HOOK_SERVER_PORT: String(this.port),
      },
    });

    child.unref();

    const pid = child.pid;
    if (!pid) {
      throw new Error('Failed to start daemon: no PID assigned');
    }
    this.storage.writeFile(pidFile, String(pid));

    return pid;
  }

  /**
   * Stop the global daemon
   */
  stopDaemon(): boolean {
    const pidFile = this.pidFile();

    if (!this.storage.exists(pidFile)) {
      return false;
    }

    try {
      const pid = parseInt(this.storage.readFile(pidFile, 'utf-8').trim(), 10);
      // Kill process group to ensure child processes (e.g., node under caffeinate) are also terminated
      try {
        this.processManager.kill(-pid, 'SIGTERM');
      } catch {
        // Fallback to killing just the process
        this.processManager.kill(pid, 'SIGTERM');
      }
      this.storage.unlink(pidFile);
      return true;
    } catch {
      try { this.storage.unlink(pidFile); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * Wait for the daemon to start listening
   */
  async waitForReady(timeoutMs: number = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  getLogFile(): string {
    return this.logFile();
  }

  getPidFile(): string {
    return this.pidFile();
  }
}

export const defaultDaemonManager = new DaemonManager();
