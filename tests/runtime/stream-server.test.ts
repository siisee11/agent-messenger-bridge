import { afterEach, describe, expect, it } from 'vitest';
import { createConnection } from 'net';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RuntimeStreamServer } from '../../src/runtime/stream-server.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';

type Cleanup = () => void;
const cleanups: Cleanup[] = [];

function registerCleanup(fn: Cleanup): void {
  cleanups.push(fn);
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch {
      // ignore cleanup errors
    }
  }
});

function createRuntimeMock(): AgentRuntime & { setMissing: (missing: boolean) => void; setBuffer: (value: string) => void } {
  let missing = false;
  let buffer = 'line-1\nline-2';

  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => !missing,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {},
    sendEnterToWindow: () => {},
    listWindows: () => [{ sessionName: 'bridge', windowName: 'demo-opencode', status: 'running' }],
    getWindowBuffer: () => buffer,
    stopWindow: () => true,
    resizeWindow: () => {},
    setMissing: (value: boolean) => {
      missing = value;
      if (value) buffer = '';
    },
    setBuffer: (value: string) => {
      buffer = value;
    },
  };
}

describe('RuntimeStreamServer', () => {
  it('sends frame on subscribe and window-exit when window disappears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-server-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const runtime = createRuntimeMock();
    const server = new RuntimeStreamServer(runtime, socketPath);
    server.start();
    registerCleanup(() => server.stop());

    await waitFor(() => existsSync(socketPath));

    const socket = createConnection(socketPath);
    registerCleanup(() => socket.destroy());

    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
    });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`${JSON.stringify({ type: 'subscribe', windowId: 'bridge:demo-opencode', cols: 100, rows: 30 })}\n`);

    await waitFor(() => raw.includes('"type":"frame"'));

    runtime.setMissing(true);
    await waitFor(() => raw.includes('"type":"window-exit"'));

    expect(raw.includes('"type":"frame"')).toBe(true);
    expect(raw.includes('"type":"window-exit"')).toBe(true);
  });

  it('emits patch messages when patch diff mode is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-server-patch-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const runtime = createRuntimeMock();
    const server = new RuntimeStreamServer(runtime, socketPath, {
      enablePatchDiff: true,
      minEmitIntervalMs: 16,
      tickMs: 16,
      patchThresholdRatio: 0.9,
    });
    server.start();
    registerCleanup(() => server.stop());

    await waitFor(() => existsSync(socketPath));

    const socket = createConnection(socketPath);
    registerCleanup(() => socket.destroy());

    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
    });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`${JSON.stringify({ type: 'subscribe', windowId: 'bridge:demo-opencode', cols: 100, rows: 30 })}\n`);
    await waitFor(() => raw.includes('"type":"frame"'));

    runtime.setBuffer('line-1\nline-2!');
    await waitFor(() => raw.includes('"type":"patch"'));

    expect(raw.includes('"type":"patch"')).toBe(true);
  });
});
