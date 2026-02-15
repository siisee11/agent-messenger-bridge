import { basename } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config, validateConfig } from '../../config/index.js';
import { DiscordClient } from '../../discord/client.js';
import { listProjectInstances, getProjectInstance, normalizeProjectState } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  cleanupStaleDiscodeTuiProcesses,
  escapeShellArg,
  resolveProjectWindowName,
  terminateTmuxPaneProcesses,
} from '../common/tmux.js';

export async function stopCommand(
  projectName: string | undefined,
  options: TmuxCliOptions & { keepChannel?: boolean; instance?: string }
) {
  if (!projectName) {
    projectName = basename(process.cwd());
  }

  console.log(chalk.cyan(`\n🛑 Stopping project: ${projectName}\n`));

  const project = stateManager.getProject(projectName);
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const requestedInstanceId = options.instance?.trim();

  if (project && requestedInstanceId) {
    const instance = getProjectInstance(project, requestedInstanceId);
    if (!instance) {
      const known = listProjectInstances(project).map((item) => item.instanceId).join(', ');
      console.error(chalk.red(`Instance '${requestedInstanceId}' not found in project '${projectName}'.`));
      if (known) {
        console.log(chalk.gray(`Available instances: ${known}`));
      }
      process.exit(1);
    }

    const prefix = effectiveConfig.tmux.sessionPrefix;
    const sharedSession = `${prefix}${effectiveConfig.tmux.sharedSessionName || 'bridge'}`;
    const sessionName = project.tmuxSession;
    const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
    const target = `${sessionName}:${windowName}`;

    if (sessionName === sharedSession) {
      const forcedKillCount = await terminateTmuxPaneProcesses(target);
      if (forcedKillCount > 0) {
        console.log(chalk.yellow(`⚠️ Forced SIGKILL on ${forcedKillCount} pane process(es) in ${target}.`));
      }
      try {
        execSync(`tmux kill-window -t ${escapeShellArg(target)}`, { stdio: 'ignore' });
        console.log(chalk.green(`✅ tmux window killed: ${target}`));
      } catch {
        console.log(chalk.gray(`   tmux window ${target} not running`));
      }
    } else {
      const forcedKillCount = await terminateTmuxPaneProcesses(sessionName);
      if (forcedKillCount > 0) {
        console.log(chalk.yellow(`⚠️ Forced SIGKILL on ${forcedKillCount} pane process(es) in session ${sessionName}.`));
      }
      try {
        execSync(`tmux kill-session -t ${escapeShellArg(sessionName)}`, { stdio: 'ignore' });
        console.log(chalk.green(`✅ tmux session killed: ${sessionName}`));
      } catch {
        console.log(chalk.gray(`   tmux session ${sessionName} not running`));
      }
    }

    if (!options.keepChannel && instance.discordChannelId) {
      try {
        validateConfig();
        const client = new DiscordClient(config.discord.token);
        await client.connect();
        const deleted = await client.deleteChannel(instance.discordChannelId);
        if (deleted) {
          console.log(chalk.green(`✅ Discord channel deleted: ${instance.discordChannelId}`));
        }
        await client.disconnect();
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    const normalized = normalizeProjectState(project);
    const nextInstances = { ...(normalized.instances || {}) };
    delete nextInstances[instance.instanceId];

    if (Object.keys(nextInstances).length === 0) {
      stateManager.removeProject(projectName);
      console.log(chalk.green('✅ Project removed from state (last instance stopped)'));
    } else {
      stateManager.setProject({
        ...normalized,
        instances: nextInstances,
        lastActive: new Date(),
      });
      console.log(chalk.green(`✅ Instance removed from state: ${instance.instanceId}`));
    }

    const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
    if (staleTuiCount > 0) {
      console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
    }

    console.log(chalk.cyan('\n✨ Done\n'));
    return;
  }

  const prefix = effectiveConfig.tmux.sessionPrefix;
  const sharedSession = `${prefix}${effectiveConfig.tmux.sharedSessionName || 'bridge'}`;
  const legacySession = `${prefix}${projectName}`;
  const sessionName = project?.tmuxSession || legacySession;
  const killWindows = !!project && sessionName === sharedSession;

  if (!killWindows) {
    const forcedKillCount = await terminateTmuxPaneProcesses(sessionName);
    if (forcedKillCount > 0) {
      console.log(chalk.yellow(`⚠️ Forced SIGKILL on ${forcedKillCount} pane process(es) in session ${sessionName}.`));
    }
    try {
      execSync(`tmux kill-session -t ${escapeShellArg(sessionName)}`, { stdio: 'ignore' });
      console.log(chalk.green(`✅ tmux session killed: ${sessionName}`));
    } catch {
      console.log(chalk.gray(`   tmux session ${sessionName} not running`));
    }
  } else {
    const instances = listProjectInstances(project);
    if (instances.length === 0) {
      console.log(chalk.gray('   No active instances in state; not killing tmux windows'));
    } else {
      for (const instance of instances) {
        const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
        const target = `${sessionName}:${windowName}`;
        const forcedKillCount = await terminateTmuxPaneProcesses(target);
        if (forcedKillCount > 0) {
          console.log(chalk.yellow(`⚠️ Forced SIGKILL on ${forcedKillCount} pane process(es) in ${target}.`));
        }
        try {
          execSync(`tmux kill-window -t ${escapeShellArg(target)}`, { stdio: 'ignore' });
          console.log(chalk.green(`✅ tmux window killed: ${target}`));
        } catch {
          console.log(chalk.gray(`   tmux window ${target} not running`));
        }
      }
    }
  }

  if (project && !options.keepChannel) {
    const channelIds = listProjectInstances(project)
      .map((instance) => instance.discordChannelId)
      .filter((channelId): channelId is string => !!channelId);
    if (channelIds.length > 0) {
      try {
        validateConfig();
        const client = new DiscordClient(config.discord.token);
        await client.connect();

        for (const channelId of channelIds) {
          const deleted = await client.deleteChannel(channelId);
          if (deleted) {
            console.log(chalk.green(`✅ Discord channel deleted: ${channelId}`));
          }
        }

        await client.disconnect();
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  if (project) {
    stateManager.removeProject(projectName);
    console.log(chalk.green('✅ Project removed from state'));
  }

  const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
  if (staleTuiCount > 0) {
    console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
  }

  console.log(chalk.cyan('\n✨ Done\n'));
}
