import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { agentRegistry } from '../../agents/index.js';
import { DiscordClient } from '../../discord/client.js';
import { SlackClient } from '../../slack/client.js';
import { getConfigValue, saveConfig } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';
import { ensureOpencodePermissionChoice } from '../common/opencode-permission.js';
import { confirmYesNo, isInteractiveShell, prompt } from '../common/interactive.js';
import { ensureTelemetryInstallId, resolveTelemetrySettings } from '../../telemetry/index.js';

type RegisteredAgentAdapter = ReturnType<typeof agentRegistry.getAll>[number];

async function chooseDefaultAgentCli(
  installedAgents: RegisteredAgentAdapter[],
  interactive: boolean = isInteractiveShell()
): Promise<string | undefined> {
  if (installedAgents.length === 0) {
    console.log(chalk.yellow('⚠️ No installed AI CLI detected. Install one of: claude, gemini, opencode.'));
    return undefined;
  }

  const configured = getConfigValue('defaultAgentCli');
  const configuredIndex = configured
    ? installedAgents.findIndex((agent) => agent.config.name === configured)
    : -1;
  const defaultIndex = configuredIndex >= 0 ? configuredIndex : 0;

  if (!interactive) {
    const selected = installedAgents[defaultIndex];
    console.log(chalk.yellow(`⚠️ Non-interactive shell: default AI CLI set to ${selected.config.name}.`));
    return selected.config.name;
  }

  console.log(chalk.white('\nChoose default AI CLI'));
  installedAgents.forEach((agent, index) => {
    const marker = index === defaultIndex ? ' (default)' : '';
    console.log(chalk.gray(`   ${index + 1}. ${agent.config.displayName} (${agent.config.name})${marker}`));
  });

  while (true) {
    const answer = await prompt(chalk.white(`\nSelect default AI CLI [1-${installedAgents.length}] (Enter = default): `));
    if (!answer) {
      return installedAgents[defaultIndex].config.name;
    }

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < installedAgents.length) {
      return installedAgents[idx].config.name;
    }

    console.log(chalk.yellow('Please enter a valid number.'));
  }
}

async function choosePlatform(interactive: boolean = isInteractiveShell()): Promise<'discord' | 'slack'> {
  const configured = getConfigValue('messagingPlatform');
  if (!interactive) {
    const platform = configured || 'discord';
    console.log(chalk.yellow(`⚠️ Non-interactive shell: using platform ${platform}.`));
    return platform;
  }

  console.log(chalk.white('\nChoose messaging platform'));
  console.log(chalk.gray(`   1. Discord${configured === 'discord' || !configured ? ' (default)' : ''}`));
  console.log(chalk.gray(`   2. Slack${configured === 'slack' ? ' (default)' : ''}`));

  const answer = await prompt(chalk.white('\nSelect platform [1-2] (Enter = default): '));
  if (!answer) return configured || 'discord';
  if (answer === '2') return 'slack';
  return 'discord';
}

async function chooseRuntimeMode(
  explicitMode?: string,
  interactive: boolean = isInteractiveShell()
): Promise<'tmux' | 'pty'> {
  if (explicitMode === 'tmux' || explicitMode === 'pty') {
    return explicitMode;
  }

  if (!interactive) {
    console.log(chalk.yellow('⚠️ Non-interactive shell: using runtime mode pty.'));
    return 'pty';
  }

  console.log(chalk.white('\nChoose runtime mode'));
  console.log(chalk.gray('   1. pty (default)'));
  console.log(chalk.gray('   2. tmux (only for users comfortable with tmux)'));

  while (true) {
    const answer = await prompt(chalk.white('\nSelect runtime mode [1-2] (Enter = default): '));
    if (!answer || answer === '1') return 'pty';
    if (answer === '2') return 'tmux';
    console.log(chalk.yellow('Please enter a valid number.'));
  }
}

async function chooseTelemetryOptIn(interactive: boolean = isInteractiveShell()): Promise<boolean> {
  const configured = getConfigValue('telemetryEnabled');
  const defaultEnabled = configured === true;

  if (!interactive) {
    const enabled = configured === true;
    console.log(chalk.yellow(`⚠️ Non-interactive shell: telemetry ${enabled ? 'on' : 'off'}.`));
    return enabled;
  }

  console.log(chalk.white('\nAnonymous telemetry (optional)'));
  console.log(chalk.gray('   Sends only command usage metadata (command, success/failure, duration).'));
  console.log(chalk.gray('   Never sends bot tokens, prompts, paths, project names, or message contents.'));

  return confirmYesNo(chalk.white('Enable anonymous CLI telemetry? [y/N]: '), defaultEnabled);
}

async function onboardDiscord(token?: string, interactive: boolean = isInteractiveShell()): Promise<void> {
  const existingToken = normalizeDiscordToken(getConfigValue('token'));
  token = normalizeDiscordToken(token);
  if (!token) {
    if (existingToken) {
      if (interactive) {
        const maskedToken = `****${existingToken.slice(-4)}`;
        const reuseToken = await confirmYesNo(
          chalk.white(`Previously saved Discord bot token found (${maskedToken}). Use it? [Y/n]: `),
          true
        );
        if (reuseToken) {
          token = existingToken;
          console.log(chalk.green(`✅ Reusing saved bot token (${maskedToken})`));
        }
      } else {
        token = existingToken;
        console.log(chalk.yellow(`⚠️ Non-interactive shell: using previously saved bot token (****${existingToken.slice(-4)}).`));
      }
    }

    if (!token && !interactive) {
      console.error(chalk.red('Token is required in non-interactive mode.'));
      console.log(chalk.gray('Run: discode onboard --token YOUR_DISCORD_BOT_TOKEN'));
      console.log(chalk.gray('How to create a Discord bot token: https://discode.chat/docs/discord-bot'));
      throw new Error('Discord bot token is required in non-interactive mode.');
    }

    if (!token) {
      console.log(chalk.gray('Need a bot token? See: https://discode.chat/docs/discord-bot'));
      token = normalizeDiscordToken(await prompt(chalk.white('Discord bot token: ')));
    }
    if (!token) {
      console.log(chalk.gray('How to create a Discord bot token: https://discode.chat/docs/discord-bot'));
      throw new Error('Discord bot token is required.');
    }
  }

  saveConfig({ token });
  console.log(chalk.green('✅ Bot token saved'));

  console.log(chalk.gray('   Connecting to Discord...'));
  const client = new DiscordClient(token);
  await client.connect();

  const guilds = client.getGuilds();
  let selectedGuild: { id: string; name: string };

  if (guilds.length === 0) {
    console.error(chalk.red('\n❌ Bot is not in any server.'));
    console.log(chalk.gray('   Invite your bot to a server first:'));
    console.log(chalk.gray('   https://discord.com/developers/applications → OAuth2 → URL Generator'));
    await client.disconnect();
    throw new Error('Bot is not in any Discord server.');
  }

  if (guilds.length === 1) {
    selectedGuild = guilds[0];
    console.log(chalk.green(`✅ Server detected: ${selectedGuild.name} (${selectedGuild.id})`));
  } else {
    console.log(chalk.white('\n   Bot is in multiple servers:\n'));
    guilds.forEach((g, i) => {
      console.log(chalk.gray(`   ${i + 1}. ${g.name} (${g.id})`));
    });

    if (!interactive) {
      selectedGuild = guilds[0];
      console.log(chalk.yellow(`⚠️ Non-interactive shell: selecting first server ${selectedGuild.name} (${selectedGuild.id}).`));
    } else {
      const answer = await prompt(chalk.white(`\n   Select server [1-${guilds.length}]: `));
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= guilds.length) {
        await client.disconnect();
        throw new Error('Invalid server selection.');
      }
      selectedGuild = guilds[idx];
      console.log(chalk.green(`✅ Server selected: ${selectedGuild.name}`));
    }
  }

  stateManager.setGuildId(selectedGuild.id);
  saveConfig({ serverId: selectedGuild.id });
  await client.disconnect();
}

async function onboardSlack(
  options?: { botToken?: string; appToken?: string },
  interactive: boolean = isInteractiveShell()
): Promise<void> {
  const existingBotToken = getConfigValue('slackBotToken')?.trim();
  const existingAppToken = getConfigValue('slackAppToken')?.trim();

  let botToken: string | undefined = options?.botToken;
  let appToken: string | undefined = options?.appToken;

  if (botToken && appToken) {
    // Tokens provided via CLI flags — skip interactive prompts.
  } else if (existingBotToken && existingAppToken && interactive) {
    const maskedBot = `****${existingBotToken.slice(-4)}`;
    const reuse = await confirmYesNo(
      chalk.white(`Previously saved Slack tokens found (Bot: ${maskedBot}). Use them? [Y/n]: `),
      true
    );
    if (reuse) {
      botToken = existingBotToken;
      appToken = existingAppToken;
      console.log(chalk.green(`✅ Reusing saved Slack tokens`));
    }
  } else if (existingBotToken && existingAppToken && !interactive) {
    botToken = existingBotToken;
    appToken = existingAppToken;
    console.log(chalk.yellow(`⚠️ Non-interactive shell: using previously saved Slack tokens.`));
  }

  if (!botToken) {
    if (!interactive) {
      console.error(chalk.red('Slack tokens are required in non-interactive mode.'));
      console.log(chalk.gray('Run: discode config --slack-bot-token TOKEN --slack-app-token TOKEN --platform slack'));
      throw new Error('Slack bot token is required in non-interactive mode.');
    }
    botToken = await prompt(chalk.white('Slack Bot Token (xoxb-...): '));
    if (!botToken) {
      throw new Error('Slack bot token is required.');
    }
  }

  if (!appToken) {
    if (!interactive) {
      throw new Error('Slack app-level token is required in non-interactive mode.');
    }
    appToken = await prompt(chalk.white('Slack App-Level Token (xapp-...): '));
    if (!appToken) {
      throw new Error('Slack app-level token is required.');
    }
  }

  saveConfig({ slackBotToken: botToken, slackAppToken: appToken });
  console.log(chalk.green('✅ Slack tokens saved'));

  console.log(chalk.gray('   Connecting to Slack...'));
  const client = new SlackClient(botToken, appToken);
  await client.connect();

  const workspaces = client.getGuilds();
  if (workspaces.length > 0) {
    const ws = workspaces[0];
    console.log(chalk.green(`✅ Workspace detected: ${ws.name} (${ws.id})`));
    stateManager.setWorkspaceId(ws.id);
  } else {
    console.log(chalk.yellow('⚠️ Could not detect workspace. You may need to set server ID manually.'));
  }

  await client.disconnect();
}

export async function onboardCommand(options: {
  token?: string;
  platform?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  runtimeMode?: string;
  defaultAgentCli?: string;
  telemetryEnabled?: boolean;
  opencodePermissionMode?: 'allow' | 'default';
  nonInteractive?: boolean;
  exitOnError?: boolean;
}) {
  try {
    const interactive = options.nonInteractive ? false : isInteractiveShell();
    console.log(chalk.cyan('\n🚀 Discode Onboarding\n'));

    const platform = (options.platform as 'discord' | 'slack')
      || (interactive ? await choosePlatform(interactive) : await choosePlatform(false));
    saveConfig({ messagingPlatform: platform });
    console.log(chalk.green(`✅ Platform: ${platform}`));

    if (platform === 'slack') {
      const botToken = options.slackBotToken || (interactive ? undefined : getConfigValue('slackBotToken'));
      const appToken = options.slackAppToken || (interactive ? undefined : getConfigValue('slackAppToken'));
      await onboardSlack({ botToken, appToken }, interactive);
    } else {
      const token = options.token || (interactive ? undefined : normalizeDiscordToken(getConfigValue('token')));
      await onboardDiscord(token, interactive);
    }

    const runtimeMode = await chooseRuntimeMode(
      options.runtimeMode || (!interactive ? getConfigValue('runtimeMode') : undefined),
      interactive
    );
    saveConfig({ runtimeMode });
    console.log(chalk.green(`✅ Runtime mode saved: ${runtimeMode}`));

    const installedAgents = agentRegistry.getAll().filter((a) => a.isInstalled());
    let defaultAgentCli: string | undefined;
    if (typeof options.defaultAgentCli === 'string' && options.defaultAgentCli.trim().toLowerCase() === 'auto') {
      saveConfig({ defaultAgentCli: undefined });
      console.log(chalk.green('✅ Default AI CLI saved: auto'));
    } else if (typeof options.defaultAgentCli === 'string' && options.defaultAgentCli.trim().length > 0) {
      const requested = options.defaultAgentCli.trim().toLowerCase();
      const matched = installedAgents.find((agent) => agent.config.name === requested);
      if (!matched) {
        throw new Error(`Unknown or not-installed default agent: ${requested}`);
      }
      defaultAgentCli = matched.config.name;
    } else {
      defaultAgentCli = await chooseDefaultAgentCli(installedAgents, interactive);
    }

    if (defaultAgentCli) {
      saveConfig({ defaultAgentCli });
      console.log(chalk.green(`✅ Default AI CLI saved: ${defaultAgentCli}`));
    }

    if (options.opencodePermissionMode) {
      saveConfig({ opencodePermissionMode: options.opencodePermissionMode });
      console.log(chalk.green(`✅ OpenCode permission mode saved: ${options.opencodePermissionMode}`));
    } else if (interactive) {
      await ensureOpencodePermissionChoice({ shouldPrompt: true, forcePrompt: true });
    } else if (!getConfigValue('opencodePermissionMode')) {
      saveConfig({ opencodePermissionMode: 'default' });
      console.log(chalk.yellow('⚠️ Non-interactive shell: OpenCode permission mode set to default.'));
    }

    const telemetryEnabled = typeof options.telemetryEnabled === 'boolean'
      ? options.telemetryEnabled
      : await chooseTelemetryOptIn(interactive);
    saveConfig({ telemetryEnabled });
    if (telemetryEnabled) {
      const installId = ensureTelemetryInstallId();
      console.log(chalk.green('✅ Anonymous telemetry enabled'));
      if (installId) {
        console.log(chalk.gray(`   Install ID: ${installId.slice(0, 8)}...${installId.slice(-4)}`));
      }
      const endpoint = resolveTelemetrySettings().endpoint;
      if (!endpoint) {
        console.log(chalk.yellow('⚠️ Telemetry endpoint is not set.'));
        console.log(chalk.gray('   Set one with: discode config --telemetry-endpoint https://your-worker.example/v1/events'));
      }
    } else {
      console.log(chalk.green('✅ Anonymous telemetry disabled'));
    }

    console.log(chalk.cyan('\n✨ Onboarding complete!\n'));
    console.log(chalk.white('Next step:'));
    console.log(chalk.gray('   cd <your-project>'));
    console.log(chalk.gray('   discode new\n'));
  } catch (error) {
    if (options.exitOnError === false) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red('Onboarding failed:'), message);
    process.exit(1);
  }
}
