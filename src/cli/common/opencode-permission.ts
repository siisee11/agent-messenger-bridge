import chalk from 'chalk';
import { config, saveConfig } from '../../config/index.js';
import { confirmYesNo, isInteractiveShell } from './interactive.js';

export async function ensureOpencodePermissionChoice(options: {
  shouldPrompt: boolean;
  forcePrompt?: boolean;
}): Promise<void> {
  if (!options.shouldPrompt) return;
  if (!options.forcePrompt && config.opencode?.permissionMode) return;

  if (!isInteractiveShell()) {
    saveConfig({ opencodePermissionMode: 'default' });
    console.log(chalk.yellow('⚠️ Non-interactive shell: OpenCode permission mode set to default.'));
    return;
  }

  console.log(chalk.white('\nOpenCode permission setup'));
  console.log(chalk.gray('Set OpenCode to "allow" to reduce Discord approval prompts.'));
  const allow = await confirmYesNo(chalk.white('Enable OpenCode "allow" mode? [Y/n]: '), true);

  saveConfig({ opencodePermissionMode: allow ? 'allow' : 'default' });
  if (allow) {
    console.log(chalk.green('✅ OpenCode permission mode saved: allow (recommended)'));
  } else {
    console.log(chalk.gray('OpenCode permission mode saved: default'));
    console.log(chalk.yellow('⚠️ Permission mode is default. Discord usage may feel inconvenient because approval prompts can appear often.'));
  }
}
