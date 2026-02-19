import chalk from 'chalk';
import { agentRegistry } from '../../agents/index.js';
import { stateManager } from '../../state/index.js';
import { config, getConfigPath, getConfigValue, saveConfig } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';
import {
  ensureTelemetryInstallId,
  isValidTelemetryEndpoint,
  resolveTelemetrySettings,
} from '../../telemetry/index.js';

export async function configCommand(options: {
  show?: boolean;
  server?: string;
  token?: string;
  channel?: string;
  port?: string | number;
  defaultAgent?: string;
  opencodePermission?: 'allow' | 'default';
  slackBotToken?: string;
  slackAppToken?: string;
  platform?: string;
  runtimeMode?: 'tmux' | 'pty';
  telemetry?: 'on' | 'off';
  telemetryEndpoint?: string;
}) {
  if (options.show) {
    const telemetry = resolveTelemetrySettings();
    const maskedTelemetryId = telemetry.installId
      ? `${telemetry.installId.slice(0, 8)}...${telemetry.installId.slice(-4)}`
      : '(not set)';

    console.log(chalk.cyan('\n📋 Current configuration:\n'));
    console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`   Platform: ${config.messagingPlatform || 'discord'}`));
    console.log(chalk.gray(`   Server/Workspace ID: ${stateManager.getGuildId() || '(not set)'}`));
    console.log(chalk.gray(`   Discord Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Default Channel ID: ${config.discord.channelId || '(not set)'}`));
    console.log(chalk.gray(`   Slack Bot Token: ${config.slack?.botToken ? '****' + config.slack.botToken.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Slack App Token: ${config.slack?.appToken ? '****' + config.slack.appToken.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
    console.log(chalk.gray(`   Default AI CLI: ${config.defaultAgentCli || '(not set)'}`));
    console.log(chalk.gray(`   OpenCode Permission Mode: ${config.opencode?.permissionMode || '(not set)'}`));
    console.log(chalk.gray(`   Runtime Mode: ${config.runtimeMode || 'tmux'}`));
    console.log(chalk.gray(`   Keep Channel On Stop: ${getConfigValue('keepChannelOnStop') ? 'on' : 'off'}`));
    console.log(chalk.gray(`   Telemetry: ${telemetry.enabled ? 'on' : 'off'}`));
    console.log(chalk.gray(`   Telemetry Endpoint: ${telemetry.endpoint || '(not set)'}`));
    console.log(chalk.gray(`   Telemetry Install ID: ${maskedTelemetryId}`));
    console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
    for (const adapter of agentRegistry.getAll()) {
      console.log(chalk.gray(`   - ${adapter.config.displayName} (${adapter.config.name})`));
    }
    console.log('');
    return;
  }

  let updated = false;

  if (options.telemetryEndpoint !== undefined) {
    const endpoint = options.telemetryEndpoint.trim();
    if (!endpoint) {
      saveConfig({ telemetryEndpoint: undefined });
      console.log(chalk.green('✅ Telemetry endpoint cleared'));
    } else {
      if (!isValidTelemetryEndpoint(endpoint)) {
        console.error(chalk.red('Invalid telemetry endpoint URL. Use an absolute http(s) URL.'));
        process.exit(1);
      }
      saveConfig({ telemetryEndpoint: endpoint });
      console.log(chalk.green(`✅ Telemetry endpoint saved: ${endpoint}`));
    }
    updated = true;
  }

  if (options.telemetry) {
    const enabled = options.telemetry === 'on';
    saveConfig({ telemetryEnabled: enabled });
    if (enabled) {
      const installId = ensureTelemetryInstallId();
      console.log(chalk.green('✅ Telemetry enabled (anonymous usage events)'));
      if (installId) {
        console.log(chalk.gray(`   Install ID: ${installId.slice(0, 8)}...${installId.slice(-4)}`));
      }
      const endpoint = resolveTelemetrySettings().endpoint;
      if (!endpoint) {
        console.log(chalk.yellow('⚠️ Telemetry endpoint is not set.'));
        console.log(chalk.gray('   Set one with: discode config --telemetry-endpoint https://your-worker.example/v1/events'));
      }
    } else {
      console.log(chalk.green('✅ Telemetry disabled'));
    }
    updated = true;
  }

  if (options.platform) {
    const platform = options.platform === 'slack' ? 'slack' : 'discord';
    saveConfig({ messagingPlatform: platform });
    console.log(chalk.green(`✅ Platform saved: ${platform}`));
    updated = true;
  }

  if (options.runtimeMode) {
    saveConfig({ runtimeMode: options.runtimeMode });
    console.log(chalk.green(`✅ Runtime mode saved: ${options.runtimeMode}`));
    updated = true;
  }

  if (options.server) {
    stateManager.setGuildId(options.server);
    saveConfig({ serverId: options.server });
    console.log(chalk.green(`✅ Server ID saved: ${options.server}`));
    updated = true;
  }

  if (options.token) {
    const token = normalizeDiscordToken(options.token);
    if (!token) {
      console.error(chalk.red('Invalid bot token input.'));
      process.exit(1);
    }
    saveConfig({ token });
    console.log(chalk.green(`✅ Bot token saved (****${token.slice(-4)})`));
    updated = true;
  }

  if (options.channel !== undefined) {
    const channel = options.channel.trim();
    if (!channel) {
      saveConfig({ channelId: undefined });
      console.log(chalk.green('✅ Default channel cleared'));
    } else {
      const normalized = channel.replace(/^<#(\d+)>$/, '$1');
      saveConfig({ channelId: normalized });
      console.log(chalk.green(`✅ Default channel saved: ${normalized}`));
    }
    updated = true;
  }

  if (options.slackBotToken) {
    saveConfig({ slackBotToken: options.slackBotToken });
    console.log(chalk.green(`✅ Slack bot token saved (****${options.slackBotToken.slice(-4)})`));
    updated = true;
  }

  if (options.slackAppToken) {
    saveConfig({ slackAppToken: options.slackAppToken });
    console.log(chalk.green(`✅ Slack app token saved (****${options.slackAppToken.slice(-4)})`));
    updated = true;
  }

  if (options.port) {
    const port = parseInt(String(options.port), 10);
    saveConfig({ hookServerPort: port });
    console.log(chalk.green(`✅ Hook port saved: ${port}`));
    updated = true;
  }

  if (options.defaultAgent) {
    const normalized = options.defaultAgent.trim().toLowerCase();
    const adapter = agentRegistry.get(normalized);
    if (!adapter) {
      console.error(chalk.red(`Unknown agent: ${options.defaultAgent}`));
      console.log(chalk.gray(`Available agents: ${agentRegistry.getAll().map((a) => a.config.name).join(', ')}`));
      process.exit(1);
    }
    saveConfig({ defaultAgentCli: adapter.config.name });
    console.log(chalk.green(`✅ Default AI CLI saved: ${adapter.config.name}`));
    updated = true;
  }

  if (options.opencodePermission) {
    saveConfig({ opencodePermissionMode: options.opencodePermission });
    console.log(chalk.green(`✅ OpenCode permission mode saved: ${options.opencodePermission}`));
    updated = true;
  }

  if (!updated) {
    console.log(chalk.yellow('No options provided. Use --help to see available options.'));
    console.log(chalk.gray('\nExample:'));
    console.log(chalk.gray('  discode config --token YOUR_BOT_TOKEN'));
    console.log(chalk.gray('  discode config --server YOUR_SERVER_ID'));
    console.log(chalk.gray('  discode config --channel 123456789012345678'));
    console.log(chalk.gray('  discode config --default-agent claude'));
    console.log(chalk.gray('  discode config --platform slack'));
    console.log(chalk.gray('  discode config --runtime-mode pty'));
    console.log(chalk.gray('  discode config --slack-bot-token xoxb-...'));
    console.log(chalk.gray('  discode config --slack-app-token xapp-...'));
    console.log(chalk.gray('  discode config --opencode-permission allow'));
    console.log(chalk.gray('  discode config --telemetry on'));
    console.log(chalk.gray('  discode config --telemetry-endpoint https://your-worker.example/v1/events'));
    console.log(chalk.gray('  discode config --show'));
  }
}
