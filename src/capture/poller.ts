/**
 * Capture-based polling system
 * Periodically captures tmux pane content and sends updates to Discord
 */

import { TmuxManager } from '../tmux/manager.js';
import { DiscordClient } from '../discord/client.js';
import { stateManager as defaultStateManager, type ProjectState } from '../state/index.js';
import type { ProjectInstanceState } from '../types/index.js';
import type { IStateManager } from '../types/interfaces.js';
import { cleanCapture, splitForDiscord } from './parser.js';
import { detectState } from './detector.js';
import { listProjectInstances } from '../state/instances.js';

interface PollState {
  previousCapture: string | null;
  lastReportedCapture: string | null;
  stableCount: number;
  notifiedWorking: boolean;
}

interface PollerHooks {
  onAgentComplete?: (projectName: string, agentType: string, instanceId: string) => void | Promise<void>;
  onAgentStopped?: (projectName: string, agentType: string, instanceId: string) => void | Promise<void>;
}

function defaultPollState(): PollState {
  return {
    previousCapture: null,
    lastReportedCapture: null,
    stableCount: 0,
    notifiedWorking: false,
  };
}

export class CapturePoller {
  private states: Map<string, PollState> = new Map();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private tmux: TmuxManager,
    private discord: DiscordClient,
    private intervalMs: number = 30000,
    private stateManager: IStateManager = defaultStateManager,
    private hooks?: PollerHooks
  ) {}

  start(): void {
    if (this.timer) return;
    console.log(`📡 Capture poller started (${this.intervalMs / 1000}s interval)`);
    // Run first poll immediately, then on interval
    this.pollAll();
    this.timer = setInterval(() => this.pollAll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log('📡 Capture poller stopped');
    }
  }

  private async pollAll(): Promise<void> {
    const projects = this.stateManager.listProjects();

    for (const project of projects) {
      for (const instance of listProjectInstances(project)) {
        if (instance.eventHook) continue;
        try {
          await this.pollAgent(project, instance);
        } catch (error) {
          // Silently skip errors for individual agents
          console.error(`Poll error [${project.projectName}/${instance.agentType}/${instance.instanceId}]:`, error);
        }
      }
    }
  }

  private async pollAgent(project: ProjectState, instance: ProjectInstanceState): Promise<void> {
    const key = `${project.projectName}:${instance.instanceId}`;
    const state = this.states.get(key) || defaultPollState();
    this.states.set(key, state);

    const channelId = instance.discordChannelId;
    if (!channelId) return;

    // Try to capture pane
    let rawCapture: string;
    try {
      const windowName = instance.tmuxWindow || instance.instanceId;
      rawCapture = this.tmux.capturePaneFromWindow(project.tmuxSession, windowName, instance.agentType);
    } catch {
      // Session or window doesn't exist
      if (state.notifiedWorking) {
        await this.hooks?.onAgentStopped?.(project.projectName, instance.agentType, instance.instanceId);
        await this.send(channelId, '⏹️ 세션 종료됨');
        state.notifiedWorking = false;
      }
      return;
    }

    const capture = cleanCapture(rawCapture);
    const agentState = detectState(capture, state.previousCapture, state.stableCount);

    if (agentState === 'working') {
      // Content is changing - agent is active
      state.stableCount = 0;
      state.previousCapture = capture;

      if (!state.notifiedWorking) {
        state.notifiedWorking = true;
      }
      return;
    }

    // Content unchanged - agent may have stopped
    state.stableCount++;
    state.previousCapture = capture;

    if (state.stableCount === 1 && state.notifiedWorking) {
      // Just became stable after working - agent likely finished
      // Send the current screen content as the final output
      const content = capture.trim();

      await this.hooks?.onAgentComplete?.(project.projectName, instance.agentType, instance.instanceId);

      if (content && content !== state.lastReportedCapture) {
        const chunks = splitForDiscord(content);
        for (const chunk of chunks) {
          await this.send(channelId, chunk);
        }
      }

      state.lastReportedCapture = capture;
      state.notifiedWorking = false;
    }
  }

  private async send(channelId: string, message: string): Promise<void> {
    try {
      await this.discord.sendToChannel(channelId, message);
    } catch (error) {
      console.error(`Failed to send to ${channelId}:`, error);
    }
  }
}
