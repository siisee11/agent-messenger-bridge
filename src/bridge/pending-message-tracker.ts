import { DiscordClient } from '../discord/client.js';

export class PendingMessageTracker {
  private pendingMessageByInstance: Map<string, { channelId: string; messageId: string }> = new Map();

  constructor(private discord: DiscordClient) {}

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
    await this.discord.addReactionToMessage(channelId, messageId, '⏳');
  }

  async markCompleted(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    await this.discord.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '✅');
    this.pendingMessageByInstance.delete(key);
  }

  async markError(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    await this.discord.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '❌');
    this.pendingMessageByInstance.delete(key);
  }
}
