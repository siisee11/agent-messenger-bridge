/**
 * Unit tests for container manager module.
 *
 * Tests Docker socket discovery, command building, and container lifecycle
 * functions with mocked execSync/execFileSync/fs calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process and fs before importing the module under test
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

const existingPaths = new Set<string>();
const mockExistsSync = vi.fn((p: string) => existingPaths.has(p));
const mockStatSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

const mockEnsureImage = vi.fn();

vi.mock('../../src/container/image.js', () => ({
  ensureImage: (...args: any[]) => mockEnsureImage(...args),
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
}));

import { join } from 'path';
import { homedir } from 'os';

import {
  findDockerSocket,
  isDockerAvailable,
  buildDockerStartCommand,
  isContainerRunning,
  containerExists,
  stopContainer,
  removeContainer,
  createContainer,
  injectCredentials,
  injectFile,
  extractFile,
  startContainerBackground,
  execInContainer,
  WORKSPACE_DIR,
} from '../../src/container/manager.js';

describe('container/manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset implementations (clearAllMocks only clears call history)
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockEnsureImage.mockReset();
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
    existingPaths.clear();
  });

  describe('findDockerSocket', () => {
    it('returns null when no socket files exist', () => {
      expect(findDockerSocket()).toBeNull();
    });

    it('returns the first existing socket path', () => {
      // Simulate only Docker Desktop socket existing
      const home = process.env.HOME || '/Users/test';
      existingPaths.add(`${home}/.docker/run/docker.sock`);

      const result = findDockerSocket();
      expect(result).toBe(`${home}/.docker/run/docker.sock`);
    });

    it('prefers OrbStack over Docker Desktop', () => {
      const home = process.env.HOME || '/Users/test';
      existingPaths.add(`${home}/.orbstack/run/docker.sock`);
      existingPaths.add(`${home}/.docker/run/docker.sock`);

      const result = findDockerSocket();
      expect(result).toBe(`${home}/.orbstack/run/docker.sock`);
    });

    it('falls back to /var/run/docker.sock', () => {
      existingPaths.add('/var/run/docker.sock');

      const result = findDockerSocket();
      expect(result).toBe('/var/run/docker.sock');
    });
  });

  describe('isDockerAvailable', () => {
    it('returns false when no socket found', () => {
      expect(isDockerAvailable()).toBe(false);
    });

    it('returns true when docker info succeeds', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue(Buffer.from(''));

      expect(isDockerAvailable()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker -H unix:///var/run/docker.sock info',
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('returns false when docker info throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('connection refused'); });

      expect(isDockerAvailable()).toBe(false);
    });

    it('uses explicit socket path when provided', () => {
      mockExecSync.mockReturnValue(Buffer.from(''));

      expect(isDockerAvailable('/custom/docker.sock')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker -H unix:///custom/docker.sock info',
        expect.anything(),
      );
    });
  });

  describe('buildDockerStartCommand', () => {
    it('builds docker start -ai command with socket', () => {
      existingPaths.add('/var/run/docker.sock');
      const cmd = buildDockerStartCommand('abc123', '/var/run/docker.sock');

      expect(cmd).toBe('docker -H unix:///var/run/docker.sock start -ai abc123');
    });

    it('builds basic command when no socket found', () => {
      const cmd = buildDockerStartCommand('abc123');

      expect(cmd).toBe('docker start -ai abc123');
    });
  });

  describe('isContainerRunning', () => {
    it('returns false when no socket available', () => {
      expect(isContainerRunning('abc123')).toBe(false);
    });

    it('returns true when inspect shows Running=true', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('true\n');

      expect(isContainerRunning('abc123')).toBe(true);
    });

    it('returns false when inspect shows Running=false', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('false\n');

      expect(isContainerRunning('abc123')).toBe(false);
    });

    it('returns false when inspect throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('no such container'); });

      expect(isContainerRunning('abc123')).toBe(false);
    });
  });

  describe('containerExists', () => {
    it('returns false when no socket', () => {
      expect(containerExists('abc123')).toBe(false);
    });

    it('returns true when inspect succeeds', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('');

      expect(containerExists('abc123')).toBe(true);
    });

    it('returns false when inspect throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('no such container'); });

      expect(containerExists('abc123')).toBe(false);
    });
  });

  describe('stopContainer', () => {
    it('returns false when no socket', () => {
      expect(stopContainer('abc123')).toBe(false);
    });

    it('returns true on success', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('');

      expect(stopContainer('abc123')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('stop -t 10 abc123'),
        expect.anything(),
      );
    });

    it('returns false when stop throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('not running'); });

      expect(stopContainer('abc123')).toBe(false);
    });
  });

  describe('removeContainer', () => {
    it('returns false when no socket', () => {
      expect(removeContainer('abc123')).toBe(false);
    });

    it('returns true on force remove', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('');

      expect(removeContainer('abc123')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('rm -f abc123'),
        expect.anything(),
      );
    });
  });

  describe('WORKSPACE_DIR', () => {
    it('is /workspace', () => {
      expect(WORKSPACE_DIR).toBe('/workspace');
    });
  });

  describe('createContainer', () => {
    it('throws when no socket found', () => {
      expect(() => createContainer({
        agentType: 'claude',
        containerName: 'test-container',
        projectPath: '/test/path',
      })).toThrow('Docker socket not found');
    });

    it('calls ensureImage before creating', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456789\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-container',
        projectPath: '/test/path',
      });

      expect(mockEnsureImage).toHaveBeenCalledWith('claude', '/var/run/docker.sock');
    });

    it('returns truncated 12-char container ID', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456789extrachars\n');

      const id = createContainer({
        agentType: 'claude',
        containerName: 'test-container',
        projectPath: '/test/path',
      });

      expect(id).toBe('abc123def456');
    });

    it('passes correct docker create args', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'my-container',
        projectPath: '/home/user/project',
        env: { AGENT_DISCORD_PROJECT: 'myapp', FOO: 'bar' },
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          '-H', 'unix:///var/run/docker.sock',
          'create',
          '--name', 'my-container',
          '-it',
          '-w', '/workspace',
          '-v', '/home/user/project:/workspace',
          '--add-host', 'host.docker.internal:host-gateway',
          '-u', '1000:1000',
          '-e', 'AGENT_DISCORD_PROJECT=myapp',
          '-e', 'FOO=bar',
          'discode-agent-claude:1',
        ]),
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('creates container without env flags when env is undefined', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test',
        projectPath: '/test',
      });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args).not.toContain('-e');
    });

    it('uses explicit socketPath when provided', () => {
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test',
        projectPath: '/test',
        socketPath: '/custom/docker.sock',
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-H', 'unix:///custom/docker.sock']),
        expect.anything(),
      );
    });

    it('removes stale container with same name before creating', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'my-agent',
        projectPath: '/test',
      });

      // First call should be docker rm -f to clean up stale container
      const rmCall = mockExecFileSync.mock.calls[0];
      expect(rmCall[0]).toBe('docker');
      expect(rmCall[1]).toContain('rm');
      expect(rmCall[1]).toContain('-f');
      expect(rmCall[1]).toContain('my-agent');
    });

    it('proceeds with create even when rm -f fails (no stale container)', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('No such container'); })
        .mockReturnValueOnce('abc123def456\n');

      const id = createContainer({
        agentType: 'claude',
        containerName: 'fresh',
        projectPath: '/test',
      });

      expect(id).toBe('abc123def456');
    });

    it('passes command as -c flag when provided', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-agent',
        projectPath: '/test',
        command: 'claude --dangerously-skip-permissions',
      });

      // Find the `docker create` call (skip the `docker rm -f` cleanup call)
      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      // command is passed as -c <command> after the image tag
      const imageIdx = args.indexOf('discode-agent-claude:1');
      expect(imageIdx).toBeGreaterThan(-1);
      expect(args[imageIdx + 1]).toBe('-c');
      expect(args[imageIdx + 2]).toBe('claude --dangerously-skip-permissions');
    });

    it('does not pass -c flag when command is undefined', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test',
        projectPath: '/test',
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      const imageIdx = args.indexOf('discode-agent-claude:1');
      // Nothing after the image tag
      expect(args.length).toBe(imageIdx + 1);
    });

    it('passes volume mounts when provided', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-vol',
        projectPath: '/test',
        volumes: [
          '/host/plugin:/home/coder/.claude/plugins/bridge:ro',
          '/host/data:/data',
        ],
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      // Each volume gets a -v flag
      const vIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '-v' && args[i + 1]?.includes(':')) acc.push(i);
        return acc;
      }, []);
      // project mount + 2 extra volumes = at least 3 -v flags
      expect(vIndices.length).toBeGreaterThanOrEqual(3);
      expect(args).toContain('/host/plugin:/home/coder/.claude/plugins/bridge:ro');
      expect(args).toContain('/host/data:/data');
    });

    it('passes both command and volumes together', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-full',
        projectPath: '/project',
        command: 'claude --plugin-dir /home/coder/.claude/plugins/bridge',
        volumes: ['/host/bridge:/home/coder/.claude/plugins/bridge:ro'],
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      expect(args).toContain('/host/bridge:/home/coder/.claude/plugins/bridge:ro');
      const imageIdx = args.indexOf('discode-agent-claude:1');
      expect(args[imageIdx + 1]).toBe('-c');
      expect(args[imageIdx + 2]).toBe('claude --plugin-dir /home/coder/.claude/plugins/bridge');
    });
  });

  describe('injectCredentials', () => {
    const home = homedir();

    it('does nothing when no socket found', () => {
      injectCredentials('abc123');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('injects settings.json with hasCompletedOnboarding=true via docker cp', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      mockReadFileSync.mockReturnValue('{"theme":"dark"}');

      injectCredentials('abc123', '/var/run/docker.sock');

      expect(mockReadFileSync).toHaveBeenCalledWith(
        join(home, '.claude', 'settings.json'),
        'utf-8',
      );
      // Writes temp file with hasCompletedOnboarding merged
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.hasCompletedOnboarding).toBe(true);
      expect(parsed.theme).toBe('dark');
      // Uses docker cp to copy into container
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('docker -H unix:///var/run/docker.sock cp'),
        expect.anything(),
      );
      expect(mockExecSync.mock.calls[0][0]).toContain('abc123:/home/coder/.claude/settings.json');
      // Cleans up temp file
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('injects .credentials.json when it exists', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      mockReadFileSync.mockReturnValue('{"oauth":"token123"}');

      injectCredentials('abc123', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('abc123:/home/coder/.claude/.credentials.json'),
        expect.anything(),
      );
    });

    it('injects .claude.json when it exists', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{"apiKey":"sk-xxx"}');

      injectCredentials('abc123', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('abc123:/home/coder/.claude.json'),
        expect.anything(),
      );
    });

    it('injects all three when all exist', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{}');

      injectCredentials('abc123', '/var/run/docker.sock');

      // Three docker cp calls: settings, credentials, .claude.json
      expect(mockExecSync).toHaveBeenCalledTimes(3);
      // Three temp files written and cleaned up
      expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    });

    it('continues silently when docker cp throws (best-effort)', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      mockReadFileSync.mockReturnValue('{"theme":"dark"}');
      mockExecSync.mockImplementation(() => { throw new Error('docker cp failed'); });

      expect(() => injectCredentials('abc123', '/var/run/docker.sock')).not.toThrow();
      // Temp file still cleaned up even when docker cp fails
      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it('cleans up temp file even when docker cp fails for each credential', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{}');
      mockExecSync.mockImplementation(() => { throw new Error('docker cp failed'); });

      injectCredentials('abc123', '/var/run/docker.sock');

      // All three temp files should be cleaned up despite errors
      expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    });

    it('does not call docker cp when settings.json is invalid JSON', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      mockReadFileSync.mockReturnValue('not valid json{{{');

      expect(() => injectCredentials('abc123', '/var/run/docker.sock')).not.toThrow();
      // JSON.parse fails before writeFileSync, so no docker cp for settings
      const dockerCpCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('docker'),
      );
      expect(dockerCpCalls).toHaveLength(0);
    });

    it('skips files that do not exist on host', () => {
      existingPaths.add('/var/run/docker.sock');
      // No credential files added to existingPaths

      injectCredentials('abc123', '/var/run/docker.sock');

      expect(mockReadFileSync).not.toHaveBeenCalled();
      // No docker cp calls (keychain fallback may call security but not docker)
      const dockerCpCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('docker'),
      );
      expect(dockerCpCalls).toHaveLength(0);
    });

    it('falls back to macOS Keychain when credentials.json missing on darwin', () => {
      existingPaths.add('/var/run/docker.sock');
      // No credentials.json on disk

      // Mock the security command returning OAuth JSON
      const oauthJson = '{"claudeAiOauth":{"accessToken":"sk-test","refreshToken":"sk-ref"}}';
      mockExecSync.mockReturnValue(oauthJson);

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abc123', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      // Should have called security find-generic-password
      const securityCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('security find-generic-password'),
      );
      expect(securityCalls).toHaveLength(1);
      expect(securityCalls[0][0]).toContain('Claude Code-credentials');

      // Should have docker cp'd the keychain result to container
      const dockerCpCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('docker') && c[0].includes('.credentials.json'),
      );
      expect(dockerCpCalls).toHaveLength(1);
    });

    it('does not attempt Keychain fallback on linux', () => {
      existingPaths.add('/var/run/docker.sock');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        injectCredentials('abc123', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const securityCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('security'),
      );
      expect(securityCalls).toHaveLength(0);
    });

    it('prefers .credentials.json file over Keychain on darwin', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"from-file"}}');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abc123', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      // File-based docker cp should happen
      const dockerCpCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('docker') && c[0].includes('.credentials.json'),
      );
      expect(dockerCpCalls).toHaveLength(1);
      // Keychain should NOT be consulted since file exists
      const securityCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('security find-generic-password'),
      );
      expect(securityCalls).toHaveLength(0);
    });

    it('Keychain fallback writes raw JSON to container as .credentials.json', () => {
      existingPaths.add('/var/run/docker.sock');
      const oauthJson = '{"claudeAiOauth":{"accessToken":"sk-oat","refreshToken":"sk-ort","expiresAt":9999}}';
      mockExecSync.mockReturnValue(oauthJson);

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abc123', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      // The raw JSON from Keychain should be written to a temp file
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-inject-'),
        oauthJson,
      );
      // Then docker cp'd to the correct container path
      const dockerCpCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('docker') && c[0].includes('.credentials.json'),
      );
      expect(dockerCpCalls).toHaveLength(1);
      expect(dockerCpCalls[0][0]).toContain('/home/coder/.claude/.credentials.json');
    });

    it('Keychain fallback skips when security command returns empty', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('   \n');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abc123', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      // No docker cp should happen since keychain returned empty
      const dockerCpCalls = mockExecSync.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('docker'),
      );
      expect(dockerCpCalls).toHaveLength(0);
    });

    it('Keychain fallback handles security command failure gracefully', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('security')) throw new Error('keychain locked');
        return '';
      });

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        expect(() => injectCredentials('abc123', '/var/run/docker.sock')).not.toThrow();
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('Keychain fallback uses 5s timeout for security command', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('{"claudeAiOauth":{}}');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abc123', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const securityCall = mockExecSync.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('security'),
      );
      expect(securityCall).toBeDefined();
      expect(securityCall![1]).toEqual(expect.objectContaining({
        timeout: 5_000,
        encoding: 'utf-8',
      }));
    });
  });

  describe('injectFile', () => {
    it('returns false when no socket found', () => {
      expect(injectFile('abc123', '/host/file.png', '/container/dir')).toBe(false);
    });

    it('returns false when file exceeds 50MB', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 51 * 1024 * 1024 });

      expect(injectFile('abc123', '/host/big.bin', '/container/dir', '/var/run/docker.sock')).toBe(false);
    });

    it('returns false when stat throws (file not found)', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

      expect(injectFile('abc123', '/host/missing.txt', '/dir', '/var/run/docker.sock')).toBe(false);
    });

    it('creates directory, copies file, and fixes ownership', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 1024 });

      const result = injectFile(
        'abc123',
        '/host/files/img.png',
        '/workspace/.discode/files',
        '/var/run/docker.sock',
      );

      expect(result).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(3);
      // mkdir -p
      expect(mockExecSync.mock.calls[0][0]).toContain('mkdir -p /workspace/.discode/files');
      // docker cp
      expect(mockExecSync.mock.calls[1][0]).toContain(
        'cp /host/files/img.png abc123:/workspace/.discode/files/',
      );
      // chown
      expect(mockExecSync.mock.calls[2][0]).toContain(
        'chown 1000:1000 /workspace/.discode/files/img.png',
      );
    });

    it('returns false when docker cp throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 1024 });
      mockExecSync.mockImplementation(() => { throw new Error('container not running'); });

      expect(injectFile('abc123', '/host/file.txt', '/dir', '/var/run/docker.sock')).toBe(false);
    });

    it('accepts files exactly at 50MB limit', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 50 * 1024 * 1024 });

      const result = injectFile('abc123', '/host/file.bin', '/dir', '/var/run/docker.sock');
      expect(result).toBe(true);
    });
  });

  describe('extractFile', () => {
    it('returns false when no socket found', () => {
      expect(extractFile('abc123', '/container/file.txt', '/host/dir')).toBe(false);
    });

    it('creates host directory and copies file from container', () => {
      existingPaths.add('/var/run/docker.sock');

      const result = extractFile(
        'abc123',
        '/workspace/output.txt',
        '/host/output',
        '/var/run/docker.sock',
      );

      expect(result).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledWith('/host/output', { recursive: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('cp abc123:/workspace/output.txt /host/output/'),
        expect.anything(),
      );
    });

    it('returns false when docker cp throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('no such container'); });

      expect(extractFile('abc123', '/container/f.txt', '/host', '/var/run/docker.sock')).toBe(false);
    });
  });

  describe('startContainerBackground', () => {
    it('returns false when no socket found', () => {
      expect(startContainerBackground('abc123')).toBe(false);
    });

    it('runs docker start and returns true', () => {
      existingPaths.add('/var/run/docker.sock');

      expect(startContainerBackground('abc123')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker -H unix:///var/run/docker.sock start abc123',
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it('returns false when start throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('already running'); });

      expect(startContainerBackground('abc123')).toBe(false);
    });
  });

  describe('execInContainer', () => {
    it('throws when no socket found', () => {
      expect(() => execInContainer('abc123', 'ls -la')).toThrow('Docker socket not found');
    });

    it('returns trimmed stdout', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('  file1.txt\nfile2.txt  \n');

      const result = execInContainer('abc123', 'ls -la');
      expect(result).toBe('file1.txt\nfile2.txt');
    });

    it('passes shell-escaped command to docker exec', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue('output\n');

      execInContainer('abc123', 'cat /workspace/test.txt', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('docker -H unix:///var/run/docker.sock exec abc123 sh -c'),
        expect.objectContaining({ encoding: 'utf-8', timeout: 30_000 }),
      );
    });
  });
});
