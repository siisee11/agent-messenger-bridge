/**
 * Unit tests for container sync module.
 *
 * Tests timer lifecycle (start/stop) and sync logic with mocked
 * container exec calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the manager module that sync depends on
const mockExecInContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockExtractFile = vi.fn();

vi.mock('../../src/container/manager.js', () => ({
  execInContainer: (...args: any[]) => mockExecInContainer(...args),
  isContainerRunning: (...args: any[]) => mockIsContainerRunning(...args),
  extractFile: (...args: any[]) => mockExtractFile(...args),
  WORKSPACE_DIR: '/workspace',
}));

import { ContainerSync } from '../../src/container/sync.js';

describe('container/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockIsContainerRunning.mockReturnValue(true);
    mockExecInContainer.mockReturnValue('');
    mockExtractFile.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start/stop lifecycle', () => {
    it('creates a timer on start without calling touchMarker immediately', () => {
      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 5000,
      });

      sync.start();

      // touchMarker is deferred — not called on start() so the container has time to boot
      expect(mockExecInContainer).not.toHaveBeenCalled();

      sync.stop();
    });

    it('does not create duplicate timers on double start', () => {
      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 5000,
      });

      sync.start();
      const firstCallCount = mockExecInContainer.mock.calls.length;

      sync.start(); // second start should be no-op
      expect(mockExecInContainer.mock.calls.length).toBe(firstCallCount);

      sync.stop();
    });

    it('stop is safe to call without start', () => {
      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
      });

      expect(() => sync.stop()).not.toThrow();
    });

    it('first interval tick calls syncOnce which creates the marker', () => {
      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 5000,
      });

      sync.start();

      // Nothing called yet (deferred)
      expect(mockExecInContainer).not.toHaveBeenCalled();

      // Advance to first interval tick
      vi.advanceTimersByTime(5000);

      // syncOnce should have run: isContainerRunning check + find command + touchMarker
      expect(mockIsContainerRunning).toHaveBeenCalledWith('abc123', undefined);
      // touchMarker creates the marker file via execInContainer
      expect(mockExecInContainer).toHaveBeenCalledWith(
        'abc123',
        expect.stringContaining('touch /workspace/.discode/.sync-marker'),
        undefined,
      );

      sync.stop();
    });

    it('does not call docker exec between start() and first interval', () => {
      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 30000,
      });

      sync.start();

      // Advance less than one interval (simulates container still booting)
      vi.advanceTimersByTime(10000);

      // No docker exec calls should have been made yet
      expect(mockExecInContainer).not.toHaveBeenCalled();
      expect(mockIsContainerRunning).not.toHaveBeenCalled();

      sync.stop();
    });
  });

  describe('syncOnce', () => {
    it('stops sync when container is not running', () => {
      mockIsContainerRunning.mockReturnValue(false);

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 5000,
      });

      sync.start();
      vi.clearAllMocks();
      mockIsContainerRunning.mockReturnValue(false);

      sync.syncOnce();

      // Should not attempt find command when container is not running
      expect(mockExecInContainer).not.toHaveBeenCalled();
    });

    it('extracts changed files from container', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer
        .mockReturnValueOnce('/workspace/src/app.ts\n/workspace/README.md')  // find command
        .mockReturnValue('');  // touchMarker

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
      });

      sync.syncOnce();

      expect(mockExtractFile).toHaveBeenCalledTimes(2);
      expect(mockExtractFile).toHaveBeenCalledWith(
        'abc123',
        '/workspace/src/app.ts',
        '/test/project/src',
        undefined,
      );
      expect(mockExtractFile).toHaveBeenCalledWith(
        'abc123',
        '/workspace/README.md',
        '/test/project',
        undefined,
      );
    });

    it('handles empty find result gracefully', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer.mockReturnValue('');

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
      });

      expect(() => sync.syncOnce()).not.toThrow();
      expect(mockExtractFile).not.toHaveBeenCalled();
    });

    it('handles exec error gracefully', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer.mockImplementation(() => { throw new Error('exec failed'); });

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
      });

      expect(() => sync.syncOnce()).not.toThrow();
    });

    it('passes socketPath to all container calls', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer.mockReturnValue('');

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        socketPath: '/custom/docker.sock',
      });

      sync.syncOnce();

      expect(mockIsContainerRunning).toHaveBeenCalledWith('abc123', '/custom/docker.sock');
    });
  });

  describe('periodic execution', () => {
    it('calls syncOnce at configured interval', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer.mockReturnValue('');

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 1000,
      });

      sync.start();
      vi.clearAllMocks();
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer.mockReturnValue('');

      // Advance timer by 3 intervals
      vi.advanceTimersByTime(3000);

      // Should have called isContainerRunning 3 times (once per interval)
      expect(mockIsContainerRunning).toHaveBeenCalledTimes(3);

      sync.stop();
    });

    it('stops executing after stop is called', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer.mockReturnValue('');

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
        intervalMs: 1000,
      });

      sync.start();
      sync.stop();

      vi.clearAllMocks();
      vi.advanceTimersByTime(5000);

      expect(mockIsContainerRunning).not.toHaveBeenCalled();
    });
  });

  describe('finalSync', () => {
    it('calls syncOnce for final synchronization', () => {
      mockIsContainerRunning.mockReturnValue(true);
      mockExecInContainer
        .mockReturnValueOnce('/workspace/output.txt')
        .mockReturnValue('');

      const sync = new ContainerSync({
        containerId: 'abc123',
        projectPath: '/test/project',
      });

      sync.finalSync();

      expect(mockExtractFile).toHaveBeenCalledWith(
        'abc123',
        '/workspace/output.txt',
        '/test/project',
        undefined,
      );
    });
  });
});
