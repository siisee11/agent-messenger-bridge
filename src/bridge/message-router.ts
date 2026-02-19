import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import {
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { downloadFileAttachments, buildFileMarkers } from '../infra/file-downloader.js';
import { cleanCapture } from '../capture/parser.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import { injectFile, WORKSPACE_DIR } from '../container/index.js';

export interface BridgeMessageRouterDeps {
  messaging: MessagingClient;
  runtime: AgentRuntime;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  sanitizeInput: (content: string) => string | null;
}

export class BridgeMessageRouter {
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private deps: BridgeMessageRouterDeps) {}

  register(): void {
    const { messaging } = this.deps;

    messaging.onMessage(async (agentType, content, projectName, channelId, messageId, mappedInstanceId, attachments) => {
      console.log(
        `📨 [${projectName}/${agentType}${mappedInstanceId ? `#${mappedInstanceId}` : ''}] ${content.substring(0, 50)}...`,
      );

      const project = this.deps.stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await messaging.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      const normalizedProject = normalizeProjectState(project);
      const mappedInstance =
        (mappedInstanceId ? getProjectInstance(normalizedProject, mappedInstanceId) : undefined) ||
        findProjectInstanceByChannel(normalizedProject, channelId) ||
        getPrimaryInstanceForAgent(normalizedProject, agentType);
      if (!mappedInstance) {
        await messaging.sendToChannel(channelId, '⚠️ Agent instance mapping not found for this channel');
        return;
      }

      const resolvedAgentType = mappedInstance.agentType;
      const instanceKey = mappedInstance.instanceId;
      const windowName = mappedInstance.tmuxWindow || instanceKey;

      let enrichedContent = content;
      if (attachments && attachments.length > 0) {
        try {
          const downloaded = await downloadFileAttachments(attachments, project.projectPath, attachments[0]?.authHeaders);
          if (downloaded.length > 0) {
            // If the instance runs in a container, inject files into it
            if (mappedInstance.containerMode && mappedInstance.containerId) {
              const containerFilesDir = `${WORKSPACE_DIR}/.discode/files`;
              for (const file of downloaded) {
                injectFile(mappedInstance.containerId, file.localPath, containerFilesDir);
              }
            }
            const markers = buildFileMarkers(downloaded);
            enrichedContent = content + markers;
            console.log(`📎 [${projectName}/${agentType}] ${downloaded.length} file(s) attached`);
          }
        } catch (error) {
          console.warn('Failed to process file attachments:', error);
        }
      }

      const sanitized = this.deps.sanitizeInput(enrichedContent);
      if (!sanitized) {
        await messaging.sendToChannel(channelId, '⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters');
        return;
      }

      if (messageId) {
        await this.deps.pendingTracker.markPending(projectName, resolvedAgentType, channelId, messageId, instanceKey);
      }

        try {
          await this.submitToAgent(normalizedProject.tmuxSession, windowName, sanitized, resolvedAgentType);
          this.scheduleBufferFallback(
            normalizedProject.tmuxSession,
            windowName,
            projectName,
            resolvedAgentType,
            instanceKey,
            channelId,
          );
        } catch (error) {
        await this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey);
        await messaging.sendToChannel(channelId, this.buildDeliveryFailureGuidance(projectName, error));
      }

      this.deps.stateManager.updateLastActive(projectName);
    });
  }

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.trunc(n);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Type text and press Enter with a short delay in between.
   * The delay allows TUI agents to recognise slash-command prefixes
   * (e.g. `/model`) before Enter is sent.
   */
  private async submitToAgent(
    tmuxSession: string,
    windowName: string,
    prompt: string,
    agentType: string,
  ): Promise<void> {
    this.deps.runtime.typeKeysToWindow(tmuxSession, windowName, prompt.trimEnd(), agentType);
    const envKey =
      agentType === 'opencode'
        ? 'AGENT_DISCORD_OPENCODE_SUBMIT_DELAY_MS'
        : 'DISCODE_SUBMIT_DELAY_MS';
    const defaultMs = agentType === 'opencode' ? 75 : 300;
    const delayMs = this.getEnvInt(envKey, defaultMs);
    await this.sleep(delayMs);
    this.deps.runtime.sendEnterToWindow(tmuxSession, windowName, agentType);
  }

  /**
   * Schedule a fallback mechanism that captures the terminal buffer and sends it
   * to Slack when the Stop hook doesn't fire (e.g., interactive prompts like /model).
   *
   * The mechanism takes two snapshots separated by a delay. If the buffer is stable
   * (same content in both snapshots) and the pending message hasn't been resolved,
   * the terminal content is sent to Slack as a code block.
   */
  private scheduleBufferFallback(
    sessionName: string,
    windowName: string,
    projectName: string,
    agentType: string,
    instanceKey: string,
    channelId: string,
  ): void {
    const key = `${projectName}:${instanceKey}`;

    // Cancel any existing fallback timer for this instance
    const existing = this.fallbackTimers.get(key);
    if (existing) clearTimeout(existing);

    const initialDelayMs = this.getEnvInt('DISCODE_BUFFER_FALLBACK_INITIAL_MS', 3000);
    const stableCheckMs = this.getEnvInt('DISCODE_BUFFER_FALLBACK_STABLE_MS', 2000);
    const maxChecks = 3;

    let lastSnapshot = '';
    let checkCount = 0;

    const tag = `🖥️  [${key}]`;

    const check = async () => {
      this.fallbackTimers.delete(key);

      // If the Stop hook already resolved this pending message, nothing to do
      if (!this.deps.pendingTracker.hasPending(projectName, agentType, instanceKey)) {
        console.log(`${tag} fallback check #${checkCount}: pending already resolved, skipping`);
        return;
      }

      const snapshot = this.captureWindowText(sessionName, windowName);
      if (!snapshot) {
        console.log(`${tag} fallback check #${checkCount}: empty buffer, skipping`);
        return;
      }

      if (snapshot === lastSnapshot) {
        // Buffer is stable — likely an interactive prompt waiting for user input
        if (snapshot.trim().length > 0) {
          const relevant = this.extractLastCommandBlock(snapshot);
          console.log(`${tag} fallback: buffer stable (${snapshot.length} chars → ${relevant.length} chars), sending to channel`);
          try {
            await this.deps.messaging.sendToChannel(channelId, `\`\`\`\n${relevant}\n\`\`\``);
            await this.deps.pendingTracker.markCompleted(projectName, agentType, instanceKey);
          } catch (error) {
            console.warn(`${tag} fallback send failed:`, error);
          }
        }
        return;
      }

      // Buffer changed — agent is still processing, schedule another check
      console.log(`${tag} fallback check #${checkCount}: buffer changed (${snapshot.length} chars), retrying`);
      lastSnapshot = snapshot;
      checkCount++;

      if (checkCount < maxChecks) {
        const timer = setTimeout(() => { check().catch(() => {}); }, stableCheckMs);
        this.fallbackTimers.set(key, timer);
      } else {
        console.log(`${tag} fallback: max checks reached, deferring to Stop hook`);
      }
    };

    const timer = setTimeout(() => { check().catch(() => {}); }, initialDelayMs);
    this.fallbackTimers.set(key, timer);
  }

  /**
   * Capture the current terminal screen content as plain text.
   * Uses getWindowFrame (pty runtime) or getWindowBuffer (tmux runtime).
   */
  private captureWindowText(sessionName: string, windowName: string): string | null {
    const runtime = this.deps.runtime;

    // Prefer getWindowFrame for pty runtime — it gives a properly rendered screen
    if (runtime.getWindowFrame) {
      try {
        const frame = runtime.getWindowFrame(sessionName, windowName);
        if (frame) {
          const lines = frame.lines.map((line) =>
            line.segments.map((s) => s.text).join(''),
          );
          while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
          }
          return lines.join('\n');
        }
        // frame is null — fall through to getWindowBuffer
      } catch {
        // fall through to getWindowBuffer
      }
    }

    // For tmux runtime: capture-pane returns clean text
    if (runtime.getWindowBuffer) {
      try {
        const buffer = runtime.getWindowBuffer(sessionName, windowName);
        if (!buffer) return null;
        return cleanCapture(buffer);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Extract the last command block from terminal output.
   * Looks for the last `❯` prompt and returns everything from that line onward,
   * so only the relevant command + its output is sent to the channel.
   */
  private extractLastCommandBlock(text: string): string {
    const lines = text.split('\n');

    // Find the last line that starts with the Claude Code prompt marker (❯ at column 0).
    // Menu selection markers like " ❯ 4. opus" have leading spaces, so we skip those.
    let lastPromptIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^❯\s/.test(lines[i])) {
        lastPromptIdx = i;
        break;
      }
    }

    if (lastPromptIdx < 0) return text;

    // Take everything from the last prompt to the end, trimming trailing blank lines
    const block = lines.slice(lastPromptIdx);
    while (block.length > 0 && block[block.length - 1].trim() === '') {
      block.pop();
    }

    return block.join('\n');
  }

  private buildDeliveryFailureGuidance(projectName: string, error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const missingTarget = /can't find (window|pane)/i.test(rawMessage);

    if (missingTarget) {
      return (
        `⚠️ I couldn't deliver your message because the agent tmux window is not running.\n` +
        `Please restart the agent session, then send your message again:\n` +
        `1) \`discode new --name ${projectName}\`\n` +
        `2) \`discode attach ${projectName}\``
      );
    }

    return (
      `⚠️ I couldn't deliver your message to the tmux agent session.\n` +
      `Please confirm the agent is running, then try again.\n` +
      `If needed, restart with \`discode new --name ${projectName}\`.`
    );
  }
}
