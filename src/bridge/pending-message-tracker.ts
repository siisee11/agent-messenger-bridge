import type { MessagingClient } from '../messaging/interface.js';

export class PendingMessageTracker {
  private pendingMessageByInstance: Map<string, { channelId: string; messageId: string }> = new Map();

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
    this.pendingMessageByInstance.set(key, { channelId, messageId });
    await this.messaging.addReactionToMessage(channelId, messageId, '⏳');
  }

  async markCompleted(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    await this.messaging.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '✅');
    this.pendingMessageByInstance.delete(key);
  }

  async markError(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    await this.messaging.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '❌');
    this.pendingMessageByInstance.delete(key);
  }

  hasPending(projectName: string, agentType: string, instanceId?: string): boolean {
    const key = this.pendingKey(projectName, instanceId || agentType);
    return this.pendingMessageByInstance.has(key);
  }
}
