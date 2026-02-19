/**
 * Periodic file synchronization between host and container.
 *
 * Uses `find -newer` inside the container to detect changed files,
 * then copies them back to the host project directory.
 *
 * The sync runs every 30 seconds (configurable) and is used to keep
 * the host copy of agent-generated files up to date for Discord file
 * sending via the bridge.
 *
 * The timer uses .unref() so it doesn't prevent Node from exiting.
 */

import { join, dirname } from 'path';
import { execInContainer, isContainerRunning, extractFile, WORKSPACE_DIR } from './manager.js';

const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const MARKER_FILE = '.discode/.sync-marker';
const MAX_SYNC_FILES = 200;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export interface ContainerSyncOptions {
  containerId: string;
  projectPath: string;
  socketPath?: string;
  intervalMs?: number;
}

export class ContainerSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly containerId: string;
  private readonly projectPath: string;
  private readonly socketPath?: string;
  private readonly intervalMs: number;

  constructor(options: ContainerSyncOptions) {
    this.containerId = options.containerId;
    this.projectPath = options.projectPath;
    this.socketPath = options.socketPath;
    this.intervalMs = options.intervalMs || DEFAULT_SYNC_INTERVAL_MS;
  }

  /**
   * Start periodic sync. Creates the marker file on first run.
   */
  start(): void {
    if (this.timer) return;

    // Defer the initial touchMarker so the container has time to start.
    // The first syncOnce (after intervalMs) will call touchMarker if needed.
    this.timer = setInterval(() => {
      this.syncOnce();
    }, this.intervalMs);

    // Don't keep the process alive just for sync
    this.timer.unref();
  }

  /**
   * Stop periodic sync.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Perform a single sync cycle:
   * 1. Find files changed since the marker inside the container
   * 2. Copy them to the host
   * 3. Update the marker
   */
  syncOnce(): void {
    if (!isContainerRunning(this.containerId, this.socketPath)) {
      console.warn(`[container-sync] Container ${this.containerId} not running, stopping sync`);
      this.stop();
      return;
    }

    try {
      // Find files newer than the marker (skip .git, node_modules, .discode)
      const findCmd = [
        `find ${WORKSPACE_DIR}`,
        `-newer ${WORKSPACE_DIR}/${MARKER_FILE}`,
        '-type f',
        '-not -path "*/.git/*"',
        '-not -path "*/node_modules/*"',
        '-not -path "*/.discode/.sync-marker"',
        `-size -${MAX_FILE_SIZE}c`,
        `| head -${MAX_SYNC_FILES}`,
      ].join(' ');

      const output = execInContainer(this.containerId, findCmd, this.socketPath);
      if (!output) {
        this.touchMarker();
        return;
      }

      const files = output.split('\n').filter(Boolean);
      let synced = 0;

      for (const containerPath of files) {
        // Convert container path to host path
        const relativePath = containerPath.replace(`${WORKSPACE_DIR}/`, '');
        const hostDir = dirname(join(this.projectPath, relativePath));

        const success = extractFile(this.containerId, containerPath, hostDir, this.socketPath);
        if (success) synced++;
      }

      if (synced > 0) {
        console.log(`[container-sync] Synced ${synced} file(s) from container`);
      }

      this.touchMarker();
    } catch (error) {
      // Non-critical: log and continue
      console.warn(`[container-sync] Sync error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Perform a final sync before container removal.
   * Same as syncOnce but with a fresh marker reset.
   */
  finalSync(): void {
    this.syncOnce();
  }

  private touchMarker(): void {
    try {
      execInContainer(
        this.containerId,
        `mkdir -p ${WORKSPACE_DIR}/.discode && touch ${WORKSPACE_DIR}/${MARKER_FILE}`,
        this.socketPath,
      );
    } catch {
      // Non-critical
    }
  }
}
