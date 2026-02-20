import type { MessagingClient } from '../messaging/interface.js';

export interface PendingEntry {
  channelId: string;
  messageId: string;
  startMessageId?: string;
}

export class PendingMessageTracker {
  private pendingMessageByInstance: Map<string, PendingEntry> = new Map();
  // Recently completed entries — kept briefly so the Stop hook can still
  // retrieve startMessageId for thread replies after the buffer fallback
  // has already called markCompleted.
  private recentlyCompleted: Map<string, { entry: PendingEntry; timer: ReturnType<typeof setTimeout> }> = new Map();
  private static RECENTLY_COMPLETED_TTL_MS = 30_000;

  constructor(private messaging: MessagingClient) {}

  private pendingKey(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
  }

  async markPending(
    projectName: string,
    agentType: string,
    channelId: string,
    messageId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);

    // Clear any stale recently-completed entry for this key
    const recent = this.recentlyCompleted.get(key);
    if (recent) {
      clearTimeout(recent.timer);
      this.recentlyCompleted.delete(key);
    }

    // Add reaction to user's message
    await this.messaging.addReactionToMessage(channelId, messageId, '⏳');

    // Send a start message and store its ID for thread replies
    let startMessageId: string | undefined;
    if (this.messaging.sendToChannelWithId) {
      try {
        startMessageId = await this.messaging.sendToChannelWithId(channelId, '⏳ Processing...');
      } catch {
        // Non-fatal: thread replies will be skipped if start message fails
      }
    }

    this.pendingMessageByInstance.set(key, { channelId, messageId, startMessageId });
  }

  /**
   * Ensure a pending entry exists for this instance.
   * Used for tmux-initiated prompts that bypass the normal Slack message flow.
   * Sends "⏳ Processing..." but does not add a reaction (no user message to react to).
   */
  async ensurePending(
    projectName: string,
    agentType: string,
    channelId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);

    // Already actively pending — don't duplicate
    if (this.pendingMessageByInstance.has(key)) return;

    // Clear any stale recently-completed entry for this key
    const recent = this.recentlyCompleted.get(key);
    if (recent) {
      clearTimeout(recent.timer);
      this.recentlyCompleted.delete(key);
    }

    let startMessageId: string | undefined;
    if (this.messaging.sendToChannelWithId) {
      try {
        startMessageId = await this.messaging.sendToChannelWithId(channelId, '⏳ Processing...');
      } catch {
        // Non-fatal: thread replies will be skipped if start message fails
      }
    }

    this.pendingMessageByInstance.set(key, { channelId, messageId: '', startMessageId });
  }

  async markCompleted(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    if (pending.messageId) {
      await this.messaging.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '✅');
    }
    this.pendingMessageByInstance.delete(key);

    // Keep the entry in recently-completed so the Stop hook can still use
    // startMessageId for thread replies if it arrives after the buffer fallback.
    const existing = this.recentlyCompleted.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.recentlyCompleted.delete(key), PendingMessageTracker.RECENTLY_COMPLETED_TTL_MS);
    this.recentlyCompleted.set(key, { entry: pending, timer });
  }

  async markError(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    if (pending.messageId) {
      await this.messaging.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '❌');
    }
    this.pendingMessageByInstance.delete(key);
  }

  hasPending(projectName: string, agentType: string, instanceId?: string): boolean {
    const key = this.pendingKey(projectName, instanceId || agentType);
    return this.pendingMessageByInstance.has(key);
  }

  getPending(projectName: string, agentType: string, instanceId?: string): PendingEntry | undefined {
    const key = this.pendingKey(projectName, instanceId || agentType);
    return this.pendingMessageByInstance.get(key) || this.recentlyCompleted.get(key)?.entry;
  }
}
