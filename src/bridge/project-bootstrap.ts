import { DiscordClient } from '../discord/client.js';
import { installOpencodePlugin } from '../opencode/plugin-installer.js';
import { installClaudePlugin } from '../claude/plugin-installer.js';
import { installGeminiHook } from '../gemini/hook-installer.js';
import { installCodexHook } from '../codex/plugin-installer.js';
import { installFileInstruction } from '../infra/file-instruction.js';
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
      if (!instance.discordChannelId) continue;
      mappings.push({
        channelId: instance.discordChannelId,
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
    private discord: DiscordClient,
  ) {}

  bootstrapProjects(): ReturnType<IStateManager['listProjects']> {
    const projects = this.stateManager.listProjects().map((rawProject) => {
      const project = normalizeProjectState(rawProject);
      const agentTypes = new Set(listProjectAgentTypes(project));
      if (!agentTypes.has('opencode') && !agentTypes.has('claude') && !agentTypes.has('gemini') && !agentTypes.has('codex')) {
        return project;
      }

      let opencodeInstalled = false;
      let claudeInstalled = false;
      let geminiHookInstalled = false;
      let codexHookInstalled = false;

      if (agentTypes.has('opencode')) {
        try {
          const pluginPath = installOpencodePlugin(project.projectPath);
          console.log(`🧩 Installed OpenCode plugin: ${pluginPath}`);
          opencodeInstalled = true;
        } catch (error) {
          console.warn(`Failed to install OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (agentTypes.has('claude')) {
        try {
          const pluginPath = installClaudePlugin(project.projectPath);
          console.log(`🪝 Installed Claude Code plugin: ${pluginPath}`);
          claudeInstalled = true;
        } catch (error) {
          console.warn(`Failed to install Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (agentTypes.has('gemini')) {
        try {
          const hookPath = installGeminiHook(project.projectPath);
          console.log(`🪝 Installed Gemini CLI hook: ${hookPath}`);
          geminiHookInstalled = true;
        } catch (error) {
          console.warn(`Failed to install Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (agentTypes.has('codex')) {
        try {
          const hookPath = installCodexHook();
          console.log(`🪝 Installed Codex notify hook: ${hookPath}`);
          codexHookInstalled = true;
        } catch (error) {
          console.warn(`Failed to install Codex notify hook: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      for (const at of agentTypes) {
        try {
          installFileInstruction(project.projectPath, at);
        } catch {
          // Non-critical.
        }
      }

      const nextInstances: NonNullable<typeof project.instances> = { ...(project.instances || {}) };
      let changed = false;

      for (const instance of listProjectInstances(project)) {
        const shouldEnableHook =
          (instance.agentType === 'opencode' && opencodeInstalled) ||
          (instance.agentType === 'claude' && claudeInstalled) ||
          (instance.agentType === 'gemini' && geminiHookInstalled) ||
          (instance.agentType === 'codex' && codexHookInstalled);

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
    if (mappings.length > 0) {
      this.discord.registerChannelMappings(mappings);
    }
    return mappings;
  }
}
