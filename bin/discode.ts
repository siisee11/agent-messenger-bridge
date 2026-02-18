#!/usr/bin/env bun

/**
 * CLI entry point for discode
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { Argv } from 'yargs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { newCommand } from '../src/cli/commands/new.js';
import { attachCommand } from '../src/cli/commands/attach.js';
import { stopCommand } from '../src/cli/commands/stop.js';
import { tuiCommand } from '../src/cli/commands/tui.js';
import { onboardCommand } from '../src/cli/commands/onboard.js';
import { startCommand } from '../src/cli/commands/start.js';
import { configCommand } from '../src/cli/commands/config.js';
import { statusCommand } from '../src/cli/commands/status.js';
import { listCommand } from '../src/cli/commands/list.js';
import { agentsCommand } from '../src/cli/commands/agents.js';
import { daemonCommand } from '../src/cli/commands/daemon.js';
import { uninstallCommand } from '../src/cli/commands/uninstall.js';
import { getDaemonStatus, restartDaemonIfRunning } from '../src/app/daemon-service.js';
import { addTmuxOptions } from '../src/cli/common/options.js';
import { confirmYesNo, isInteractiveShell } from '../src/cli/common/interactive.js';

export { newCommand, attachCommand, stopCommand };

declare const DISCODE_VERSION: string | undefined;

function resolveCliVersion(): string {
  if (typeof DISCODE_VERSION !== 'undefined' && DISCODE_VERSION) {
    return DISCODE_VERSION;
  }

  const candidates = [
    resolve(import.meta.dirname, '../package.json'),
    resolve(import.meta.dirname, '../../package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Try next candidate.
    }
  }

  return process.env.npm_package_version || '0.0.0';
}

const CLI_VERSION = resolveCliVersion();

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA || !parsedB) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }

  for (let i = 0; i < 3; i += 1) {
    if (parsedA[i] > parsedB[i]) return 1;
    if (parsedA[i] < parsedB[i]) return -1;
  }
  return 0;
}

function isSourceRuntime(): boolean {
  const argv1 = process.argv[1] || '';
  return argv1.endsWith('.ts') || argv1.endsWith('.tsx') || argv1.includes('/bin/discode.ts');
}

function hasCommand(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function commandNameFromArgs(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

async function fetchLatestCliVersion(timeoutMs: number = 2500): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://registry.npmjs.org/@siisee11/discode/latest', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type UpgradeInstallPlan = {
  label: string;
  command: string;
};

function detectUpgradeInstallPlan(): UpgradeInstallPlan | null {
  if (hasCommand('npm')) {
    return { label: 'npm', command: 'npm install -g @siisee11/discode@latest' };
  }
  if (hasCommand('bun')) {
    return { label: 'bun', command: 'bun add -g @siisee11/discode@latest' };
  }
  return null;
}

async function restartDaemonIfRunningForUpgrade(): Promise<void> {
  const status = await getDaemonStatus();
  if (!status.running) return;

  const port = status.port;
  console.log(chalk.gray('   Restarting bridge daemon to apply update...'));

  const restart = await restartDaemonIfRunning();
  if (!restart.restarted) {
    console.log(chalk.yellow('⚠️ Could not restart daemon automatically. Restart manually with: discode daemon stop && discode daemon start'));
    return;
  }

  if (restart.ready) {
    console.log(chalk.green(`✅ Bridge daemon restarted (port ${port})`));
  } else {
    console.log(chalk.yellow(`⚠️ Daemon may not be ready yet. Check logs: ${restart.logFile}`));
  }
}

function shouldCheckForUpdate(rawArgs: string[]): boolean {
  if (!isInteractiveShell()) return false;
  if (process.env.DISCODE_SKIP_UPDATE_CHECK === '1') return false;
  if (isSourceRuntime()) return false;
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v')) return false;

  const command = commandNameFromArgs(rawArgs);
  if (!command) return false;

  if (command === 'tui' || command === 'daemon') return false;
  return true;
}

async function maybePromptForUpgrade(rawArgs: string[]): Promise<void> {
  if (!shouldCheckForUpdate(rawArgs)) return;

  const latestVersion = await fetchLatestCliVersion();
  if (!latestVersion) return;
  if (compareSemver(latestVersion, CLI_VERSION) <= 0) return;

  console.log(chalk.cyan(`\n⬆️  A new Discode version is available: ${CLI_VERSION} → ${latestVersion}`));
  const shouldUpgrade = await confirmYesNo(chalk.white('Upgrade now? [Y/n]: '), true);
  if (!shouldUpgrade) {
    console.log(chalk.gray('   Skipping update for now.'));
    return;
  }

  const plan = detectUpgradeInstallPlan();
  if (!plan) {
    console.log(chalk.yellow('⚠️ No supported package manager found for auto-upgrade.'));
    console.log(chalk.gray('   Install manually: npm install -g @siisee11/discode@latest'));
    return;
  }

  try {
    console.log(chalk.gray(`   Running: ${plan.command}`));
    execSync(plan.command, { stdio: 'inherit' });
    console.log(chalk.green(`✅ Updated to latest via ${plan.label}`));
    await restartDaemonIfRunningForUpgrade();
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Auto-upgrade failed: ${error instanceof Error ? error.message : String(error)}`));
    console.log(chalk.gray('   You can retry manually: npm install -g @siisee11/discode@latest'));
  }
}

export async function runCli(rawArgs: string[] = hideBin(process.argv)): Promise<void> {
  await maybePromptForUpgrade(rawArgs);

  await yargs(rawArgs)
    .scriptName('discode')
    .usage('$0 [command]')
    .version(CLI_VERSION)
    .help()
    .strict()
    .command(
      ['$0', 'tui'],
      'Interactive terminal UI (supports /new)',
      (y: Argv) => addTmuxOptions(y),
      async (argv: any) =>
        tuiCommand({
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'onboard',
      'One-time onboarding: save token, choose default AI CLI, configure OpenCode permission',
      (y: Argv) => y
        .option('platform', { type: 'string', choices: ['discord', 'slack'], describe: 'Messaging platform to use' })
        .option('token', { alias: 't', type: 'string', describe: 'Discord bot token (optional; prompt if omitted)' })
        .option('slack-bot-token', { type: 'string', describe: 'Slack bot token (xoxb-...)' })
        .option('slack-app-token', { type: 'string', describe: 'Slack app-level token (xapp-...)' }),
      async (argv: any) => onboardCommand({
        platform: argv.platform,
        token: argv.token,
        slackBotToken: argv.slackBotToken,
        slackAppToken: argv.slackAppToken,
      })
    )
    .command(
      'setup [token]',
      false,
      (y: Argv) => y.positional('token', { type: 'string', describe: 'Discord bot token (deprecated)' }),
      async (argv: any) => {
        console.log(chalk.yellow('⚠️ `setup` is deprecated. Use `discode onboard` instead.'));
        await onboardCommand({ token: argv.token });
      }
    )
    .command(
      'start',
      'Start the Discord bridge server',
      (y: Argv) => addTmuxOptions(y)
        .option('project', { alias: 'p', type: 'string', describe: 'Start for specific project only' })
        .option('attach', { alias: 'a', type: 'boolean', describe: 'Attach to tmux session after starting (requires --project)' }),
      async (argv: any) =>
        startCommand({
          project: argv.project,
          attach: argv.attach,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'new [agent]',
      'Quick start: launch daemon, setup project, attach tmux',
      (y: Argv) => addTmuxOptions(y)
        .positional('agent', { type: 'string', describe: 'Agent to use (claude, gemini, opencode)' })
        .option('name', { alias: 'n', type: 'string', describe: 'Project name (defaults to directory name)' })
        .option('instance', { type: 'string', describe: 'Agent instance ID (e.g. gemini-2)' })
        .option('attach', { type: 'boolean', default: true, describe: 'Attach to tmux session after setup' }),
      async (argv: any) =>
        newCommand(argv.agent, {
          name: argv.name,
          instance: argv.instance,
          attach: argv.attach,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'config',
      'Configure bridge settings',
      (y: Argv) => y
        .option('server', { alias: 's', type: 'string', describe: 'Set Discord server / Slack workspace ID' })
        .option('token', { alias: 't', type: 'string', describe: 'Set Discord bot token' })
        .option('channel', { alias: 'c', type: 'string', describe: 'Set default Discord channel ID override' })
        .option('port', { alias: 'p', type: 'string', describe: 'Set hook server port' })
        .option('default-agent', { type: 'string', describe: 'Set default AI CLI for `discode new`' })
        .option('platform', { type: 'string', choices: ['discord', 'slack'], describe: 'Set messaging platform' })
        .option('runtime-mode', { type: 'string', choices: ['tmux', 'pty'], describe: 'Set runtime backend' })
        .option('slack-bot-token', { type: 'string', describe: 'Set Slack bot token (xoxb-...)' })
        .option('slack-app-token', { type: 'string', describe: 'Set Slack app-level token (xapp-...)' })
        .option('opencode-permission', {
          type: 'string',
          choices: ['allow', 'default'],
          describe: 'Set OpenCode permission mode',
        })
        .option('show', { type: 'boolean', describe: 'Show current configuration' }),
      async (argv: any) =>
        configCommand({
          show: argv.show,
          server: argv.server,
          token: argv.token,
          channel: argv.channel,
          port: argv.port,
          defaultAgent: argv.defaultAgent,
          opencodePermission: argv.opencodePermission,
          platform: argv.platform,
          runtimeMode: argv.runtimeMode,
          slackBotToken: argv.slackBotToken,
          slackAppToken: argv.slackAppToken,
        })
    )
    .command(
      'status',
      'Show bridge and project status',
      (y: Argv) => addTmuxOptions(y),
      async (argv: any) =>
        await statusCommand({
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'list',
      'List all configured projects',
      (y: Argv) => y.option('prune', { type: 'boolean', describe: 'Remove projects whose tmux window is not running' }),
      async (argv: any) => await listCommand({ prune: argv.prune })
    )
    .command(
      'ls',
      false,
      (y: Argv) => y.option('prune', { type: 'boolean', describe: 'Remove projects whose tmux window is not running' }),
      async (argv: any) => await listCommand({ prune: argv.prune })
    )
    .command('agents', 'List available AI agent adapters', () => {}, () => agentsCommand())
    .command(
      'attach [project]',
      'Attach to a project tmux session',
      (y: Argv) => addTmuxOptions(y)
        .positional('project', { type: 'string' })
        .option('instance', { type: 'string', describe: 'Attach specific instance ID' }),
      async (argv: any) =>
        await attachCommand(argv.project, {
          instance: argv.instance,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'stop [project]',
      'Stop a project (kills tmux session, deletes Discord channel)',
      (y: Argv) => addTmuxOptions(y)
        .positional('project', { type: 'string' })
        .option('instance', { type: 'string', describe: 'Stop only a specific instance ID' })
        .option('keep-channel', { type: 'boolean', describe: 'Keep Discord channel (only kill tmux)' }),
      async (argv: any) =>
        stopCommand(argv.project, {
          keepChannel: argv.keepChannel,
          instance: argv.instance,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'daemon <action>',
      'Manage the global bridge daemon (start|restart|stop|status)',
      (y: Argv) => y.positional('action', {
        type: 'string',
        demandOption: true,
        choices: ['start', 'restart', 'stop', 'status'],
      }),
      async (argv: any) => daemonCommand(argv.action)
    )
    .command(
      'uninstall',
      'Uninstall discode from this machine',
      (y: Argv) => y
        .option('purge', { type: 'boolean', default: false, describe: 'Also remove ~/.discode and installed bridge plugins' })
        .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'Skip confirmation prompt' })
        .option('skip-package-uninstall', {
          type: 'boolean',
          default: false,
          describe: 'Do not run npm/bun global uninstall commands',
        }),
      async (argv: any) =>
        uninstallCommand({
          purge: argv.purge,
          yes: argv.yes,
          skipPackageUninstall: argv.skipPackageUninstall,
        })
    )
    .parseAsync();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(chalk.red('Fatal CLI error:'), error);
    process.exit(1);
  });
}
