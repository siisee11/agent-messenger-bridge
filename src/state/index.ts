/**
 * Project state management
 * Tracks active projects, their Discord channels, and tmux sessions
 */

import { join } from 'path';
import { homedir } from 'os';
import type { IStorage, IStateManager } from '../types/interfaces.js';
import type { ProjectState as SharedProjectState } from '../types/index.js';
import { FileStorage } from '../infra/storage.js';
import { findProjectInstanceByChannel, normalizeProjectState } from './instances.js';

export type ProjectState = SharedProjectState;

export interface BridgeState {
  projects: Record<string, ProjectState>;
  guildId?: string;
}


export class StateManager implements IStateManager {
  private state: BridgeState;
  private storage: IStorage;
  private stateDir: string;
  private stateFile: string;

  constructor(storage?: IStorage, stateDir?: string, stateFile?: string) {
    this.storage = storage || new FileStorage();
    this.stateDir = stateDir || join(homedir(), '.discode');
    this.stateFile = stateFile || join(this.stateDir, 'state.json');
    this.state = this.loadState();
  }

  private loadState(): BridgeState {
    if (!this.storage.exists(this.stateFile)) {
      return { projects: {} };
    }
    try {
      const data = this.storage.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(data) as BridgeState;
      const projects: Record<string, ProjectState> = {};
      for (const [projectName, project] of Object.entries(parsed.projects || {})) {
        if (!project || typeof project !== 'object') continue;
        projects[projectName] = normalizeProjectState(project as ProjectState);
      }
      return {
        ...parsed,
        projects,
      };
    } catch {
      return { projects: {} };
    }
  }

  private saveState(): void {
    if (!this.storage.exists(this.stateDir)) {
      this.storage.mkdirp(this.stateDir);
    }
    this.storage.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  reload(): void {
    this.state = this.loadState();
  }

  getProject(projectName: string): ProjectState | undefined {
    return this.state.projects[projectName];
  }

  setProject(project: ProjectState): void {
    this.state.projects[project.projectName] = normalizeProjectState(project);
    this.saveState();
  }

  removeProject(projectName: string): void {
    delete this.state.projects[projectName];
    this.saveState();
  }

  listProjects(): ProjectState[] {
    return Object.values(this.state.projects);
  }

  getGuildId(): string | undefined {
    return this.state.guildId;
  }

  setGuildId(guildId: string): void {
    this.state.guildId = guildId;
    this.saveState();
  }

  updateLastActive(projectName: string): void {
    if (this.state.projects[projectName]) {
      this.state.projects[projectName].lastActive = new Date();
      this.saveState();
    }
  }

  findProjectByChannel(channelId: string): ProjectState | undefined {
    return Object.values(this.state.projects).find((project) => !!findProjectInstanceByChannel(project, channelId));
  }

  getAgentTypeByChannel(channelId: string): string | undefined {
    for (const project of Object.values(this.state.projects)) {
      const instance = findProjectInstanceByChannel(project, channelId);
      if (instance) return instance.agentType;
    }
    return undefined;
  }
}

export const stateManager = new StateManager();
