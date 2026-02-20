/**
 * Platform-agnostic messaging client interface.
 *
 * Both DiscordClient and SlackClient implement this interface so that
 * the rest of the codebase can work with any messaging platform.
 */

import type { AgentConfig } from '../agents/index.js';
import type { MessageAttachment } from '../types/index.js';

export type MessageCallback = (
  agentType: string,
  content: string,
  projectName: string,
  channelId: string,
  messageId?: string,
  instanceId?: string,
  attachments?: MessageAttachment[]
) => void | Promise<void>;

export interface ChannelInfo {
  projectName: string;
  agentType: string;
  instanceId?: string;
}

export interface MessagingClient {
  readonly platform: 'discord' | 'slack';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  onMessage(callback: MessageCallback): void;

  sendToChannel(channelId: string, content: string): Promise<void>;
  sendToChannelWithId?(channelId: string, content: string): Promise<string | undefined>;
  sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void>;
  replyInThread?(channelId: string, parentMessageId: string, content: string): Promise<void>;

  addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void>;
  replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void>;

  createAgentChannels(
    guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }>;

  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void;
  getChannelMapping(): Map<string, ChannelInfo>;
  getGuilds(): { id: string; name: string }[];

  deleteChannel(channelId: string): Promise<boolean>;

  sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs?: number,
  ): Promise<boolean>;

  sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs?: number,
  ): Promise<string | null>;
}
