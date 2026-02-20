/**
 * Docker image builder for container-isolated agent sessions.
 *
 * Builds per-agent images (e.g. discode-agent-claude:1, discode-agent-opencode:1)
 * with only the required CLI installed.
 *
 * Each image includes:
 * - Non-root `coder` user (Claude Code refuses --dangerously-skip-permissions as root)
 * - hasCompletedOnboarding: true to bypass interactive onboarding
 * - /workspace as the hardcoded working directory
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentType } from '../agents/base.js';
import { findDockerSocket } from './manager.js';

const HASH_LABEL = 'discode.dockerfile.hash';

const IMAGE_PREFIX = 'discode-agent';
const IMAGE_VERSION = '1';

/** Map agent type to its npm package name. */
const AGENT_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai',
};

/** Get the full image tag for a given agent type. */
export function imageTagFor(agentType: AgentType): string {
  return `${IMAGE_PREFIX}-${agentType}:${IMAGE_VERSION}`;
}

function dockerfileBody(agentType: AgentType): string {
  const pkg = AGENT_PACKAGES[agentType];
  if (!pkg) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  return `FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl ca-certificates ripgrep \\
    && rm -rf /var/lib/apt/lists/*

# Install ${agentType} CLI
RUN npm install -g ${pkg}

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

function dockerfileHash(agentType: AgentType): string {
  return createHash('sha256').update(dockerfileBody(agentType)).digest('hex').slice(0, 12);
}

function generateDockerfile(agentType: AgentType): string {
  return `${dockerfileBody(agentType)}LABEL ${HASH_LABEL}="${dockerfileHash(agentType)}"
`;
}

/**
 * Check if an agent image exists.
 */
export function imageExists(agentType: AgentType, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;
  const tag = imageTagFor(agentType);
  try {
    const result = execSync(
      `docker -H unix://${sock} image inspect ${tag}`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Build an agent image.
 *
 * Uses a temp directory for the build context to avoid polluting the project.
 */
export function buildImage(agentType: AgentType, socketPath?: string): void {
  const sock = socketPath || findDockerSocket();
  if (!sock) {
    throw new Error('Docker socket not found. Is Docker running?');
  }

  const tag = imageTagFor(agentType);
  const buildDir = join(tmpdir(), `discode-image-build-${Date.now()}`);
  mkdirSync(buildDir, { recursive: true });

  try {
    writeFileSync(join(buildDir, 'Dockerfile'), generateDockerfile(agentType));
    execSync(
      `docker -H unix://${sock} build -t ${tag} ${buildDir}`,
      { stdio: 'inherit', timeout: 300_000 },
    );
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

/**
 * Read the Dockerfile hash label from an existing image.
 * Returns null if the image doesn't exist or has no label.
 */
function getImageHash(agentType: AgentType, socketPath: string): string | null {
  const tag = imageTagFor(agentType);
  try {
    const out = execSync(
      `docker -H unix://${socketPath} inspect --format '{{index .Config.Labels "${HASH_LABEL}"}}' ${tag}`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Remove an agent image.
 */
export function removeImage(agentType: AgentType, socketPath?: string): void {
  const sock = socketPath || findDockerSocket();
  if (!sock) return;
  const tag = imageTagFor(agentType);
  try {
    execSync(`docker -H unix://${sock} rmi ${tag}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { /* image may not exist */ }
}

/**
 * Ensure the agent image is up-to-date.
 * Removes and rebuilds when the Dockerfile content has changed.
 */
export function ensureImage(agentType: AgentType, socketPath?: string): void {
  const sock = socketPath || findDockerSocket();
  if (!sock) {
    buildImage(agentType, socketPath);
    return;
  }

  if (imageExists(agentType, sock)) {
    if (getImageHash(agentType, sock) === dockerfileHash(agentType)) return;
    removeImage(agentType, sock);
  }
  buildImage(agentType, sock);
}

export { IMAGE_PREFIX };
