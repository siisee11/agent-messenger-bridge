import { existsSync } from 'fs';
import { resolve } from 'path';
import { defaultDaemonManager } from '../daemon.js';

export type EnsureDaemonRunningResult = {
  alreadyRunning: boolean;
  ready: boolean;
  port: number;
  logFile: string;
};

export async function ensureDaemonRunning(): Promise<EnsureDaemonRunningResult> {
  const port = defaultDaemonManager.getPort();
  const logFile = defaultDaemonManager.getLogFile();
  const running = await defaultDaemonManager.isRunning();

  if (running) {
    return {
      alreadyRunning: true,
      ready: true,
      port,
      logFile,
    };
  }

  const repoHints = [
    process.env.DISCODE_REPO,
    process.cwd(),
  ].filter((value): value is string => !!value && value.length > 0);

  const entryPointCandidates = [
    // Preferred: built JS daemon entry (Node runtime friendly, required for node-pty stability).
    ...repoHints.map((root) => resolve(root, 'dist/src/daemon-entry.js')),
    ...repoHints.map((root) => resolve(root, 'dist/daemon-entry.js')),
    // Relative candidates for packaged layouts.
    resolve(import.meta.dirname, '../src/daemon-entry.js'),
    resolve(import.meta.dirname, '../daemon-entry.js'),
    // Source layout fallback (requires Bun TS runtime).
    ...repoHints.map((root) => resolve(root, 'src/daemon-entry.ts')),
    resolve(import.meta.dirname, '../daemon-entry.ts'),
    resolve(import.meta.dirname, '../src/daemon-entry.ts'),
  ];
  const entryPoint =
    entryPointCandidates.find((candidate) => existsSync(candidate)) ?? entryPointCandidates[0];
  defaultDaemonManager.startDaemon(entryPoint);
  const ready = await defaultDaemonManager.waitForReady();

  return {
    alreadyRunning: false,
    ready,
    port,
    logFile,
  };
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  port: number;
  logFile: string;
  pidFile: string;
}> {
  const running = await defaultDaemonManager.isRunning();
  return {
    running,
    port: defaultDaemonManager.getPort(),
    logFile: defaultDaemonManager.getLogFile(),
    pidFile: defaultDaemonManager.getPidFile(),
  };
}

export function stopDaemon(): boolean {
  return defaultDaemonManager.stopDaemon();
}

export async function restartDaemonIfRunning(): Promise<{
  restarted: boolean;
  ready: boolean;
  port: number;
  logFile: string;
}> {
  const status = await getDaemonStatus();
  if (!status.running) {
    return {
      restarted: false,
      ready: false,
      port: status.port,
      logFile: status.logFile,
    };
  }

  const stopped = stopDaemon();
  if (!stopped) {
    return {
      restarted: false,
      ready: false,
      port: status.port,
      logFile: status.logFile,
    };
  }

  const result = await ensureDaemonRunning();
  return {
    restarted: true,
    ready: result.ready,
    port: result.port,
    logFile: result.logFile,
  };
}
