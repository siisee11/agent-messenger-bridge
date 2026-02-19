import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'net';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RuntimeStreamServer, getDefaultRuntimeSocketPath } from '../../src/runtime/stream-server.js';
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

  it('responds to hello message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-hello-'));
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
    socket.on('data', (chunk) => { raw += chunk; });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`${JSON.stringify({ type: 'hello' })}\n`);

    await waitFor(() => raw.includes('"type":"hello"'));
    const messages = raw.trim().split('\n').map(l => JSON.parse(l));
    const hello = messages.find((m: any) => m.type === 'hello');
    expect(hello).toEqual({ type: 'hello', ok: true });
  });

  it('responds to focus message and sends frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-focus-'));
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
    socket.on('data', (chunk) => { raw += chunk; });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    // First subscribe to set up a window
    socket.write(`${JSON.stringify({ type: 'subscribe', windowId: 'bridge:demo-opencode' })}\n`);
    await waitFor(() => raw.includes('"type":"frame"'));

    // Then focus on same window
    socket.write(`${JSON.stringify({ type: 'focus', windowId: 'bridge:demo-opencode' })}\n`);
    await waitFor(() => raw.includes('"type":"focus"'));

    const messages = raw.trim().split('\n').map(l => JSON.parse(l));
    const focus = messages.find((m: any) => m.type === 'focus');
    expect(focus).toEqual({ type: 'focus', ok: true, windowId: 'bridge:demo-opencode' });
  });

  it('handles input message and calls typeKeysToWindow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-input-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const runtime = createRuntimeMock();
    const typeKeysSpy = vi.fn();
    runtime.typeKeysToWindow = typeKeysSpy;
    const server = new RuntimeStreamServer(runtime, socketPath);
    server.start();
    registerCleanup(() => server.stop());

    await waitFor(() => existsSync(socketPath));

    const socket = createConnection(socketPath);
    registerCleanup(() => socket.destroy());

    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    const bytesBase64 = Buffer.from('hello').toString('base64');
    socket.write(`${JSON.stringify({ type: 'input', windowId: 'bridge:demo-opencode', bytesBase64 })}\n`);

    await waitFor(() => raw.includes('"type":"input"'));

    const messages = raw.trim().split('\n').map(l => JSON.parse(l));
    const input = messages.find((m: any) => m.type === 'input');
    expect(input).toEqual({ type: 'input', ok: true, windowId: 'bridge:demo-opencode' });
    expect(typeKeysSpy).toHaveBeenCalledWith('bridge', 'demo-opencode', 'hello');
  });

  it('handles resize message and calls resizeWindow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-resize-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const runtime = createRuntimeMock();
    const resizeSpy = vi.fn();
    runtime.resizeWindow = resizeSpy;
    const server = new RuntimeStreamServer(runtime, socketPath);
    server.start();
    registerCleanup(() => server.stop());

    await waitFor(() => existsSync(socketPath));

    const socket = createConnection(socketPath);
    registerCleanup(() => socket.destroy());

    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    // Subscribe first, then resize
    socket.write(`${JSON.stringify({ type: 'subscribe', windowId: 'bridge:demo-opencode', cols: 100, rows: 30 })}\n`);
    await waitFor(() => raw.includes('"type":"frame"'));

    // Change buffer so resize flush can emit a new frame
    runtime.setBuffer('line-1\nline-2\nline-3');
    socket.write(`${JSON.stringify({ type: 'resize', windowId: 'bridge:demo-opencode', cols: 80, rows: 24 })}\n`);

    // Resize triggers a new frame (buffer changed + lastSnapshot reset)
    await waitFor(() => {
      const frames = raw.trim().split('\n')
        .map(l => JSON.parse(l))
        .filter((m: any) => m.type === 'frame');
      return frames.length >= 2;
    });

    expect(resizeSpy).toHaveBeenCalledWith('bridge', 'demo-opencode', 80, 24);
  });

  it('returns error for invalid input windowId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-err-'));
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
    socket.on('data', (chunk) => { raw += chunk; });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    // windowId without colon is invalid
    socket.write(`${JSON.stringify({ type: 'input', windowId: 'no-colon', bytesBase64: 'aGVsbG8=' })}\n`);

    await waitFor(() => raw.includes('"type":"error"'));
    const messages = raw.trim().split('\n').map(l => JSON.parse(l));
    const err = messages.find((m: any) => m.type === 'error');
    expect(err?.code).toBe('bad_input');
  });

  it('returns error for bad JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-badjson-'));
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
    socket.on('data', (chunk) => { raw += chunk; });

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    socket.write('not valid json\n');

    await waitFor(() => raw.includes('"type":"error"'));
    const messages = raw.trim().split('\n').map(l => JSON.parse(l));
    const err = messages.find((m: any) => m.type === 'error');
    expect(err?.code).toBe('bad_json');
  });
});

describe('getDefaultRuntimeSocketPath', () => {
  it('returns platform-appropriate path', () => {
    const path = getDefaultRuntimeSocketPath();
    if (process.platform === 'win32') {
      expect(path).toBe('\\\\.\\pipe\\discode-runtime');
    } else {
      expect(path).toContain('.discode');
      expect(path).toMatch(/runtime\.sock$/);
    }
  });
});

describe('RuntimeStreamServer.stop() without start()', () => {
  it('does not delete socket file if server was never started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-nostop-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    // Simulate a daemon's socket file existing on disk
    const { writeFileSync } = await import('fs');
    writeFileSync(socketPath, '');
    expect(existsSync(socketPath)).toBe(true);

    const runtime = createRuntimeMock();
    // Create server but never call start()
    const server = new RuntimeStreamServer(runtime, socketPath);
    server.stop();

    // Socket file should still exist — stop() must not clean up
    // a socket it didn't create
    expect(existsSync(socketPath)).toBe(true);
  });

  it('deletes socket file when server was started and then stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-stop-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const runtime = createRuntimeMock();
    const server = new RuntimeStreamServer(runtime, socketPath);
    server.start();
    registerCleanup(() => { try { server.stop(); } catch {} });

    await waitFor(() => existsSync(socketPath));
    expect(existsSync(socketPath)).toBe(true);

    server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('calling stop() twice is safe (no double-cleanup error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-double-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const runtime = createRuntimeMock();
    const server = new RuntimeStreamServer(runtime, socketPath);
    server.start();

    await waitFor(() => existsSync(socketPath));
    server.stop();
    // Second stop should be a no-op, not throw
    expect(() => server.stop()).not.toThrow();
  });

  it('stop() on never-started server does not throw', () => {
    const runtime = createRuntimeMock();
    const server = new RuntimeStreamServer(runtime, '/tmp/nonexistent-path.sock');

    expect(() => server.stop()).not.toThrow();
  });
});
