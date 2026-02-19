import { escapeShellArg } from '../infra/shell-escape.js';

export function buildExportPrefix(env: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    parts.push(`export ${key}=${escapeShellArg(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') + '; ' : '';
}

export function withClaudePluginDir(command: string, pluginDir?: string): string {
  if (!pluginDir || pluginDir.length === 0) return command;
  if (/--plugin-dir\b/.test(command)) return command;
  const pattern = /((?:^|&&|;)\s*)claude\b/;
  if (!pattern.test(command)) return command;
  return command.replace(pattern, `$1claude --plugin-dir ${escapeShellArg(pluginDir)}`);
}

export function buildAgentLaunchEnv(params: {
  projectName: string;
  port: number;
  agentType: string;
  instanceId: string;
  permissionAllow: boolean;
  /** Override hostname for container→host communication. */
  hostname?: string;
}): Record<string, string> {
  return {
    AGENT_DISCORD_PROJECT: params.projectName,
    AGENT_DISCORD_PORT: String(params.port),
    AGENT_DISCORD_AGENT: params.agentType,
    AGENT_DISCORD_INSTANCE: params.instanceId,
    ...(params.hostname ? { AGENT_DISCORD_HOSTNAME: params.hostname } : {}),
    ...(params.permissionAllow ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {}),
  };
}

/**
 * Build environment variables map for a container-based agent session.
 *
 * These are passed as `-e` flags to `docker create` (not shell exports),
 * so they don't need shell escaping.
 */
export function buildContainerEnv(params: {
  projectName: string;
  port: number;
  agentType: string;
  instanceId: string;
  permissionAllow: boolean;
}): Record<string, string> {
  return {
    AGENT_DISCORD_PROJECT: params.projectName,
    AGENT_DISCORD_PORT: String(params.port),
    AGENT_DISCORD_AGENT: params.agentType,
    AGENT_DISCORD_INSTANCE: params.instanceId,
    // Container→host communication via Docker's built-in DNS
    AGENT_DISCORD_HOSTNAME: 'host.docker.internal',
    ...(params.permissionAllow ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {}),
  };
}
