/**
 * Configuration management
 */

import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import type { BridgeConfig, MessagingPlatform } from '../types/index.js';
import type { IStorage, IEnvironment } from '../types/interfaces.js';
import { FileStorage } from '../infra/storage.js';
import { SystemEnvironment } from '../infra/environment.js';
import { normalizeDiscordToken } from './token.js';

export interface StoredConfig {
  token?: string;
  serverId?: string;
  channelId?: string;
  hookServerPort?: number;
  defaultAgentCli?: string;
  opencodePermissionMode?: 'allow' | 'default';
  keepChannelOnStop?: boolean;
  slackBotToken?: string;
  slackAppToken?: string;
  messagingPlatform?: 'discord' | 'slack';
  runtimeMode?: 'tmux' | 'pty';
}

export class ConfigManager {
  private storage: IStorage;
  private env: IEnvironment;
  private configDir: string;
  private configFile: string;
  private _config?: BridgeConfig;
  private envLoaded = false;

  constructor(storage?: IStorage, env?: IEnvironment, configDir?: string) {
    this.storage = storage || new FileStorage();
    this.env = env || new SystemEnvironment();
    this.configDir = configDir || join(this.env.homedir(), '.discode');
    this.configFile = join(this.configDir, 'config.json');
  }

  get config(): BridgeConfig {
    if (!this._config) {
      // Lazy load environment variables only once
      if (!this.envLoaded) {
        loadEnv();
        this.envLoaded = true;
      }

      const storedConfig = this.loadStoredConfig();
      const storedToken = normalizeDiscordToken(storedConfig.token);
      const envToken = normalizeDiscordToken(this.env.get('DISCORD_BOT_TOKEN'));
      const envPermissionModeRaw = this.env.get('OPENCODE_PERMISSION_MODE');
      const envPermissionMode =
        envPermissionModeRaw === 'allow' || envPermissionModeRaw === 'default'
          ? envPermissionModeRaw
          : undefined;
      const opencodePermissionMode = storedConfig.opencodePermissionMode || envPermissionMode;
      const defaultAgentCli = storedConfig.defaultAgentCli || this.env.get('DISCODE_DEFAULT_AGENT_CLI');

      const platformRaw = storedConfig.messagingPlatform || this.env.get('MESSAGING_PLATFORM');
      const messagingPlatform: MessagingPlatform | undefined =
        platformRaw === 'slack' ? 'slack' : platformRaw === 'discord' ? 'discord' : undefined;

      const slackBotToken = storedConfig.slackBotToken || this.env.get('SLACK_BOT_TOKEN');
      const slackAppToken = storedConfig.slackAppToken || this.env.get('SLACK_APP_TOKEN');
      const runtimeModeRaw = storedConfig.runtimeMode || this.env.get('DISCODE_RUNTIME_MODE');
      const runtimeMode = runtimeModeRaw === 'pty' ? 'pty' : 'tmux';

      // Merge: stored config > environment variables > defaults
      this._config = {
        discord: {
          token: storedToken || envToken || '',
          channelId: storedConfig.channelId || this.env.get('DISCORD_CHANNEL_ID'),
          guildId: storedConfig.serverId || this.env.get('DISCORD_GUILD_ID'),
        },
        ...(slackBotToken && slackAppToken
          ? { slack: { botToken: slackBotToken, appToken: slackAppToken } }
          : {}),
        ...(messagingPlatform ? { messagingPlatform } : {}),
        runtimeMode,
        tmux: {
          sessionPrefix: this.env.get('TMUX_SESSION_PREFIX') || '',
          sharedSessionName: this.env.get('TMUX_SHARED_SESSION_NAME') || 'bridge',
        },
        hookServerPort: storedConfig.hookServerPort ||
          (this.env.get('HOOK_SERVER_PORT') ? parseInt(this.env.get('HOOK_SERVER_PORT')!, 10) : 18470),
        ...(defaultAgentCli ? { defaultAgentCli } : {}),
        opencode: opencodePermissionMode
          ? { permissionMode: opencodePermissionMode }
          : undefined,
      };
    }
    return this._config;
  }

  loadStoredConfig(): StoredConfig {
    if (!this.storage.exists(this.configFile)) {
      return {};
    }
    try {
      const data = this.storage.readFile(this.configFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  saveConfig(updates: Partial<StoredConfig>): void {
    if (!this.storage.exists(this.configDir)) {
      this.storage.mkdirp(this.configDir);
    }

    const normalizedUpdates: Partial<StoredConfig> = {
      ...updates,
      ...(updates.token !== undefined ? { token: normalizeDiscordToken(updates.token) } : {}),
    };

    const current = this.loadStoredConfig();
    const newConfig = { ...current, ...normalizedUpdates };
    this.storage.writeFile(this.configFile, JSON.stringify(newConfig, null, 2));
    this.storage.chmod(this.configFile, 0o600);

    // Invalidate cached config
    this._config = undefined;
  }

  getConfigValue<K extends keyof StoredConfig>(key: K): StoredConfig[K] {
    const stored = this.loadStoredConfig();
    return stored[key];
  }

  validateConfig(): void {
    if (this.config.messagingPlatform === 'slack') {
      if (!this.config.slack?.botToken || !this.config.slack?.appToken) {
        throw new Error(
          'Slack tokens not configured.\n' +
          'Run: discode onboard --platform slack\n' +
          'Or set SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables'
        );
      }
    } else {
      if (!this.config.discord.token) {
        throw new Error(
          'Discord bot token not configured.\n' +
          'Run: discode config --token <your-token>\n' +
          'Or set DISCORD_BOT_TOKEN environment variable'
        );
      }
    }
  }

  getConfigPath(): string {
    return this.configFile;
  }

  resetConfig(): void {
    this._config = undefined;
    this.envLoaded = false;
  }
}

// Default instance for backward compatibility
const defaultConfigManager = new ConfigManager();

// Backward-compatible exports using Proxy for lazy initialization
export const config: BridgeConfig = new Proxy({} as BridgeConfig, {
  get(_target, prop) {
    return (defaultConfigManager.config as any)[prop];
  }
});

export function saveConfig(updates: Partial<StoredConfig>): void {
  defaultConfigManager.saveConfig(updates);
}

export function getConfigValue<K extends keyof StoredConfig>(key: K): StoredConfig[K] {
  return defaultConfigManager.getConfigValue(key);
}

export function validateConfig(): void {
  defaultConfigManager.validateConfig();
}

export function getConfigPath(): string {
  return defaultConfigManager.getConfigPath();
}
