import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances } from '../../state/instances.js';
import { agentRegistry } from '../../agents/index.js';
import { resolveProjectWindowName } from '../common/tmux.js';
import { listRuntimeWindows } from '../common/runtime-api.js';

export async function listCommand(options?: { prune?: boolean }) {
  const projects = stateManager.listProjects();
  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const runtimeMode = config.runtimeMode || 'tmux';
  const runtimeWindows = runtimeMode === 'pty' ? await listRuntimeWindows(config.hookServerPort || 18470) : null;
  const runtimeSet = new Set((runtimeWindows?.windows || []).map((window) => `${window.sessionName}:${window.windowName}`));
  const prune = !!options?.prune;

  if (projects.length === 0) {
    console.log(chalk.gray('No projects configured.'));
    return;
  }

  const pruned: string[] = [];
  console.log(chalk.cyan('\n📂 Configured Projects:\n'));
  for (const project of projects) {
    const instances = listProjectInstances(project);
    const labels = instances.map((instance) => {
      const agentLabel = agentRegistry.get(instance.agentType)?.config.displayName || instance.agentType;
      return `${agentLabel}#${instance.instanceId}`;
    });
    const windows = instances.map((instance) => ({
      instanceId: instance.instanceId,
      agentName: instance.agentType,
      windowName: resolveProjectWindowName(project, instance.agentType, config.tmux, instance.instanceId),
    }));
    const runningWindows = runtimeWindows
      ? windows.filter((window) => runtimeSet.has(`${project.tmuxSession}:${window.windowName}`))
      : (tmux.sessionExistsFull(project.tmuxSession)
        ? windows.filter((window) => tmux.windowExists(project.tmuxSession, window.windowName))
        : []);
    const sessionUp = runtimeWindows ? runningWindows.length > 0 : tmux.sessionExistsFull(project.tmuxSession);
    const status = runningWindows.length > 0 ? 'running' : sessionUp ? 'session only' : 'stale';

    if (prune && status !== 'running') {
      stateManager.removeProject(project.projectName);
      pruned.push(project.projectName);
      continue;
    }

    console.log(chalk.white(`  • ${project.projectName}`));
    console.log(chalk.gray(`    Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
    console.log(chalk.gray(`    Path: ${project.projectPath}`));
    console.log(chalk.gray(`    Status: ${status}`));
    if (windows.length > 0) {
      for (const window of windows) {
        console.log(chalk.gray(`    ${runtimeMode}(${window.instanceId}): ${project.tmuxSession}:${window.windowName}`));
      }
    }
  }

  if (prune) {
    if (pruned.length > 0) {
      console.log(chalk.green(`\n✅ Pruned ${pruned.length} project(s): ${pruned.join(', ')}`));
    } else {
      console.log(chalk.gray('\nNo stale projects to prune.'));
    }
  }
  console.log('');
}
