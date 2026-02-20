/**
 * Slack client implementation using @slack/bolt Socket Mode.
 *
 * Implements MessagingClient so it can be used interchangeably with DiscordClient.
 */

import { App, type LogLevel } from '@slack/bolt';
import type { AgentConfig } from '../agents/index.js';
import type { MessageAttachment } from '../types/index.js';
import type { MessagingClient, MessageCallback, ChannelInfo } from '../messaging/interface.js';

export class SlackClient implements MessagingClient {
  readonly platform = 'slack' as const;
  private app: App;
  private botToken: string;
  private messageCallback?: MessageCallback;
  private channelMapping: Map<string, ChannelInfo> = new Map();
  private botUserId?: string;

  constructor(botToken: string, appToken: string) {
    this.botToken = botToken;
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: 'ERROR' as LogLevel,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Listen for messages in channels
    this.app.message(async ({ message }) => {
      // Only handle regular user messages (not bot messages, not system events)
      if (!('user' in message)) return;
      const subtype = 'subtype' in message ? message.subtype : undefined;
      if (subtype && subtype !== 'file_share') return;
      // Skip bot messages
      if ('bot_id' in message && message.bot_id) return;

      const channelId = message.channel;
      const channelInfo = this.channelMapping.get(channelId);
      if (channelInfo && this.messageCallback) {
        try {
          // Extract file attachments if present
          let attachments: MessageAttachment[] | undefined;
          if ('files' in message && Array.isArray(message.files) && message.files.length > 0) {
            attachments = message.files.map((f: any) => ({
              url: f.url_private_download || f.url_private || '',
              filename: f.name || 'unknown',
              contentType: f.mimetype || null,
              size: f.size || 0,
              authHeaders: { Authorization: `Bearer ${this.botToken}` },
            }));
          }

          await this.messageCallback(
            channelInfo.agentType,
            message.text || '',
            channelInfo.projectName,
            channelId,
            message.ts,
            channelInfo.instanceId,
            attachments && attachments.length > 0 ? attachments : undefined,
          );
        } catch (error) {
          console.error(
            `Slack message handler error [${channelInfo.projectName}/${channelInfo.agentType}] channel=${channelId}:`,
            error,
          );
        }
      }
    });

    // Listen for button interactions (approval requests & question buttons)
    this.app.action(/^opt_\d+$/, async ({ ack }) => {
      await ack();
      // Actual handling is done via awaiters set up by sendQuestionWithButtons / sendApprovalRequest
    });
    this.app.action('approve_action', async ({ ack }) => {
      await ack();
    });
    this.app.action('deny_action', async ({ ack }) => {
      await ack();
    });
  }

  async connect(): Promise<void> {
    await this.app.start();
    // Resolve bot user ID
    const auth = await this.app.client.auth.test({ token: this.botToken });
    this.botUserId = auth.user_id as string;
    console.log(`Slack bot connected as ${auth.user} (${this.botUserId})`);
    await this.scanExistingChannels();
  }

  async disconnect(): Promise<void> {
    await this.app.stop();
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  async sendToChannel(channelId: string, content: string): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        text: content,
      });
    } catch (error) {
      console.error(`Failed to send message to Slack channel ${channelId}:`, error);
    }
  }

  async sendToChannelWithId(channelId: string, content: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        text: content,
      });
      return result.ts;
    } catch (error) {
      console.error(`Failed to send message to Slack channel ${channelId}:`, error);
      return undefined;
    }
  }

  async replyInThread(channelId: string, parentMessageId: string, content: string): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        thread_ts: parentMessageId,
        text: content,
      });
    } catch (error) {
      console.error(`Failed to reply in thread on Slack channel ${channelId}:`, error);
    }
  }

  async sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void> {
    try {
      const { createReadStream } = await import('fs');
      const { basename } = await import('path');

      for (const filePath of filePaths) {
        await this.app.client.filesUploadV2({
          token: this.botToken,
          channel_id: channelId,
          file: createReadStream(filePath),
          filename: basename(filePath),
          initial_comment: content || undefined,
        });
        // Only add initial_comment on the first file
        content = '';
      }
    } catch (error) {
      console.error(`Failed to send files to Slack channel ${channelId}:`, error);
    }
  }

  async addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const slackEmoji = this.emojiToSlackName(emoji);
      await this.app.client.reactions.add({
        token: this.botToken,
        channel: channelId,
        timestamp: messageId,
        name: slackEmoji,
      });
    } catch (error) {
      console.warn(`Failed to add reaction ${emoji} on ${channelId}/${messageId}:`, error);
    }
  }

  async replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    try {
      const fromSlack = this.emojiToSlackName(fromEmoji);
      await this.app.client.reactions.remove({
        token: this.botToken,
        channel: channelId,
        timestamp: messageId,
        name: fromSlack,
      }).catch(() => undefined);

      const toSlack = this.emojiToSlackName(toEmoji);
      await this.app.client.reactions.add({
        token: this.botToken,
        channel: channelId,
        timestamp: messageId,
        name: toSlack,
      });
    } catch (error) {
      console.warn(`Failed to replace reaction on ${channelId}/${messageId}:`, error);
    }
  }

  async createAgentChannels(
    _guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }> {
    const result: { [agentName: string]: string } = {};

    // Fetch all existing channels (with pagination) to check for reuse
    const channelsByName = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = await this.app.client.conversations.list({
        token: this.botToken,
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const ch of page.channels || []) {
        if (ch.name && ch.id) {
          channelsByName.set(ch.name, ch.id);
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    for (const config of agentConfigs) {
      const channelName = customChannelName || `${projectName}-${config.channelSuffix}`;
      // Slack normalizes channel names: lowercase, hyphens, max 80 chars
      const normalized = channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').slice(0, 80);

      let channelId = channelsByName.get(normalized);
      if (channelId) {
        // Ensure bot is in the channel (may have been removed)
        await this.app.client.conversations.join({
          token: this.botToken,
          channel: channelId,
        }).catch(() => undefined);
        console.log(`  - ${config.displayName}: reusing existing Slack channel #${normalized} (${channelId})`);
      } else {
        try {
          const created = await this.app.client.conversations.create({
            token: this.botToken,
            name: normalized,
          });
          channelId = created.channel?.id;
          if (channelId) {
            await this.app.client.conversations.setTopic({
              token: this.botToken,
              channel: channelId,
              topic: `${config.displayName} agent for ${projectName}`,
            }).catch(() => undefined);
            console.log(`  - ${config.displayName}: created Slack channel #${normalized} (${channelId})`);
          }
        } catch (error: any) {
          if (error?.data?.error === 'name_taken') {
            // Channel exists but wasn't in our list (e.g. archived or permission issue).
            // Try to find it by searching all channels including archived.
            channelId = await this.findChannelByName(normalized);
            if (channelId) {
              await this.app.client.conversations.join({
                token: this.botToken,
                channel: channelId,
              }).catch(() => undefined);
              console.log(`  - ${config.displayName}: found and reusing Slack channel #${normalized} (${channelId})`);
            } else {
              console.warn(`  - ${config.displayName}: channel #${normalized} name is taken but could not locate it`);
              continue;
            }
          } else {
            throw error;
          }
        }
      }

      if (channelId) {
        this.channelMapping.set(channelId, {
          projectName,
          agentType: config.name,
          instanceId: instanceIdByAgent?.[config.name],
        });
        result[config.name] = channelId;
      }
    }

    console.log(`Set up ${Object.keys(result).length} Slack channels for project ${projectName}`);
    return result;
  }

  private async findChannelByName(channelName: string): Promise<string | undefined> {
    try {
      let cur: string | undefined;
      do {
        const page = await this.app.client.conversations.list({
          token: this.botToken,
          types: 'public_channel,private_channel',
          exclude_archived: false,
          limit: 200,
          ...(cur ? { cursor: cur } : {}),
        });
        for (const ch of page.channels || []) {
          if (ch.name === channelName && ch.id) {
            return ch.id;
          }
        }
        cur = page.response_metadata?.next_cursor || undefined;
      } while (cur);
    } catch {
      // Ignore search errors
    }
    return undefined;
  }

  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void {
    for (const m of mappings) {
      this.channelMapping.set(m.channelId, {
        projectName: m.projectName,
        agentType: m.agentType,
        instanceId: m.instanceId,
      });
      console.log(
        `Registered Slack channel ${m.channelId} -> ${m.projectName}:${m.agentType}${m.instanceId ? `#${m.instanceId}` : ''}`,
      );
    }
  }

  getChannelMapping(): Map<string, ChannelInfo> {
    return new Map(this.channelMapping);
  }

  getGuilds(): { id: string; name: string }[] {
    // Slack equivalent: return the workspace as a single "guild"
    // This is populated after connect()
    return this._workspaces;
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    // Slack bot tokens cannot unarchive channels they've been removed from,
    // so we avoid archiving entirely. Just remove from mapping and leave
    // the channel intact for reuse on next `discode new`.
    this.channelMapping.delete(channelId);
    return true;
  }

  async sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs: number = 120000,
  ): Promise<boolean> {
    let inputPreview = '';
    if (toolInput) {
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
      inputPreview = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;
    }

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: `Permission Request: Tool \`${toolName}\``,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:lock: *Permission Request*\nTool: \`${toolName}\`\n\`\`\`${inputPreview}\`\`\`\n_${Math.round(timeoutMs / 1000)}s timeout, auto-deny on timeout_`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Allow' },
              style: 'primary',
              action_id: 'approve_action',
              value: 'approve',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'deny_action',
              value: 'deny',
            },
          ],
        },
      ],
    });

    const messageTs = result.ts;
    if (!messageTs) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        // Update message to show timeout
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: `Permission Request: Tool \`${toolName}\` - Timed out`,
          blocks: [],
        }).catch(() => undefined);
        resolve(false);
      }, timeoutMs);

      const handler = async ({ action, ack, respond }: any) => {
        await ack();
        const approved = action.value === 'approve';
        cleanup();
        await respond({
          text: approved ? ':white_check_mark: *Allowed*' : ':x: *Denied*',
          replace_original: false,
        }).catch(() => undefined);
        resolve(approved);
      };

      const cleanup = () => {
        clearTimeout(timer);
        // Remove temporary action listeners - bolt doesn't have removeListener,
        // so the ack() handlers registered in setupEventHandlers handle this.
      };

      // Register one-time action handlers
      this.app.action('approve_action', handler);
      this.app.action('deny_action', handler);
    });
  }

  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs: number = 300000,
  ): Promise<string | null> {
    const q = questions[0];
    if (!q) return null;

    const buttons = q.options.map((opt, i) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: opt.label.slice(0, 75) },
      action_id: `opt_${i}`,
      value: opt.label,
      ...(i === 0 ? { style: 'primary' as const } : {}),
    }));

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:question: *${q.header || 'Question'}*\n${q.question}`,
        },
      },
    ];

    // Add option descriptions if any
    if (q.options.some((o) => o.description)) {
      blocks.push({
        type: 'section',
        fields: q.options.map((opt) => ({
          type: 'mrkdwn',
          text: `*${opt.label}*\n${opt.description || ' '}`,
        })),
      });
    }

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: q.question,
      blocks,
    });

    const messageTs = result.ts;
    if (!messageTs) return null;

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: `${q.question} - Timed out`,
          blocks: [],
        }).catch(() => undefined);
        resolve(null);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
      };

      // Register temporary action handlers for each option
      for (let i = 0; i < q.options.length; i++) {
        this.app.action(`opt_${i}`, async ({ action, ack }: any) => {
          await ack();
          cleanup();
          const selected = action.value || q.options[i].label;
          this.app.client.chat.update({
            token: this.botToken,
            channel: channelId,
            ts: messageTs,
            text: `${q.question} - Selected: ${selected}`,
            blocks: [],
          }).catch(() => undefined);
          resolve(selected);
        });
      }
    });
  }

  // --- Internal helpers ---

  private _workspaces: { id: string; name: string }[] = [];

  private async scanExistingChannels(): Promise<void> {
    try {
      const auth = await this.app.client.auth.test({ token: this.botToken });
      if (auth.team_id && auth.team) {
        this._workspaces = [{ id: auth.team_id, name: auth.team as string }];
      }

      // Scan channels the bot is a member of
      const result = await this.app.client.conversations.list({
        token: this.botToken,
        types: 'public_channel,private_channel',
        limit: 1000,
      });

      for (const ch of result.channels || []) {
        if (ch.name && ch.id && ch.is_member) {
          // Try to match channel name to project/agent pattern
          // This is best-effort; channel mappings from state are the primary source
          console.log(`Slack channel found: #${ch.name} (${ch.id})`);
        }
      }
    } catch (error) {
      console.warn('Failed to scan existing Slack channels:', error);
    }
  }

  /** Map Unicode emoji to Slack emoji name (without colons). */
  private emojiToSlackName(emoji: string): string {
    const map: Record<string, string> = {
      '⏳': 'hourglass_flowing_sand',
      '✅': 'white_check_mark',
      '❌': 'x',
      '⚠️': 'warning',
      '🔒': 'lock',
    };
    return map[emoji] || emoji.replace(/:/g, '');
  }
}
