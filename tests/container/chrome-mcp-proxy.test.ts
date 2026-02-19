/**
 * Tests for ChromeMcpProxy — TCP↔Unix bidirectional forwarding.
 *
 * Uses real Unix sockets and TCP connections to verify actual data flow,
 * not just mock plumbing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer, createConnection as createNetConnection, type Server } from 'net';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChromeMcpProxy } from '../../src/container/chrome-mcp-proxy.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createEchoUnixServer(sockPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer((conn) => {
      conn.on('data', (buf) => {
        conn.write(`echo:${buf.toString()}`);
      });
    });
    srv.on('error', reject);
    srv.listen(sockPath, () => resolve(srv));
  });
}

function connectTcp(port: number, host = '127.0.0.1'): Promise<{
  send: (data: string) => void;
  receive: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const sock = createNetConnection({ port, host });
    const chunks: Buffer[] = [];

    sock.on('data', (buf) => chunks.push(buf));
    sock.on('error', reject);
    sock.on('connect', () => {
      resolve({
        send: (data: string) => sock.write(data),
        receive: () => new Promise((res) => {
          setTimeout(() => res(Buffer.concat(chunks).toString()), 150);
        }),
        close: () => sock.destroy(),
      });
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ChromeMcpProxy — socket discovery', () => {
  it('discoverSocket returns string or null depending on Chrome state', () => {
    const proxy = new ChromeMcpProxy();
    const result = proxy.discoverSocket();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('getPort returns default 18471', () => {
    expect(new ChromeMcpProxy().getPort()).toBe(18471);
  });

  it('getPort returns custom port', () => {
    expect(new ChromeMcpProxy({ port: 12345 }).getPort()).toBe(12345);
  });

  it('start returns false when no socket is available', async () => {
    const proxy = new ChromeMcpProxy({ port: 0 });
    proxy.discoverSocket = () => null;
    expect(await proxy.start()).toBe(false);
    expect(proxy.isActive()).toBe(false);
  });
});

describe('ChromeMcpProxy — real TCP↔Unix forwarding', () => {
  const testDir = join(tmpdir(), `chrome-mcp-fwd-${process.pid}-${Date.now()}`);
  const testSock = join(testDir, '99999.sock');
  let echoServer: Server | null = null;

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true });
    echoServer = await createEchoUnixServer(testSock);
  });

  afterEach(() => {
    echoServer?.close();
    echoServer = null;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('forwards data bidirectionally through TCP→Unix→TCP', async () => {
    const proxy = new ChromeMcpProxy({ port: 0, host: '127.0.0.1' });
    proxy.discoverSocket = () => testSock;

    expect(await proxy.start()).toBe(true);
    expect(proxy.isActive()).toBe(true);

    const address = (proxy as any).server.address();
    const client = await connectTcp(address.port);
    client.send('hello');

    const response = await client.receive();
    expect(response).toBe('echo:hello');

    client.close();
    proxy.stop();
    expect(proxy.isActive()).toBe(false);
  });

  it('handles multiple concurrent TCP connections', async () => {
    const proxy = new ChromeMcpProxy({ port: 0, host: '127.0.0.1' });
    proxy.discoverSocket = () => testSock;
    await proxy.start();

    const address = (proxy as any).server.address();
    const [c1, c2] = await Promise.all([
      connectTcp(address.port),
      connectTcp(address.port),
    ]);

    c1.send('msg1');
    c2.send('msg2');

    const [r1, r2] = await Promise.all([c1.receive(), c2.receive()]);
    expect(r1).toBe('echo:msg1');
    expect(r2).toBe('echo:msg2');

    c1.close();
    c2.close();
    proxy.stop();
  });

  it('stop() cleans up server — new connections fail', async () => {
    const proxy = new ChromeMcpProxy({ port: 0, host: '127.0.0.1' });
    proxy.discoverSocket = () => testSock;
    await proxy.start();

    const address = (proxy as any).server.address();
    const client = await connectTcp(address.port);
    client.send('test');
    await client.receive();

    proxy.stop();
    expect(proxy.isActive()).toBe(false);

    await expect(
      connectTcp(address.port).then(c => { c.close(); return 'connected'; }),
    ).rejects.toThrow();
  });

  it('start() is idempotent — same server on second call', async () => {
    const proxy = new ChromeMcpProxy({ port: 0, host: '127.0.0.1' });
    proxy.discoverSocket = () => testSock;

    expect(await proxy.start()).toBe(true);
    const port1 = (proxy as any).server.address().port;

    expect(await proxy.start()).toBe(true);
    const port2 = (proxy as any).server.address().port;
    expect(port1).toBe(port2);

    proxy.stop();
  });

  it('stop() is safe to call when not started', () => {
    const proxy = new ChromeMcpProxy();
    expect(() => proxy.stop()).not.toThrow();
  });
});
