/**
 * Docker container lifecycle management.
 *
 * Creates, starts, stops, and removes containers.
 * Handles tar-based file injection/extraction for bridging files
 * between host and container.
 *
 * Key constraints:
 * - Docker socket: tries OrbStack -> Docker Desktop -> Colima -> Lima
 * - Non-root `coder` user inside containers
 * - /workspace is the hardcoded working directory
 * - uid/gid mapped to 1000:1000 (the coder user)
 * - 50MB max per file for tar injection
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { FULL_IMAGE_TAG, ensureImage } from './image.js';

const WORKSPACE_DIR = '/workspace';
const MAX_INJECT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const CONTAINER_UID = '1000';
const CONTAINER_GID = '1000';

/**
 * Docker socket search order:
 * OrbStack -> Docker Desktop -> Colima -> Lima -> /var/run/docker.sock
 */
const DOCKER_SOCKET_CANDIDATES = [
  `${homedir()}/.orbstack/run/docker.sock`,
  `${homedir()}/.docker/run/docker.sock`,
  `${homedir()}/.colima/default/docker.sock`,
  `${homedir()}/.lima/default/sock/docker.sock`,
  '/var/run/docker.sock',
];

/**
 * Find a working Docker socket path.
 */
export function findDockerSocket(): string | null {
  for (const candidate of DOCKER_SOCKET_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Check if Docker is available and responsive.
 */
export function isDockerAvailable(socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;
  try {
    execSync(`docker -H unix://${sock} info`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface ContainerCreateOptions {
  containerName: string;
  projectPath: string;
  socketPath?: string;
  env?: Record<string, string>;
  /** Additional -v volume mounts (e.g. host:container:ro). */
  volumes?: string[];
  /** Shell command to run inside the container (passed as CMD via `-c`). */
  command?: string;
}

/**
 * Create and prepare a container for an agent session.
 *
 * The container is created in stopped state with:
 * - Interactive tty (-it) for `docker start -ai`
 * - /workspace bind-mounted from the project path
 * - Environment variables for bridge communication
 * - host.docker.internal mapped for host access
 */
export function createContainer(options: ContainerCreateOptions): string {
  const sock = options.socketPath || findDockerSocket();
  if (!sock) {
    throw new Error('Docker socket not found. Is Docker running?');
  }

  ensureImage(sock);

  // Remove stale container with the same name (left over from a previous run)
  try {
    execFileSync('docker', ['-H', `unix://${sock}`, 'rm', '-f', options.containerName], {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch {
    // Container didn't exist — fine
  }

  const envFlags: string[] = [];
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      envFlags.push('-e', `${key}=${value}`);
    }
  }

  const volumeFlags: string[] = [];
  if (options.volumes) {
    for (const v of options.volumes) {
      volumeFlags.push('-v', v);
    }
  }

  const args = [
    '-H', `unix://${sock}`,
    'create',
    '--name', options.containerName,
    '-it',
    '-w', WORKSPACE_DIR,
    '-v', `${options.projectPath}:${WORKSPACE_DIR}`,
    ...volumeFlags,
    '--add-host', 'host.docker.internal:host-gateway',
    '-u', `${CONTAINER_UID}:${CONTAINER_GID}`,
    ...envFlags,
    FULL_IMAGE_TAG,
    ...(options.command ? ['-c', options.command] : []),
  ];

  const result = execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout: 30_000,
  });

  return result.trim().slice(0, 12); // short container ID
}

/**
 * Build the `docker start -ai <containerId>` command string
 * that the runtime will execute to attach to the container.
 */
export function buildDockerStartCommand(containerId: string, socketPath?: string): string {
  const sock = socketPath || findDockerSocket();
  if (sock) {
    return `docker -H unix://${sock} start -ai ${containerId}`;
  }
  return `docker start -ai ${containerId}`;
}

/**
 * Inject credentials (Claude OAuth/API key) into a container.
 *
 * Uses `docker cp` so it works on stopped containers (before `docker start`).
 * Reads credentials from the host ~/.claude config and copies them into the
 * container filesystem.
 */
export function injectCredentials(containerId: string, socketPath?: string): void {
  const sock = socketPath || findDockerSocket();
  if (!sock) return;

  const copyToContainer = (content: string, containerPath: string): void => {
    const tmp = join(tmpdir(), `discode-inject-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      writeFileSync(tmp, content);
      execSync(
        `docker -H unix://${sock} cp ${tmp} ${containerId}:${containerPath}`,
        { timeout: 10_000 },
      );
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  };

  // Inject Claude settings with onboarding bypass
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      settings.hasCompletedOnboarding = true;
      copyToContainer(JSON.stringify(settings, null, 2), '/home/coder/.claude/settings.json');
    } catch {
      // Non-critical: credentials injection is best-effort
    }
  }

  // Inject Claude .credentials.json — try plaintext file first, then macOS Keychain.
  // Claude Code on Linux uses ~/.claude/.credentials.json for plaintext credential storage.
  const credentialsPath = join(claudeDir, '.credentials.json');
  if (existsSync(credentialsPath)) {
    try {
      copyToContainer(readFileSync(credentialsPath, 'utf-8'), '/home/coder/.claude/.credentials.json');
    } catch {
      // Non-critical
    }
  } else if (process.platform === 'darwin') {
    // Claude Code stores OAuth tokens in macOS Keychain, not on disk.
    // Extract them so the container (Linux) can read them as a file.
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { timeout: 5_000, encoding: 'utf-8' },
      ).trim();
      if (raw) {
        copyToContainer(raw, '/home/coder/.claude/.credentials.json');
      }
    } catch {
      // Keychain entry may not exist — non-critical
    }
  }

  // Inject .claude.json (API key config) if it exists
  const claudeJsonPath = join(homedir(), '.claude.json');
  if (existsSync(claudeJsonPath)) {
    try {
      copyToContainer(readFileSync(claudeJsonPath, 'utf-8'), '/home/coder/.claude.json');
    } catch {
      // Non-critical
    }
  }
}

/**
 * Inject a file into the container at the given path.
 * Skips files over MAX_INJECT_FILE_SIZE.
 */
export function injectFile(
  containerId: string,
  hostPath: string,
  containerDir: string,
  socketPath?: string,
): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    const stat = statSync(hostPath);
    if (stat.size > MAX_INJECT_FILE_SIZE) {
      console.warn(`Skipping file injection (>50MB): ${hostPath}`);
      return false;
    }
  } catch {
    return false;
  }

  try {
    // Ensure target directory exists
    execSync(
      `docker -H unix://${sock} exec ${containerId} mkdir -p ${containerDir}`,
      { timeout: 5000 },
    );

    // Use docker cp for file transfer
    execSync(
      `docker -H unix://${sock} cp ${hostPath} ${containerId}:${containerDir}/`,
      { timeout: 30_000 },
    );

    // Fix ownership
    const filename = basename(hostPath);
    execSync(
      `docker -H unix://${sock} exec ${containerId} chown ${CONTAINER_UID}:${CONTAINER_GID} ${containerDir}/${filename}`,
      { timeout: 5000 },
    );

    return true;
  } catch (error) {
    console.warn(`Failed to inject file into container: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Extract a file from the container to the host.
 */
export function extractFile(
  containerId: string,
  containerPath: string,
  hostDir: string,
  socketPath?: string,
): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    mkdirSync(hostDir, { recursive: true });
    execSync(
      `docker -H unix://${sock} cp ${containerId}:${containerPath} ${hostDir}/`,
      { timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a container is running.
 */
export function isContainerRunning(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    const result = execSync(
      `docker -H unix://${sock} inspect -f '{{.State.Running}}' ${containerId}`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if a container exists (running or stopped).
 */
export function containerExists(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} inspect ${containerId}`,
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a container gracefully (10s timeout before SIGKILL).
 */
export function stopContainer(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} stop -t 10 ${containerId}`,
      { timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a container (force remove if still running).
 */
export function removeContainer(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} rm -f ${containerId}`,
      { timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a stopped container (non-interactive, background).
 */
export function startContainerBackground(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} start ${containerId}`,
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a command inside a running container and return stdout.
 */
export function execInContainer(containerId: string, command: string, socketPath?: string): string {
  const sock = socketPath || findDockerSocket();
  if (!sock) throw new Error('Docker socket not found');

  return execSync(
    `docker -H unix://${sock} exec ${containerId} sh -c ${escapeForSh(command)}`,
    { encoding: 'utf-8', timeout: 30_000 },
  ).trim();
}

function escapeForSh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const BRIDGE_SCRIPT_FILENAME = 'chrome-mcp-bridge.cjs';

/**
 * Resolve the host-side path to the chrome-mcp-bridge.cjs script.
 * Uses the same candidate-search pattern as the plugin installers.
 */
function resolveBridgeScriptPath(): string | null {
  const execDir = dirname(process.execPath);
  const candidates = [
    join(import.meta.dirname, BRIDGE_SCRIPT_FILENAME),                     // source layout: src/container/
    join(import.meta.dirname, 'container', BRIDGE_SCRIPT_FILENAME),        // bundled chunk in dist/
    join(import.meta.dirname, '../container', BRIDGE_SCRIPT_FILENAME),     // bundled entry in dist/src/
    join(execDir, '..', 'resources', BRIDGE_SCRIPT_FILENAME),              // compiled binary
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

/**
 * Agent-specific config paths and MCP config builders.
 */
interface AgentMcpConfig {
  /** Host-side config file to read as a base. */
  hostConfigPath: string;
  /** Container path to write the merged config. */
  containerConfigPath: string;
  /** Merge the chrome-in-chrome MCP entry into the config object. */
  merge(config: Record<string, any>, port: number): void;
}

function getAgentMcpConfig(agentType: string): AgentMcpConfig | null {
  switch (agentType) {
    case 'claude':
      return {
        hostConfigPath: join(homedir(), '.claude.json'),
        containerConfigPath: '/home/coder/.claude.json',
        merge(config, port) {
          if (!config.mcpServers) config.mcpServers = {};
          config.mcpServers['claude-in-chrome'] = {
            type: 'stdio',
            command: 'node',
            args: [`/tmp/${BRIDGE_SCRIPT_FILENAME}`],
            env: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: String(port) },
          };
        },
      };
    case 'gemini':
      return {
        hostConfigPath: join(homedir(), '.gemini', 'settings.json'),
        containerConfigPath: '/home/coder/.gemini/settings.json',
        merge(config, port) {
          if (!config.mcpServers) config.mcpServers = {};
          config.mcpServers['claude-in-chrome'] = {
            command: 'node',
            args: [`/tmp/${BRIDGE_SCRIPT_FILENAME}`],
            env: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: String(port) },
          };
        },
      };
    case 'opencode':
      return {
        hostConfigPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
        containerConfigPath: '/home/coder/.config/opencode/opencode.json',
        merge(config, port) {
          if (!config.mcp) config.mcp = {};
          config.mcp['claude-in-chrome'] = {
            type: 'local',
            command: ['node', `/tmp/${BRIDGE_SCRIPT_FILENAME}`],
            environment: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: String(port) },
          };
        },
      };
    default:
      return null;
  }
}

/**
 * Inject the Chrome MCP bridge into a container.
 *
 * 1. Copies chrome-mcp-bridge.cjs to /tmp/ inside the container
 * 2. Reads the host-side agent config, adds the chrome MCP server entry,
 *    and writes the merged config into the container.
 *
 * Supports agent-specific config formats:
 * - claude:   ~/.claude.json          → mcpServers (stdio)
 * - gemini:   ~/.gemini/settings.json → mcpServers (command+args)
 * - opencode: ~/.config/opencode/opencode.json → mcp (local, command array)
 *
 * Must be called AFTER injectCredentials() so base configs exist.
 */
export function injectChromeMcpBridge(
  containerId: string,
  proxyPort: number,
  agentType: string,
  socketPath?: string,
): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  const bridgeScriptPath = resolveBridgeScriptPath();
  if (!bridgeScriptPath) {
    console.warn('Chrome MCP bridge script not found; skipping injection');
    return false;
  }

  const copyToContainer = (content: string, containerPath: string): void => {
    const tmp = join(tmpdir(), `discode-inject-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      writeFileSync(tmp, content);
      execSync(
        `docker -H unix://${sock} cp ${tmp} ${containerId}:${containerPath}`,
        { timeout: 10_000 },
      );
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  };

  try {
    // 1. Copy bridge script into container
    execSync(
      `docker -H unix://${sock} cp ${bridgeScriptPath} ${containerId}:/tmp/${BRIDGE_SCRIPT_FILENAME}`,
      { timeout: 10_000 },
    );

    // 2. Build and inject agent-specific MCP config
    const mcpConfig = getAgentMcpConfig(agentType);
    if (mcpConfig) {
      let config: Record<string, any> = {};
      if (existsSync(mcpConfig.hostConfigPath)) {
        try {
          config = JSON.parse(readFileSync(mcpConfig.hostConfigPath, 'utf-8'));
        } catch {
          // Malformed JSON — start fresh
        }
      }

      mcpConfig.merge(config, proxyPort);

      copyToContainer(
        JSON.stringify(config, null, 2),
        mcpConfig.containerConfigPath,
      );
    }

    return true;
  } catch (error) {
    console.warn(
      `Failed to inject Chrome MCP bridge: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export { WORKSPACE_DIR };
