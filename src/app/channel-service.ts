import { config, validateConfig } from '../config/index.js';
import { DiscordClient } from '../discord/client.js';

export async function deleteDiscordChannels(channelIds: string[]): Promise<string[]> {
  const targets = [...new Set(channelIds.filter((channelId) => !!channelId))];
  if (targets.length === 0) return [];

  validateConfig();
  const client = new DiscordClient(config.discord.token);
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
