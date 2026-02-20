/**
 * Unit tests for container image module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  execFileSync: vi.fn(),
}));

const existingPaths = new Set<string>();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockRmSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (p: string) => existingPaths.has(p),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  rmSync: (...args: any[]) => mockRmSync(...args),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { imageExists, buildImage, ensureImage, removeImage, imageTagFor, IMAGE_PREFIX } from '../../src/container/image.js';

describe('container/image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    existingPaths.clear();
  });

  describe('imageTagFor', () => {
    it('returns agent-specific tag', () => {
      expect(imageTagFor('claude')).toBe('discode-agent-claude:1');
      expect(imageTagFor('gemini')).toBe('discode-agent-gemini:1');
      expect(imageTagFor('opencode')).toBe('discode-agent-opencode:1');
    });
  });

  describe('imageExists', () => {
    it('returns false when no socket found', () => {
      expect(imageExists('claude')).toBe(false);
    });

    it('returns true when docker image inspect succeeds', () => {
      mockExecSync.mockReturnValue(Buffer.from('[{"Id": "sha256:abc"}]'));

      expect(imageExists('claude', '/var/run/docker.sock')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('image inspect discode-agent-claude:1'),
        expect.anything(),
      );
    });

    it('returns false when docker image inspect throws', () => {
      mockExecSync.mockImplementation(() => { throw new Error('No such image'); });

      expect(imageExists('claude', '/var/run/docker.sock')).toBe(false);
    });
  });

  describe('buildImage', () => {
    it('throws when no socket found', () => {
      expect(() => buildImage('claude')).toThrow('Docker socket not found');
    });

    it('creates temp dir, writes Dockerfile, and runs docker build', () => {
      buildImage('claude', '/var/run/docker.sock');

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-image-build-'),
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Dockerfile'),
        expect.stringContaining('FROM node:22-slim'),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('docker -H unix:///var/run/docker.sock build -t discode-agent-claude:1'),
        expect.objectContaining({ timeout: 300_000 }),
      );
    });

    it('Dockerfile for claude installs only claude-code', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('@anthropic-ai/claude-code');
      expect(dockerfile).not.toContain('@google/gemini-cli');
      expect(dockerfile).not.toContain('opencode-ai');
    });

    it('Dockerfile for opencode installs only opencode-ai', () => {
      buildImage('opencode', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('opencode-ai');
      expect(dockerfile).not.toContain('@anthropic-ai/claude-code');
      expect(dockerfile).not.toContain('@google/gemini-cli');
    });

    it('Dockerfile for gemini installs only gemini-cli', () => {
      buildImage('gemini', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('@google/gemini-cli');
      expect(dockerfile).not.toContain('@anthropic-ai/claude-code');
      expect(dockerfile).not.toContain('opencode-ai');
    });

    it('throws for unknown agent type', () => {
      expect(() => buildImage('unknown', '/var/run/docker.sock')).toThrow('Unknown agent type');
    });

    it('Dockerfile creates coder user and workspace', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('coder');
      expect(dockerfile).toContain('WORKDIR /workspace');
      expect(dockerfile).toContain('hasCompletedOnboarding');
    });

    it('Dockerfile includes a hash label for change detection', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toMatch(/LABEL discode\.dockerfile\.hash="[a-f0-9]{12}"/);
    });

    it('Dockerfile handles existing uid/gid 1000 in base image', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('getent passwd 1000');
      expect(dockerfile).toContain('usermod -l coder');
      expect(dockerfile).toContain('groupmod -n coder');
      expect(dockerfile).toContain('useradd');
      expect(dockerfile).toContain('chown -R 1000:1000');
    });

    it('Dockerfile has both rename and create-from-scratch branches', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toMatch(/if getent passwd 1000.*then/s);
      expect(dockerfile).toContain('usermod -l coder -d /home/coder -m');
      expect(dockerfile).toMatch(/else.*useradd/s);
      expect(dockerfile).toContain('useradd -m -u 1000 -g 1000 -s /bin/bash coder');
      expect(dockerfile).toContain('getent group 1000');
      expect(dockerfile).toContain('groupadd -g 1000 coder');
    });

    it('Dockerfile has bash entrypoint for -c command injection', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('ENTRYPOINT ["/bin/bash", "-l"]');
    });

    it('Dockerfile does not hardcode groupadd -g 1000 unconditionally', () => {
      buildImage('claude', '/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      const lines = dockerfile.split('\n').map(l => l.trim());
      const standaloneGroupadd = lines.filter(l =>
        l.startsWith('RUN groupadd -g 1000') && !l.includes('getent'),
      );
      expect(standaloneGroupadd).toHaveLength(0);
    });

    it('cleans up build directory even on failure', () => {
      mockExecSync.mockImplementation(() => { throw new Error('build failed'); });

      expect(() => buildImage('claude', '/var/run/docker.sock')).toThrow('build failed');
      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-image-build-'),
        { recursive: true, force: true },
      );
    });

    it('cleans up build directory on success', () => {
      buildImage('claude', '/var/run/docker.sock');

      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-image-build-'),
        { recursive: true, force: true },
      );
    });
  });

  describe('removeImage', () => {
    it('runs docker rmi with agent-specific tag', () => {
      removeImage('opencode', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('rmi discode-agent-opencode:1'),
        expect.anything(),
      );
    });

    it('does not throw when image does not exist', () => {
      mockExecSync.mockImplementation(() => { throw new Error('No such image'); });

      expect(() => removeImage('claude', '/var/run/docker.sock')).not.toThrow();
    });
  });

  describe('ensureImage', () => {
    it('skips rebuild when image exists with matching hash', () => {
      // Extract the expected hash from a generated Dockerfile
      buildImage('claude', '/var/run/docker.sock');
      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      const hashMatch = dockerfile.match(/discode\.dockerfile\.hash="([a-f0-9]+)"/);
      const expectedHash = hashMatch![1];
      mockExecSync.mockReset();
      mockWriteFileSync.mockReset();

      mockExecSync
        .mockReturnValueOnce(Buffer.from('[{"Id":"sha256:abc"}]')) // image inspect
        .mockReturnValueOnce(Buffer.from(expectedHash));           // inspect --format (hash label)

      ensureImage('claude', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledTimes(2);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('removes and rebuilds when image hash differs', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('[{"Id":"sha256:abc"}]')) // image inspect
        .mockReturnValueOnce(Buffer.from('stale_hash'))            // inspect --format (hash label)
        .mockReturnValueOnce(Buffer.from(''))                      // rmi
        .mockReturnValueOnce(Buffer.from(''));                     // docker build

      ensureImage('claude', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledTimes(4);
      expect(mockExecSync.mock.calls[2][0]).toContain('rmi');
      expect(mockExecSync.mock.calls[3][0]).toContain('build');
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('builds image when it does not exist', () => {
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('No such image'); })
        .mockReturnValueOnce(Buffer.from(''));

      ensureImage('claude', '/var/run/docker.sock');

      expect(mockExecSync).toHaveBeenCalledTimes(2);
      expect(mockExecSync.mock.calls[0][0]).toContain('image inspect');
      expect(mockExecSync.mock.calls[1][0]).toContain('docker -H unix:///var/run/docker.sock build');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Dockerfile'),
        expect.stringContaining('FROM node:22-slim'),
      );
    });
  });
});
