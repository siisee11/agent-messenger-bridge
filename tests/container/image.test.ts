/**
 * Unit tests for container image module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { imageExists, buildImage, ensureImage, FULL_IMAGE_TAG } from '../../src/container/image.js';

describe('container/image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    existingPaths.clear();
  });

  describe('FULL_IMAGE_TAG', () => {
    it('has expected format', () => {
      expect(FULL_IMAGE_TAG).toBe('discode-agent:1');
    });
  });

  describe('imageExists', () => {
    it('returns false when no socket found', () => {
      expect(imageExists()).toBe(false);
    });

    it('returns true when docker image inspect succeeds', () => {
      mockExecSync.mockReturnValue(Buffer.from('[{"Id": "sha256:abc"}]'));

      expect(imageExists('/var/run/docker.sock')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(`image inspect ${FULL_IMAGE_TAG}`),
        expect.anything(),
      );
    });

    it('returns false when docker image inspect throws', () => {
      mockExecSync.mockImplementation(() => { throw new Error('No such image'); });

      expect(imageExists('/var/run/docker.sock')).toBe(false);
    });
  });

  describe('buildImage', () => {
    it('throws when no socket found', () => {
      expect(() => buildImage()).toThrow('Docker socket not found');
    });

    it('creates temp dir, writes Dockerfile, and runs docker build', () => {
      buildImage('/var/run/docker.sock');

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-image-build-'),
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Dockerfile'),
        expect.stringContaining('FROM node:22-slim'),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('docker -H unix:///var/run/docker.sock build -t discode-agent:1'),
        expect.objectContaining({ timeout: 300_000 }),
      );
    });

    it('Dockerfile installs claude-code and creates coder user', () => {
      buildImage('/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      expect(dockerfile).toContain('@anthropic-ai/claude-code');
      expect(dockerfile).toContain('coder');
      expect(dockerfile).toContain('WORKDIR /workspace');
      expect(dockerfile).toContain('hasCompletedOnboarding');
    });

    it('Dockerfile handles existing uid/gid 1000 in base image', () => {
      buildImage('/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      // Should check for existing passwd entry before creating user
      expect(dockerfile).toContain('getent passwd 1000');
      // Should rename existing user with usermod if present
      expect(dockerfile).toContain('usermod -l coder');
      // Should also rename existing group
      expect(dockerfile).toContain('groupmod -n coder');
      // Fallback: create user from scratch if uid 1000 doesn't exist
      expect(dockerfile).toContain('useradd');
      // Should use numeric IDs for chown (robust regardless of user/group names)
      expect(dockerfile).toContain('chown -R 1000:1000');
    });

    it('Dockerfile has both rename and create-from-scratch branches', () => {
      buildImage('/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      // Rename branch: if getent passwd 1000 succeeds
      expect(dockerfile).toMatch(/if getent passwd 1000.*then/s);
      expect(dockerfile).toContain('usermod -l coder -d /home/coder -m');
      // Create branch: else clause with useradd
      expect(dockerfile).toMatch(/else.*useradd/s);
      expect(dockerfile).toContain('useradd -m -u 1000 -g 1000 -s /bin/bash coder');
      // Group handling: check before creating
      expect(dockerfile).toContain('getent group 1000');
      expect(dockerfile).toContain('groupadd -g 1000 coder');
    });

    it('Dockerfile has bash entrypoint for -c command injection', () => {
      buildImage('/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      // ENTRYPOINT must be bash -l so that CMD [-c, "command"] works
      expect(dockerfile).toContain('ENTRYPOINT ["/bin/bash", "-l"]');
    });

    it('Dockerfile does not hardcode groupadd -g 1000 unconditionally', () => {
      buildImage('/var/run/docker.sock');

      const dockerfile = mockWriteFileSync.mock.calls[0][1] as string;
      // groupadd -g 1000 must only appear inside the else branch (when uid 1000 doesn't exist)
      // It should NOT appear as a standalone top-level command
      const lines = dockerfile.split('\n').map(l => l.trim());
      const standaloneGroupadd = lines.filter(l =>
        l.startsWith('RUN groupadd -g 1000') && !l.includes('getent'),
      );
      expect(standaloneGroupadd).toHaveLength(0);
    });

    it('cleans up build directory even on failure', () => {
      mockExecSync.mockImplementation(() => { throw new Error('build failed'); });

      expect(() => buildImage('/var/run/docker.sock')).toThrow('build failed');
      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-image-build-'),
        { recursive: true, force: true },
      );
    });

    it('cleans up build directory on success', () => {
      buildImage('/var/run/docker.sock');

      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-image-build-'),
        { recursive: true, force: true },
      );
    });
  });

  describe('ensureImage', () => {
    it('does not build if image already exists', () => {
      mockExecSync.mockReturnValue(Buffer.from('[{"Id": "sha256:abc"}]'));

      ensureImage('/var/run/docker.sock');

      // Only the imageExists check, no build
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('image inspect'),
        expect.anything(),
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('builds image when it does not exist', () => {
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('No such image'); })
        .mockReturnValueOnce(Buffer.from(''));

      ensureImage('/var/run/docker.sock');

      // imageExists check + docker build
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
