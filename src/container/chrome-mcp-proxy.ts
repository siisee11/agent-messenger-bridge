/**
 * TCP proxy that bridges a Chrome extension Unix domain socket to a TCP port.
 *
 * The Chrome MCP extension communicates via a Unix socket at
 * /tmp/claude-mcp-browser-bridge-<username>/<PID>.sock
 *
 * This proxy exposes that socket over TCP so Docker containers can
 * reach it via host.docker.internal:<port>.
 */

import { createServer, createConnection, type Server, type Socket } from 'net';
import { readdirSync } from 'fs';
import { join } from 'path';
import { userInfo } from 'os';

const RESCAN_INTERVAL_MS = 5_000;

export interface ChromeMcpProxyOptions {
  port?: number;
  host?: string;
}

export class ChromeMcpProxy {
  private server: Server | null = null;
  private connections = new Set<Socket>();
  private socketPath: string | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly port: number;
  private readonly host: string;

  constructor(options?: ChromeMcpProxyOptions) {
    this.port = options?.port ?? 18471;
    this.host = options?.host ?? '0.0.0.0';
  }

  /**
   * Discover the Chrome extension Unix socket.
   * Scans /tmp/claude-mcp-browser-bridge-<username>/ for *.sock files.
   */
  discoverSocket(): string | null {
    const username = userInfo().username;
    const dir = `/tmp/claude-mcp-browser-bridge-${username}`;
    try {
      const entries = readdirSync(dir);
      const socks = entries.filter(e => e.endsWith('.sock'));
      if (socks.length === 0) return null;
      // Use the most recent (highest PID) socket
      return join(dir, socks[socks.length - 1]);
    } catch {
      return null;
    }
  }

  /**
   * Start the TCP proxy server.
   * Returns a promise that resolves to true once the server is listening,
   * or false if no socket was found.
   */
  async start(): Promise<boolean> {
    if (this.server) return true;

    this.socketPath = this.discoverSocket();
    if (!this.socketPath) return false;

    this.server = createServer((tcpSocket) => {
      const currentPath = this.socketPath;
      if (!currentPath) {
        tcpSocket.destroy();
        return;
      }

      const unixSocket = createConnection({ path: currentPath });

      tcpSocket.pipe(unixSocket);
      unixSocket.pipe(tcpSocket);

      this.connections.add(tcpSocket);
      this.connections.add(unixSocket);

      const cleanup = () => {
        tcpSocket.destroy();
        unixSocket.destroy();
        this.connections.delete(tcpSocket);
        this.connections.delete(unixSocket);
      };

      tcpSocket.on('error', cleanup);
      tcpSocket.on('close', cleanup);
      unixSocket.on('error', cleanup);
      unixSocket.on('close', cleanup);
    });

    // Wait for the server to actually be listening before returning
    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err) => {
        this.stop();
        reject(err);
      });
      this.server!.listen(this.port, this.host, () => resolve());
    });

    // Periodically re-scan for socket changes (Chrome restart changes PID)
    this.rescanTimer = setInterval(() => {
      const newPath = this.discoverSocket();
      if (newPath) {
        this.socketPath = newPath;
      }
    }, RESCAN_INTERVAL_MS);

    return true;
  }

  /**
   * Stop the TCP proxy and clean up all connections.
   */
  stop(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.socketPath = null;
  }

  /**
   * Check if the proxy is running and has a valid socket path.
   */
  isActive(): boolean {
    return this.server !== null && this.socketPath !== null;
  }

  /**
   * Get the port the proxy is listening on.
   */
  getPort(): number {
    return this.port;
  }
}
