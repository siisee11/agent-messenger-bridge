import { basename } from 'path';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances, getProjectInstance } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  attachToTmux,
  ensureTmuxInstalled,
  resolveProjectWindowName,
} from '../common/tmux.js';
import { ensureRuntimeWindow, focusRuntimeWindow } from '../common/runtime-api.js';

export async function attachCommand(projectName: string | undefined, options: TmuxCliOptions & { instance?: string }) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const runtimeMode = effectiveConfig.runtimeMode || 'tmux';
  if (runtimeMode === 'tmux') {
    ensureTmuxInstalled();
  }
  const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);

  if (!projectName) {
    projectName = basename(process.cwd());
  }

  const project = stateManager.getProject(projectName);
  const sessionName = project?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
  const requestedInstanceId = options.instance?.trim();
  const instances = project ? listProjectInstances(project) : [];
  const firstInstance = project
    ? (
      (requestedInstanceId ? getProjectInstance(project, requestedInstanceId) : undefined) ||
      instances[0]
    )
    : undefined;
  if (project && requestedInstanceId && !firstInstance) {
    console.error(chalk.red(`Instance '${requestedInstanceId}' not found in project '${projectName}'.`));
    const hints = instances.map((instance) => instance.instanceId).join(', ');
    if (hints) {
      console.log(chalk.gray(`Available instances: ${hints}`));
    }
    process.exit(1);
  }
  if (project && !requestedInstanceId && instances.length > 1) {
    console.log(chalk.yellow(`⚠️ Multiple instances found. Attaching first instance '${firstInstance?.instanceId}'.`));
    console.log(chalk.gray('   Use --instance <id> to select a specific instance.'));
  }
  const windowName =
    project && firstInstance
      ? resolveProjectWindowName(project, firstInstance.agentType, effectiveConfig.tmux, firstInstance.instanceId)
      : undefined;
  const attachTarget = windowName ? `${sessionName}:${windowName}` : sessionName;

  if (runtimeMode === 'pty') {
    if (windowName) {
      const windowId = `${sessionName}:${windowName}`;
      const port = effectiveConfig.hookServerPort || 18470;
      let focused = await focusRuntimeWindow(port, windowId);
      if (!focused) {
        await ensureRuntimeWindow({
          port,
          projectName,
          instanceId: requestedInstanceId,
          permissionAllow: effectiveConfig.opencode?.permissionMode === 'allow',
        });
        focused = await focusRuntimeWindow(port, windowId);
      }
      if (!focused) {
        console.log(chalk.yellow('⚠️ Could not focus runtime window.'));
      }
    }

    const { tuiCommand } = await import('./tui.js');
    await tuiCommand(options);
    return;
  }

  if (!tmux.sessionExistsFull(sessionName)) {
    console.error(chalk.red(`Session ${sessionName} not found`));
    console.log(chalk.gray('Available sessions:'));
    const sessions = tmux.listSessions();
    for (const s of sessions) {
      console.log(chalk.gray(`  - ${s.name}`));
    }
    process.exit(1);
  }

  console.log(chalk.cyan(`\n📺 Attaching to ${attachTarget}...\n`));
  attachToTmux(sessionName, windowName);
}
