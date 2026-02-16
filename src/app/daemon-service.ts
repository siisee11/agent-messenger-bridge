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

  const entryPoint = resolve(import.meta.dirname, '../daemon-entry.js');
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
