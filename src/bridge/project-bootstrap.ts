import type { MessagingClient } from '../messaging/interface.js';
import { installFileInstruction } from '../infra/file-instruction.js';
import { installDiscodeSendScript } from '../infra/send-script.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import type { IStateManager } from '../types/interfaces.js';
import {
  listProjectAgentTypes,
  listProjectInstances,
  normalizeProjectState,
} from '../state/instances.js';

export type ChannelMapping = {
  channelId: string;
  projectName: string;
  agentType: string;
  instanceId?: string;
};

function buildMappings(projects: ReturnType<IStateManager['listProjects']>): ChannelMapping[] {
  const mappings: ChannelMapping[] = [];
  for (const rawProject of projects) {
    const project = normalizeProjectState(rawProject);
    for (const instance of listProjectInstances(project)) {
      if (!instance.channelId) continue;
      mappings.push({
        channelId: instance.channelId,
        projectName: project.projectName,
        agentType: instance.agentType,
        instanceId: instance.instanceId,
      });
    }
  }
  return mappings;
}

export class BridgeProjectBootstrap {
  constructor(
    private stateManager: IStateManager,
    private messaging: MessagingClient,
    private hookServerPort: number = 18470,
  ) {}

  bootstrapProjects(): ReturnType<IStateManager['listProjects']> {
    const projects = this.stateManager.listProjects().map((rawProject) => {
      const project = normalizeProjectState(rawProject);
      const agentTypes = new Set(listProjectAgentTypes(project));
      if (!agentTypes.has('opencode') && !agentTypes.has('claude') && !agentTypes.has('gemini') && !agentTypes.has('codex')) {
        return project;
      }

      const integrationByAgent = new Map<string, ReturnType<typeof installAgentIntegration>>();
      for (const agentType of agentTypes) {
        const integration = installAgentIntegration(agentType, project.projectPath, 'install');
        integrationByAgent.set(agentType, integration);
        for (const message of integration.infoMessages) {
          console.log(message);
        }
        for (const message of integration.warningMessages) {
          console.warn(message);
        }
      }

      for (const at of agentTypes) {
        try {
          installFileInstruction(project.projectPath, at);
        } catch {
          // Non-critical.
        }
      }

      try {
        installDiscodeSendScript(project.projectPath, {
          projectName: project.projectName,
          port: this.hookServerPort,
        });
      } catch {
        // Non-critical.
      }

      const nextInstances: NonNullable<typeof project.instances> = { ...(project.instances || {}) };
      let changed = false;

      for (const instance of listProjectInstances(project)) {
        const shouldEnableHook = !!integrationByAgent.get(instance.agentType)?.eventHookInstalled;

        if (shouldEnableHook && !instance.eventHook) {
          nextInstances[instance.instanceId] = {
            ...instance,
            eventHook: true,
          };
          changed = true;
        }
      }

      if (!changed) return project;

      const next = normalizeProjectState({
        ...project,
        instances: nextInstances,
      });
      this.stateManager.setProject(next);
      return next;
    });

    this.registerMappings(projects);
    return projects;
  }

  reloadChannelMappings(): void {
    this.stateManager.reload();
    const projects = this.stateManager.listProjects().map((project) => normalizeProjectState(project));
    const mappings = this.registerMappings(projects);
    console.log(`🔄 Reloaded channel mappings (${mappings.length} channels)`);
  }

  private registerMappings(projects: ReturnType<IStateManager['listProjects']>): ChannelMapping[] {
    const mappings = buildMappings(projects);
    console.log(`[bootstrap-debug] Channel mappings: ${JSON.stringify(mappings.map(m => ({ ch: m.channelId, project: m.projectName, agent: m.agentType })))}`);
    if (mappings.length > 0) {
      this.messaging.registerChannelMappings(mappings);
    }
    return mappings;
  }
}
