import chalk from 'chalk';
import { agentRegistry } from '../../agents/index.js';
import { stateManager } from '../../state/index.js';
import { config, getConfigPath, saveConfig } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';

export async function configCommand(options: {
  show?: boolean;
  server?: string;
  token?: string;
  port?: string | number;
  defaultAgent?: string;
  opencodePermission?: 'allow' | 'default';
}) {
  if (options.show) {
    console.log(chalk.cyan('\n📋 Current configuration:\n'));
    console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId() || '(not set)'}`));
    console.log(chalk.gray(`   Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
    console.log(chalk.gray(`   Default AI CLI: ${config.defaultAgentCli || '(not set)'}`));
    console.log(chalk.gray(`   OpenCode Permission Mode: ${config.opencode?.permissionMode || '(not set)'}`));
    console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
    for (const adapter of agentRegistry.getAll()) {
      console.log(chalk.gray(`   - ${adapter.config.displayName} (${adapter.config.name})`));
    }
    console.log('');
    return;
  }

  let updated = false;

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
    console.log(chalk.gray('  discode config --default-agent claude'));
    console.log(chalk.gray('  discode config --opencode-permission allow'));
    console.log(chalk.gray('  discode config --show'));
  }
}
