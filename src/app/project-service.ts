import { request as httpRequest } from 'http';
import { AgentBridge } from '../index.js';
import { stateManager, type ProjectState } from '../state/index.js';
import type { BridgeConfig, ProjectInstanceState } from '../types/index.js';
import { TmuxManager } from '../tmux/manager.js';
import { agentRegistry } from '../agents/index.js';
import { installOpencodePlugin } from '../opencode/plugin-installer.js';
import { installClaudePlugin } from '../claude/plugin-installer.js';
import { installGeminiHook } from '../gemini/hook-installer.js';
import { installCodexHook } from '../codex/plugin-installer.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildExportPrefix(env: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    parts.push(`export ${key}=${escapeShellArg(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') + '; ' : '';
}

function toSharedWindowName(projectName: string, agentType: string): string {
  const raw = `${projectName}-${agentType}`;
  const safe = raw
    .replace(/[:\n\r\t]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe.length > 0 ? safe : agentType;
}

function resolveProjectWindowName(
  project: ProjectState,
  agentName: string,
  tmuxConfig: BridgeConfig['tmux'],
  instanceId?: string,
): string {
  const normalized = normalizeProjectState(project);
  const mapped =
    (instanceId ? getProjectInstance(normalized, instanceId)?.tmuxWindow : undefined) ||
    getPrimaryInstanceForAgent(normalized, agentName)?.tmuxWindow ||
    project.tmuxWindows?.[agentName];
  if (mapped && mapped.length > 0) return mapped;

  const sharedSession = `${tmuxConfig.sessionPrefix}${tmuxConfig.sharedSessionName || 'bridge'}`;
  if (project.tmuxSession === sharedSession) {
    const token = instanceId || agentName;
    return toSharedWindowName(project.projectName, token);
  }
  return instanceId || agentName;
}

export async function setupProjectInstance(params: {
  config: BridgeConfig;
  projectName: string;
  projectPath: string;
  agentName: string;
  instanceId: string;
  port: number;
}): Promise<{
  createdNewProject: boolean;
  channelName: string;
  channelId: string;
  instanceId: string;
}> {
  const existingProject = stateManager.getProject(params.projectName);
  const bridge = new AgentBridge({ config: params.config });
  await bridge.connect();

  try {
    const result = await bridge.setupProject(
      params.projectName,
      existingProject?.projectPath || params.projectPath,
      { [params.agentName]: true },
      undefined,
      params.port,
      { instanceId: params.instanceId },
    );

    try {
      await new Promise<void>((resolveDone) => {
        const req = httpRequest(`http://127.0.0.1:${params.port}/reload`, { method: 'POST' }, () => resolveDone());
        req.on('error', () => resolveDone());
        req.setTimeout(2000, () => {
          req.destroy();
          resolveDone();
        });
        req.end();
      });
    } catch {
      // daemon will pick up on next restart
    }

    return {
      createdNewProject: !existingProject,
      channelName: result.channelName,
      channelId: result.channelId,
      instanceId: params.instanceId,
    };
  } finally {
    await bridge.stop();
  }
}

export async function resumeProjectInstance(params: {
  config: BridgeConfig;
  projectName: string;
  project: ProjectState;
  instance: ProjectInstanceState;
  port: number;
}): Promise<{
  windowName: string;
  restoredWindow: boolean;
  infoMessages: string[];
  warningMessages: string[];
}> {
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const tmux = new TmuxManager(params.config.tmux.sessionPrefix);
  const fullSessionName = params.project.tmuxSession;
  const prefix = params.config.tmux.sessionPrefix;
  if (fullSessionName.startsWith(prefix)) {
    tmux.getOrCreateSession(fullSessionName.slice(prefix.length));
  }

  const sharedFull = `${prefix}${params.config.tmux.sharedSessionName || 'bridge'}`;
  const isSharedSession = fullSessionName === sharedFull;
  if (!isSharedSession) {
    tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PROJECT', params.projectName);
  }
  tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PORT', String(params.port));

  const windowName = resolveProjectWindowName(params.project, params.instance.agentType, params.config.tmux, params.instance.instanceId);
  if (tmux.windowExists(fullSessionName, windowName)) {
    return {
      windowName,
      restoredWindow: false,
      infoMessages,
      warningMessages,
    };
  }

  const adapter = agentRegistry.get(params.instance.agentType);
  if (!adapter) {
    warningMessages.push(`No adapter found for '${params.instance.agentType}', so missing window was not restored.`);
    return {
      windowName,
      restoredWindow: false,
      infoMessages,
      warningMessages,
    };
  }

  let claudePluginDir: string | undefined;
  let hookEnabled = !!params.instance.eventHook;

  if (params.instance.agentType === 'opencode') {
    try {
      const pluginPath = installOpencodePlugin(params.project.projectPath);
      hookEnabled = true;
      infoMessages.push(`Reinstalled OpenCode plugin: ${pluginPath}`);
    } catch (error) {
      warningMessages.push(`Could not reinstall OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (params.instance.agentType === 'claude') {
    try {
      claudePluginDir = installClaudePlugin(params.project.projectPath);
      hookEnabled = true;
      infoMessages.push(`Reinstalled Claude Code plugin: ${claudePluginDir}`);
    } catch (error) {
      warningMessages.push(`Could not reinstall Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (params.instance.agentType === 'gemini') {
    try {
      const hookPath = installGeminiHook(params.project.projectPath);
      hookEnabled = true;
      infoMessages.push(`Reinstalled Gemini CLI hook: ${hookPath}`);
    } catch (error) {
      warningMessages.push(`Could not reinstall Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (params.instance.agentType === 'codex') {
    try {
      const hookPath = installCodexHook();
      hookEnabled = true;
      infoMessages.push(`Reinstalled Codex notify hook: ${hookPath}`);
    } catch (error) {
      warningMessages.push(`Could not reinstall Codex notify hook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const permissionAllow =
    params.instance.agentType === 'opencode' && params.config.opencode?.permissionMode === 'allow';
  let baseCommand = adapter.getStartCommand(params.project.projectPath, permissionAllow);

  if (claudePluginDir && !(/--plugin-dir\b/.test(baseCommand))) {
    const pluginPattern = /((?:^|&&|;)\s*)claude\b/;
    if (pluginPattern.test(baseCommand)) {
      baseCommand = baseCommand.replace(pluginPattern, `$1claude --plugin-dir ${escapeShellArg(claudePluginDir)}`);
    }
  }

  const startCommand =
    buildExportPrefix({
      AGENT_DISCORD_PROJECT: params.projectName,
      AGENT_DISCORD_PORT: String(params.port),
      AGENT_DISCORD_AGENT: params.instance.agentType,
      AGENT_DISCORD_INSTANCE: params.instance.instanceId,
      ...(permissionAllow ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {}),
    }) + baseCommand;

  tmux.startAgentInWindow(fullSessionName, windowName, startCommand);
  infoMessages.push(`Restored missing tmux window: ${windowName}`);

  if (hookEnabled && !params.instance.eventHook) {
    const normalizedProject = normalizeProjectState(params.project);
    const updatedProject: ProjectState = {
      ...normalizedProject,
      instances: {
        ...(normalizedProject.instances || {}),
        [params.instance.instanceId]: {
          ...params.instance,
          eventHook: true,
        },
      },
    };
    stateManager.setProject(updatedProject);
  }

  return {
    windowName,
    restoredWindow: true,
    infoMessages,
    warningMessages,
  };
}

export function removeInstanceFromProjectState(projectName: string, instanceId: string): {
  projectFound: boolean;
  instanceFound: boolean;
  removedProject: boolean;
} {
  const project = stateManager.getProject(projectName);
  if (!project) {
    return {
      projectFound: false,
      instanceFound: false,
      removedProject: false,
    };
  }

  const normalized = normalizeProjectState(project);
  if (!normalized.instances?.[instanceId]) {
    return {
      projectFound: true,
      instanceFound: false,
      removedProject: false,
    };
  }

  const nextInstances = { ...(normalized.instances || {}) };
  delete nextInstances[instanceId];

  if (Object.keys(nextInstances).length === 0) {
    stateManager.removeProject(projectName);
    return {
      projectFound: true,
      instanceFound: true,
      removedProject: true,
    };
  }

  stateManager.setProject({
    ...normalized,
    instances: nextInstances,
    lastActive: new Date(),
  });
  return {
    projectFound: true,
    instanceFound: true,
    removedProject: false,
  };
}

export function removeProjectState(projectName: string): boolean {
  const project = stateManager.getProject(projectName);
  if (!project) return false;
  stateManager.removeProject(projectName);
  return true;
}
