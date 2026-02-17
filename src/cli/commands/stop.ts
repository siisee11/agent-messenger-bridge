import { basename } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { listProjectInstances, getProjectInstance } from '../../state/instances.js';
import { deleteChannels } from '../../app/channel-service.js';
import { removeInstanceFromProjectState, removeProjectState } from '../../app/project-service.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  cleanupStaleDiscodeTuiProcesses,
  escapeShellArg,
  resolveProjectWindowName,
  terminateTmuxPaneProcesses,
} from '../common/tmux.js';
import { stopRuntimeWindow } from '../common/runtime-api.js';

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
  const runtimeMode = effectiveConfig.runtimeMode || 'tmux';
  const requestedInstanceId = options.instance?.trim();
  const runtimePort = effectiveConfig.hookServerPort || 18470;

  if (runtimeMode === 'pty') {
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

      const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
      const target = `${project.tmuxSession}:${windowName}`;
      const stopped = await stopRuntimeWindow(runtimePort, target);
      if (stopped) {
        console.log(chalk.green(`✅ runtime window stopped: ${target}`));
      } else {
        console.log(chalk.gray(`   runtime window ${target} not running`));
      }

      if (!options.keepChannel && instance.channelId) {
        try {
          const deleted = await deleteChannels([instance.channelId]);
          if (deleted.length > 0) {
            console.log(chalk.green(`✅ Discord channel deleted: ${deleted[0]}`));
          }
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
        }
      }

      const stateUpdate = removeInstanceFromProjectState(projectName, instance.instanceId);
      if (stateUpdate.removedProject) {
        console.log(chalk.green('✅ Project removed from state (last instance stopped)'));
      } else {
        console.log(chalk.green(`✅ Instance removed from state: ${instance.instanceId}`));
      }

      const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
      if (staleTuiCount > 0) {
        console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
      }

      console.log(chalk.cyan('\n✨ Done\n'));
      return;
    }

    if (project) {
      const instances = listProjectInstances(project);
      for (const instance of instances) {
        const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
        const target = `${project.tmuxSession}:${windowName}`;
        const stopped = await stopRuntimeWindow(runtimePort, target);
        if (stopped) {
          console.log(chalk.green(`✅ runtime window stopped: ${target}`));
        } else {
          console.log(chalk.gray(`   runtime window ${target} not running`));
        }
      }

      if (!options.keepChannel) {
        const channelIds = instances
          .map((instance) => instance.channelId)
          .filter((channelId): channelId is string => !!channelId);
        if (channelIds.length > 0) {
          try {
            const deleted = await deleteChannels(channelIds);
            for (const channelId of deleted) {
              console.log(chalk.green(`✅ Discord channel deleted: ${channelId}`));
            }
          } catch (error) {
            console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
      }

      removeProjectState(projectName);
      console.log(chalk.green('✅ Project removed from state'));
    }

    const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
    if (staleTuiCount > 0) {
      console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
    }

    console.log(chalk.cyan('\n✨ Done\n'));
    return;
  }

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

    if (!options.keepChannel && instance.channelId) {
      try {
        const deleted = await deleteChannels([instance.channelId]);
        if (deleted.length > 0) {
          console.log(chalk.green(`✅ Discord channel deleted: ${deleted[0]}`));
        }
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    const stateUpdate = removeInstanceFromProjectState(projectName, instance.instanceId);
    if (stateUpdate.removedProject) {
      console.log(chalk.green('✅ Project removed from state (last instance stopped)'));
    } else {
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
      .map((instance) => instance.channelId)
      .filter((channelId): channelId is string => !!channelId);
    if (channelIds.length > 0) {
      try {
        const deleted = await deleteChannels(channelIds);
        for (const channelId of deleted) {
          console.log(chalk.green(`✅ Discord channel deleted: ${channelId}`));
        }
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  if (project) {
    removeProjectState(projectName);
    console.log(chalk.green('✅ Project removed from state'));
  }

  const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
  if (staleTuiCount > 0) {
    console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
  }

  console.log(chalk.cyan('\n✨ Done\n'));
}
