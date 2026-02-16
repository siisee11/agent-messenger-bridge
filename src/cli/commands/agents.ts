import chalk from 'chalk';
import { agentRegistry } from '../../agents/index.js';

export function agentsCommand() {
  console.log(chalk.cyan('\n🤖 Available Agent Adapters:\n'));
  for (const adapter of agentRegistry.getAll()) {
    console.log(chalk.white(`  ${adapter.config.displayName}`));
    console.log(chalk.gray(`    Name: ${adapter.config.name}`));
    console.log(chalk.gray(`    Command: ${adapter.config.command}`));
    console.log('');
  }
}
