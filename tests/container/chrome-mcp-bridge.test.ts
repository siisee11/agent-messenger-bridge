/**
 * Tests for injectChromeMcpBridge — Docker file injection + MCP config merge.
 *
 * Mocks child_process and fs since these tests verify docker cp commands
 * and file content, not actual Docker operations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────

const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

const existingPaths = new Set<string>();
const mockExistsSync = vi.fn((p: string) => existingPaths.has(p));
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/container/image.js', () => ({
  ensureImage: vi.fn(),
  FULL_IMAGE_TAG: 'discode-agent:1',
}));

import { join } from 'path';
import { homedir } from 'os';
import { injectChromeMcpBridge } from '../../src/container/manager.js';

// ── Tests ───────────────────────────────────────────────────────────

describe('injectChromeMcpBridge', () => {
  const home = homedir();
  const bridgePath = join(import.meta.dirname, '../../src/container/chrome-mcp-bridge.cjs');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockUnlinkSync.mockReset();
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
    existingPaths.clear();
  });

  it('returns false when no Docker socket is found', () => {
    expect(injectChromeMcpBridge('abc123', 18471)).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns false when bridge script is not found on host', () => {
    existingPaths.add('/var/run/docker.sock');
    expect(injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock')).toBe(false);
  });

  it('copies bridge script to /tmp/ in container via docker cp', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);

    const result = injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');
    expect(result).toBe(true);

    // First docker cp: bridge script → container:/tmp/chrome-mcp-bridge.cjs
    const cpCalls = mockExecSync.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('chrome-mcp-bridge.cjs') && c[0].includes('abc123:/tmp/'),
    );
    expect(cpCalls).toHaveLength(1);
  });

  it('merges MCP config into existing .claude.json preserving other keys', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);
    existingPaths.add(join(home, '.claude.json'));

    mockReadFileSync.mockReturnValue(JSON.stringify({
      apiKey: 'sk-xxx',
      mcpServers: { 'existing-server': { type: 'stdio', command: 'test' } },
    }));

    injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');

    const writeCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('claude-in-chrome'),
    );
    expect(writeCall).toBeDefined();
    const parsed = JSON.parse(writeCall![1] as string);

    // Original keys preserved
    expect(parsed.apiKey).toBe('sk-xxx');
    expect(parsed.mcpServers['existing-server']).toEqual({ type: 'stdio', command: 'test' });

    // New MCP server injected
    expect(parsed.mcpServers['claude-in-chrome']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/tmp/chrome-mcp-bridge.cjs'],
      env: {
        CHROME_MCP_HOST: 'host.docker.internal',
        CHROME_MCP_PORT: '18471',
      },
    });
  });

  it('creates mcpServers when .claude.json has none', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);
    existingPaths.add(join(home, '.claude.json'));

    mockReadFileSync.mockReturnValue('{"numStartups":5}');

    injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');

    const writeCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('claude-in-chrome'),
    );
    const parsed = JSON.parse(writeCall![1] as string);
    expect(parsed.numStartups).toBe(5);
    expect(parsed.mcpServers['claude-in-chrome'].command).toBe('node');
  });

  it('creates config from scratch when host .claude.json does not exist', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);
    // No .claude.json

    const result = injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');
    expect(result).toBe(true);

    const writeCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('claude-in-chrome'),
    );
    const parsed = JSON.parse(writeCall![1] as string);
    expect(parsed.mcpServers['claude-in-chrome'].type).toBe('stdio');
  });

  it('uses the provided proxy port in env config', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);

    injectChromeMcpBridge('abc123', 19999, '/var/run/docker.sock');

    const writeCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('claude-in-chrome'),
    );
    const parsed = JSON.parse(writeCall![1] as string);
    expect(parsed.mcpServers['claude-in-chrome'].env.CHROME_MCP_PORT).toBe('19999');
  });

  it('targets /home/coder/.claude.json in the container', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);

    injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');

    const cpCalls = mockExecSync.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/home/coder/.claude.json'),
    );
    expect(cpCalls).toHaveLength(1);
  });

  it('returns false and warns when docker cp fails', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);

    mockExecSync.mockImplementation(() => { throw new Error('docker cp failed'); });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('docker cp failed'));
    warnSpy.mockRestore();
  });

  it('cleans up temp file after successful injection', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);

    injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');

    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('handles malformed .claude.json gracefully', () => {
    existingPaths.add('/var/run/docker.sock');
    existingPaths.add(bridgePath);
    existingPaths.add(join(home, '.claude.json'));

    mockReadFileSync.mockReturnValue('not-valid-json{{{');

    const result = injectChromeMcpBridge('abc123', 18471, '/var/run/docker.sock');
    expect(result).toBe(true);

    const writeCall = mockWriteFileSync.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('claude-in-chrome'),
    );
    const parsed = JSON.parse(writeCall![1] as string);
    expect(parsed.mcpServers['claude-in-chrome'].command).toBe('node');
  });
});
