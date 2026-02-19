import { request as httpRequest } from 'http';
import { AgentBridge } from '../index.js';
import { stateManager, type ProjectState } from '../state/index.js';
import type { BridgeConfig, ProjectInstanceState } from '../types/index.js';
import { agentRegistry } from '../agents/index.js';
import { normalizeProjectState } from '../state/instances.js';
import { buildAgentLaunchEnv, buildExportPrefix, withClaudePluginDir } from '../policy/agent-launch.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import { resolveProjectWindowName } from '../policy/window-naming.js';
import type { AgentRuntime } from '../runtime/interface.js';
import { TmuxRuntime } from '../runtime/tmux-runtime.js';
import { containerExists, buildDockerStartCommand } from '../container/index.js';

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
      {
        instanceId: params.instanceId,
        skipRuntimeStart: (params.config.runtimeMode || 'tmux') === 'pty',
      },
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

    if ((params.config.runtimeMode || 'tmux') === 'pty') {
      try {
        const ensureOnce = async () => {
          return await new Promise<number>((resolveDone) => {
            const payload = JSON.stringify({
              projectName: params.projectName,
              instanceId: params.instanceId,
              permissionAllow: params.config.opencode?.permissionMode === 'allow',
            });
            const req = httpRequest(
              {
                hostname: '127.0.0.1',
                port: params.port,
                path: '/runtime/ensure',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                },
              },
              (res) => resolveDone(res.statusCode || 0),
            );
            req.on('error', () => resolveDone(0));
            req.setTimeout(2000, () => {
              req.destroy();
              resolveDone(0);
            });
            req.write(payload);
            req.end();
          });
        };

        let ensured = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          const status = await ensureOnce();
          if (status >= 200 && status < 300) {
            ensured = true;
            break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
        }

        if (!ensured) {
          console.warn(`⚠️ Could not ensure runtime window for ${params.projectName}#${params.instanceId}`);
        }
      } catch {
        // non-critical; attach fallback remains available
      }
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
  runtime?: AgentRuntime;
}): Promise<{
  windowName: string;
  restoredWindow: boolean;
  infoMessages: string[];
  warningMessages: string[];
}> {
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const runtime = params.runtime || TmuxRuntime.create(params.config.tmux.sessionPrefix);
  const fullSessionName = params.project.tmuxSession;
  const prefix = params.config.tmux.sessionPrefix;
  if (fullSessionName.startsWith(prefix)) {
    runtime.getOrCreateSession(fullSessionName.slice(prefix.length));
  }

  const sharedFull = `${prefix}${params.config.tmux.sharedSessionName || 'bridge'}`;
  const isSharedSession = fullSessionName === sharedFull;
  if (!isSharedSession) {
    runtime.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PROJECT', params.projectName);
  }
  runtime.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PORT', String(params.port));

  const windowName = resolveProjectWindowName(params.project, params.instance.agentType, params.config.tmux, params.instance.instanceId);
  if (runtime.windowExists(fullSessionName, windowName)) {
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

  // Container-mode instances: re-attach using docker start -ai
  if (params.instance.containerMode && params.instance.containerId) {
    const socketPath = params.config.container?.socketPath;
    if (containerExists(params.instance.containerId, socketPath)) {
      const dockerStartCmd = buildDockerStartCommand(params.instance.containerId, socketPath);
      runtime.startAgentInWindow(fullSessionName, windowName, dockerStartCmd);
      infoMessages.push(`Restored container runtime window: ${windowName} (container: ${params.instance.containerName || params.instance.containerId})`);
    } else {
      warningMessages.push(`Container ${params.instance.containerId} no longer exists. Re-create the instance.`);
    }
    return {
      windowName,
      restoredWindow: true,
      infoMessages,
      warningMessages,
    };
  }

  let claudePluginDir: string | undefined;
  let hookEnabled = !!params.instance.eventHook;
  const integration = installAgentIntegration(params.instance.agentType, params.project.projectPath, 'reinstall');
  claudePluginDir = integration.claudePluginDir;
  hookEnabled = hookEnabled || integration.eventHookInstalled;
  infoMessages.push(...integration.infoMessages);
  warningMessages.push(...integration.warningMessages);

  const permissionAllow =
    params.instance.agentType === 'opencode' && params.config.opencode?.permissionMode === 'allow';
  const baseCommand = withClaudePluginDir(
    adapter.getStartCommand(params.project.projectPath, permissionAllow),
    claudePluginDir,
  );

  const startCommand =
    buildExportPrefix(buildAgentLaunchEnv({
      projectName: params.projectName,
      port: params.port,
      agentType: params.instance.agentType,
      instanceId: params.instance.instanceId,
      permissionAllow: !!permissionAllow,
    })) + baseCommand;

  runtime.startAgentInWindow(fullSessionName, windowName, startCommand);
  infoMessages.push(`Restored missing runtime window: ${windowName}`);

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
