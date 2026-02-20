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
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
}));

import { join } from 'path';
import { homedir } from 'os';
import { injectChromeMcpBridge } from '../../src/container/manager.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Find the writeFileSync call whose written content includes the given substring. */
function findWriteCall(substring: string): [string, string] | undefined {
  return mockWriteFileSync.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes(substring),
  ) as [string, string] | undefined;
}

/** Find docker cp calls targeting a specific container path. */
function findDockerCpCalls(containerPath: string): any[][] {
  return mockExecSync.mock.calls.filter(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes(containerPath),
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe('injectChromeMcpBridge', () => {
  const home = homedir();
  const bridgePath = join(import.meta.dirname, '../../src/container/chrome-mcp-bridge.cjs');
  const sock = '/var/run/docker.sock';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockUnlinkSync.mockReset();
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
    existingPaths.clear();
  });

  // ── Common behavior ────────────────────────────────────────────

  it('returns false when no Docker socket is found', () => {
    expect(injectChromeMcpBridge('abc123', 18471, 'claude')).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns false when bridge script is not found on host', () => {
    existingPaths.add(sock);
    expect(injectChromeMcpBridge('abc123', 18471, 'claude', sock)).toBe(false);
  });

  it('copies bridge script to /tmp/ in container via docker cp', () => {
    existingPaths.add(sock);
    existingPaths.add(bridgePath);

    const result = injectChromeMcpBridge('abc123', 18471, 'claude', sock);
    expect(result).toBe(true);

    const cpCalls = findDockerCpCalls('abc123:/tmp/chrome-mcp-bridge.cjs');
    expect(cpCalls).toHaveLength(1);
  });

  it('returns false and warns when docker cp fails', () => {
    existingPaths.add(sock);
    existingPaths.add(bridgePath);
    mockExecSync.mockImplementation(() => { throw new Error('docker cp failed'); });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = injectChromeMcpBridge('abc123', 18471, 'claude', sock);
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('docker cp failed'));
    warnSpy.mockRestore();
  });

  it('cleans up temp file after successful injection', () => {
    existingPaths.add(sock);
    existingPaths.add(bridgePath);

    injectChromeMcpBridge('abc123', 18471, 'claude', sock);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  // ── Claude agent ───────────────────────────────────────────────

  describe('claude agent', () => {
    it('merges MCP config into existing .claude.json preserving other keys', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);
      existingPaths.add(join(home, '.claude.json'));

      mockReadFileSync.mockReturnValue(JSON.stringify({
        apiKey: 'sk-xxx',
        mcpServers: { 'existing-server': { type: 'stdio', command: 'test' } },
      }));

      injectChromeMcpBridge('abc123', 18471, 'claude', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      expect(writeCall).toBeDefined();
      const parsed = JSON.parse(writeCall![1]);

      expect(parsed.apiKey).toBe('sk-xxx');
      expect(parsed.mcpServers['existing-server']).toEqual({ type: 'stdio', command: 'test' });
      expect(parsed.mcpServers['claude-in-chrome']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/tmp/chrome-mcp-bridge.cjs'],
        env: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: '18471' },
      });
    });

    it('creates mcpServers when .claude.json has none', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{"numStartups":5}');

      injectChromeMcpBridge('abc123', 18471, 'claude', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);
      expect(parsed.numStartups).toBe(5);
      expect(parsed.mcpServers['claude-in-chrome'].command).toBe('node');
    });

    it('creates config from scratch when host .claude.json does not exist', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      const result = injectChromeMcpBridge('abc123', 18471, 'claude', sock);
      expect(result).toBe(true);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);
      expect(parsed.mcpServers['claude-in-chrome'].type).toBe('stdio');
    });

    it('targets /home/coder/.claude.json in the container', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'claude', sock);

      const cpCalls = findDockerCpCalls('/home/coder/.claude.json');
      expect(cpCalls).toHaveLength(1);
    });

    it('uses the provided proxy port in env config', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 19999, 'claude', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);
      expect(parsed.mcpServers['claude-in-chrome'].env.CHROME_MCP_PORT).toBe('19999');
    });

    it('handles malformed .claude.json gracefully', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('not-valid-json{{{');

      const result = injectChromeMcpBridge('abc123', 18471, 'claude', sock);
      expect(result).toBe(true);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);
      expect(parsed.mcpServers['claude-in-chrome'].command).toBe('node');
    });
  });

  // ── Gemini agent ───────────────────────────────────────────────

  describe('gemini agent', () => {
    it('injects MCP config into ~/.gemini/settings.json', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'gemini', sock);

      const cpCalls = findDockerCpCalls('/home/coder/.gemini/settings.json');
      expect(cpCalls).toHaveLength(1);
    });

    it('uses mcpServers key with same format as Claude', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'gemini', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      expect(writeCall).toBeDefined();
      const parsed = JSON.parse(writeCall![1]);

      expect(parsed.mcpServers['claude-in-chrome']).toEqual({
        command: 'node',
        args: ['/tmp/chrome-mcp-bridge.cjs'],
        env: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: '18471' },
      });
    });

    it('preserves existing gemini settings and hooks', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);
      existingPaths.add(join(home, '.gemini', 'settings.json'));

      mockReadFileSync.mockReturnValue(JSON.stringify({
        hooks: { AfterAgent: [{ matcher: '*', hooks: [{ name: 'test' }] }] },
        mcpServers: { 'existing-mcp': { command: 'test' } },
      }));

      injectChromeMcpBridge('abc123', 18471, 'gemini', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);

      expect(parsed.hooks.AfterAgent).toHaveLength(1);
      expect(parsed.mcpServers['existing-mcp']).toEqual({ command: 'test' });
      expect(parsed.mcpServers['claude-in-chrome']).toBeDefined();
    });

    it('creates settings from scratch when host settings.json does not exist', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'gemini', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);
      expect(parsed.mcpServers['claude-in-chrome'].command).toBe('node');
    });

    it('does NOT write to .claude.json', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'gemini', sock);

      const cpCalls = findDockerCpCalls('/home/coder/.claude.json');
      expect(cpCalls).toHaveLength(0);
    });
  });

  // ── OpenCode agent ─────────────────────────────────────────────

  describe('opencode agent', () => {
    it('injects MCP config into ~/.config/opencode/opencode.json', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'opencode', sock);

      const cpCalls = findDockerCpCalls('/home/coder/.config/opencode/opencode.json');
      expect(cpCalls).toHaveLength(1);
    });

    it('uses "mcp" key with type "local" and command as array', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'opencode', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      expect(writeCall).toBeDefined();
      const parsed = JSON.parse(writeCall![1]);

      expect(parsed.mcp['claude-in-chrome']).toEqual({
        type: 'local',
        command: ['node', '/tmp/chrome-mcp-bridge.cjs'],
        environment: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: '18471' },
      });
    });

    it('preserves existing opencode config', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);
      existingPaths.add(join(home, '.config', 'opencode', 'opencode.json'));

      mockReadFileSync.mockReturnValue(JSON.stringify({
        '$schema': 'https://opencode.ai/config.json',
        mcp: { 'existing-server': { type: 'local', command: ['test'] } },
      }));

      injectChromeMcpBridge('abc123', 18471, 'opencode', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);

      expect(parsed['$schema']).toBe('https://opencode.ai/config.json');
      expect(parsed.mcp['existing-server']).toEqual({ type: 'local', command: ['test'] });
      expect(parsed.mcp['claude-in-chrome']).toBeDefined();
    });

    it('creates config from scratch when host opencode.json does not exist', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'opencode', sock);

      const writeCall = findWriteCall('claude-in-chrome');
      const parsed = JSON.parse(writeCall![1]);
      expect(parsed.mcp['claude-in-chrome'].type).toBe('local');
    });

    it('does NOT write to .claude.json or .gemini/settings.json', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      injectChromeMcpBridge('abc123', 18471, 'opencode', sock);

      expect(findDockerCpCalls('/home/coder/.claude.json')).toHaveLength(0);
      expect(findDockerCpCalls('/home/coder/.gemini/settings.json')).toHaveLength(0);
    });
  });

  // ── Unknown agent type fallback ────────────────────────────────

  describe('unknown agent type', () => {
    it('still copies bridge script but skips config injection', () => {
      existingPaths.add(sock);
      existingPaths.add(bridgePath);

      const result = injectChromeMcpBridge('abc123', 18471, 'codex', sock);
      expect(result).toBe(true);

      // Bridge script copied
      const cpCalls = findDockerCpCalls('abc123:/tmp/chrome-mcp-bridge.cjs');
      expect(cpCalls).toHaveLength(1);

      // No config file written
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});
