import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { agentRegistry } from '../../agents/index.js';
import { DiscordClient } from '../../discord/client.js';
import { getConfigValue, saveConfig } from '../../config/index.js';
import { ensureOpencodePermissionChoice } from '../common/opencode-permission.js';
import { confirmYesNo, isInteractiveShell, prompt } from '../common/interactive.js';

type RegisteredAgentAdapter = ReturnType<typeof agentRegistry.getAll>[number];

async function chooseDefaultAgentCli(installedAgents: RegisteredAgentAdapter[]): Promise<string | undefined> {
  if (installedAgents.length === 0) {
    console.log(chalk.yellow('⚠️ No installed AI CLI detected. Install one of: claude, codex, gemini, opencode.'));
    return undefined;
  }

  const configured = getConfigValue('defaultAgentCli');
  const configuredIndex = configured
    ? installedAgents.findIndex((agent) => agent.config.name === configured)
    : -1;
  const defaultIndex = configuredIndex >= 0 ? configuredIndex : 0;

  if (!isInteractiveShell()) {
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

export async function onboardCommand(options: { token?: string }) {
  try {
    console.log(chalk.cyan('\n🚀 Discode Onboarding\n'));

    const existingToken = getConfigValue('token')?.trim();
    let token = options.token?.trim();
    if (!token) {
      if (existingToken) {
        if (isInteractiveShell()) {
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

      if (!token && !isInteractiveShell()) {
        console.error(chalk.red('Token is required in non-interactive mode.'));
        console.log(chalk.gray('Run: discode onboard --token YOUR_DISCORD_BOT_TOKEN'));
        process.exit(1);
      }

      if (!token) {
        token = await prompt(chalk.white('Discord bot token: '));
      }
      if (!token) {
        console.error(chalk.red('Bot token is required.'));
        process.exit(1);
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
      process.exit(1);
    }

    if (guilds.length === 1) {
      selectedGuild = guilds[0];
      console.log(chalk.green(`✅ Server detected: ${selectedGuild.name} (${selectedGuild.id})`));
    } else {
      console.log(chalk.white('\n   Bot is in multiple servers:\n'));
      guilds.forEach((g, i) => {
        console.log(chalk.gray(`   ${i + 1}. ${g.name} (${g.id})`));
      });

      if (!isInteractiveShell()) {
        selectedGuild = guilds[0];
        console.log(chalk.yellow(`⚠️ Non-interactive shell: selecting first server ${selectedGuild.name} (${selectedGuild.id}).`));
      } else {
        const answer = await prompt(chalk.white(`\n   Select server [1-${guilds.length}]: `));
        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= guilds.length) {
          console.error(chalk.red('Invalid selection.'));
          await client.disconnect();
          process.exit(1);
        }
        selectedGuild = guilds[idx];
        console.log(chalk.green(`✅ Server selected: ${selectedGuild.name}`));
      }
    }

    stateManager.setGuildId(selectedGuild.id);
    saveConfig({ serverId: selectedGuild.id });

    const installedAgents = agentRegistry.getAll().filter((a) => a.isInstalled());
    const defaultAgentCli = await chooseDefaultAgentCli(installedAgents);
    if (defaultAgentCli) {
      saveConfig({ defaultAgentCli });
      console.log(chalk.green(`✅ Default AI CLI saved: ${defaultAgentCli}`));
    }

    await ensureOpencodePermissionChoice({ shouldPrompt: true, forcePrompt: true });

    await client.disconnect();

    console.log(chalk.cyan('\n✨ Onboarding complete!\n'));
    console.log(chalk.white('Next step:'));
    console.log(chalk.gray('   cd <your-project>'));
    console.log(chalk.gray('   discode new\n'));
  } catch (error) {
    console.error(chalk.red('Onboarding failed:'), error);
    process.exit(1);
  }
}
