import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RuntimeStreamClient } from '../../src/cli/common/runtime-stream-client.js';

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

describe('RuntimeStreamClient', () => {
  it('receives frames and reports connection state changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-client-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    let socketRef: Socket | undefined;
    const server = createServer((socket) => {
      socketRef = socket;
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line) as { type?: string };
          if (msg.type === 'subscribe') {
            socket.write(`${JSON.stringify({
              type: 'frame',
              windowId: 'bridge:demo-opencode',
              seq: 1,
              lines: ['hello', 'world'],
            })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    registerCleanup(() => server.close());

    const states: string[] = [];
    const frames: Array<string[]> = [];

    const client = new RuntimeStreamClient(socketPath, {
      onStateChange: (state) => states.push(state),
      onFrame: (frame) => frames.push(frame.lines),
    });
    registerCleanup(() => client.disconnect());

    const connected = await client.connect();
    expect(connected).toBe(true);

    client.subscribe('bridge:demo-opencode', 120, 40);
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual(['hello', 'world']);

    socketRef?.destroy();
    await waitFor(() => states.includes('disconnected'));
    expect(states.includes('connected')).toBe(true);
    expect(states.includes('disconnected')).toBe(true);
  });

  it('handles styled patch messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-stream-client-patch-'));
    registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'runtime.sock');

    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line) as { type?: string };
          if (msg.type === 'subscribe') {
            socket.write(`${JSON.stringify({
              type: 'patch-styled',
              windowId: 'bridge:demo-opencode',
              seq: 3,
              lineCount: 2,
              ops: [{
                index: 0,
                line: {
                  segments: [{ text: 'Hello', fg: '#ffffff', bg: '#000000', bold: true }],
                },
              }],
            })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    registerCleanup(() => server.close());

    const patches: Array<{ lineCount: number; firstText: string }> = [];
    const client = new RuntimeStreamClient(socketPath, {
      onPatchStyled: (patch) => {
        patches.push({
          lineCount: patch.lineCount,
          firstText: patch.ops[0]?.line.segments[0]?.text || '',
        });
      },
    });
    registerCleanup(() => client.disconnect());

    const connected = await client.connect();
    expect(connected).toBe(true);

    client.subscribe('bridge:demo-opencode', 120, 40);
    await waitFor(() => patches.length > 0);
    expect(patches[0]).toEqual({ lineCount: 2, firstText: 'Hello' });
  });
});
