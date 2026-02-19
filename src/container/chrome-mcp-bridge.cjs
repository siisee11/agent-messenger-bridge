#!/usr/bin/env node
/**
 * Chrome MCP bridge script for container-side stdio-to-TCP bridging.
 *
 * Runs inside a Docker container and connects Claude Code's stdio MCP
 * protocol to the host's Chrome MCP proxy over TCP.
 *
 * CommonJS, no dependencies — works with Node.js 22 out of the box.
 */
const net = require('net');

const host = process.env.CHROME_MCP_HOST || 'host.docker.internal';
const port = parseInt(process.env.CHROME_MCP_PORT || '18471', 10);

const socket = net.createConnection({ host, port });

process.stdin.pipe(socket);
socket.pipe(process.stdout);

socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));

process.stdin.resume();
