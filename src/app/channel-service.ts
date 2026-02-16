import { config, validateConfig } from '../config/index.js';
import { DiscordClient } from '../discord/client.js';
import { SlackClient } from '../slack/client.js';
import type { MessagingClient } from '../messaging/interface.js';

function createMessagingClient(): MessagingClient {
  if (config.messagingPlatform === 'slack') {
    if (!config.slack) {
      throw new Error('Slack is configured as messaging platform but Slack tokens are missing. Run: discode onboard --platform slack');
    }
    return new SlackClient(config.slack.botToken, config.slack.appToken);
  }
  validateConfig();
  return new DiscordClient(config.discord.token);
}

export async function deleteChannels(channelIds: string[]): Promise<string[]> {
  const targets = [...new Set(channelIds.filter((channelId) => !!channelId))];
  if (targets.length === 0) return [];

  const client = createMessagingClient();
  await client.connect();

  try {
    const deleted: string[] = [];
    for (const channelId of targets) {
      const ok = await client.deleteChannel(channelId);
      if (ok) deleted.push(channelId);
    }
    return deleted;
  } finally {
    await client.disconnect();
  }
}
