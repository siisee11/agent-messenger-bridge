/**
 * Docker image builder for container-isolated agent sessions.
 *
 * Generates a Dockerfile and builds an image with:
 * - Non-root `coder` user (Claude Code refuses --dangerously-skip-permissions as root)
 * - Pre-configured Claude Code credentials injected as files
 * - hasCompletedOnboarding: true to bypass interactive onboarding
 * - /workspace as the hardcoded working directory
 */

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findDockerSocket } from './manager.js';

const IMAGE_TAG = 'discode-agent';
const IMAGE_VERSION = '1';
const FULL_IMAGE_TAG = `${IMAGE_TAG}:${IMAGE_VERSION}`;

function generateDockerfile(): string {
  return `FROM node:22-slim

# System dependencies for Claude Code
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl ca-certificates ripgrep \\
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user – reuse uid/gid 1000 if the base image already has it
RUN if getent passwd 1000 >/dev/null 2>&1; then \\
      old_user=$(getent passwd 1000 | cut -d: -f1); \\
      old_group=$(getent group 1000 | cut -d: -f1); \\
      [ "$old_user" != "coder" ] && usermod -l coder -d /home/coder -m "$old_user" || true; \\
      [ -n "$old_group" ] && [ "$old_group" != "coder" ] && groupmod -n coder "$old_group" || true; \\
    else \\
      (getent group 1000 >/dev/null 2>&1 || groupadd -g 1000 coder) && \\
      useradd -m -u 1000 -g 1000 -s /bin/bash coder; \\
    fi

# Pre-create directories with correct ownership
RUN mkdir -p /workspace /home/coder/.claude && \\
    chown -R 1000:1000 /workspace /home/coder

USER coder
WORKDIR /workspace

# Bypass onboarding (Claude Code checks this on first run)
RUN mkdir -p /home/coder/.claude && \\
    echo '{"hasCompletedOnboarding":true}' > /home/coder/.claude/settings.json

# Default entrypoint: bash shell (agent command injected at start)
ENTRYPOINT ["/bin/bash", "-l"]
`;
}

/**
 * Check if the discode-agent image exists.
 */
export function imageExists(socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;
  try {
    const result = execSync(
      `docker -H unix://${sock} image inspect ${FULL_IMAGE_TAG}`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the discode-agent Docker image.
 *
 * Uses a temp directory for the build context to avoid polluting the project.
 */
export function buildImage(socketPath?: string): void {
  const sock = socketPath || findDockerSocket();
  if (!sock) {
    throw new Error('Docker socket not found. Is Docker running?');
  }

  const buildDir = join(tmpdir(), `discode-image-build-${Date.now()}`);
  mkdirSync(buildDir, { recursive: true });

  try {
    writeFileSync(join(buildDir, 'Dockerfile'), generateDockerfile());
    execSync(
      `docker -H unix://${sock} build -t ${FULL_IMAGE_TAG} ${buildDir}`,
      { stdio: 'inherit', timeout: 300_000 },
    );
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

/**
 * Ensure the discode-agent image exists, building it if needed.
 */
export function ensureImage(socketPath?: string): void {
  if (!imageExists(socketPath)) {
    buildImage(socketPath);
  }
}

export { FULL_IMAGE_TAG, IMAGE_TAG };
