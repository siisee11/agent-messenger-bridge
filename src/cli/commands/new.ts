import { basename } from 'path';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { validateConfig, config } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { agentRegistry } from '../../agents/index.js';
import {
  buildNextInstanceId,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
} from '../../state/instances.js';
import { ensureDaemonRunning } from '../../app/daemon-service.js';
import { resumeProjectInstance, setupProjectInstance } from '../../app/project-service.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  attachToTmux,
  cleanupStaleDiscodeTuiProcesses,
  ensureProjectTuiPane,
  ensureTmuxInstalled,
  pruneStaleProjects,
  resolveProjectWindowName,
  toSharedWindowName,
} from '../common/tmux.js';
import { isInteractiveShell, prompt } from '../common/interactive.js';
import { ensureOpencodePermissionChoice } from '../common/opencode-permission.js';

export async function newCommand(
  agentArg: string | undefined,
  options: TmuxCliOptions & { name?: string; attach?: boolean; instance?: string; container?: boolean }
) {
  try {
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);
    if (options.container) {
      effectiveConfig.container = { enabled: true, ...effectiveConfig.container };
    }
    const runtimeMode = effectiveConfig.runtimeMode || 'tmux';
    if (runtimeMode === 'tmux') {
      ensureTmuxInstalled();
    }

    const isSlack = effectiveConfig.messagingPlatform === 'slack';
    if (!(isSlack ? stateManager.getWorkspaceId() : stateManager.getGuildId())) {
      console.error(chalk.red('Not set up yet. Run: discode onboard'));
      process.exit(1);
    }

    const projectPath = process.cwd();
    const projectName = options.name || basename(projectPath);
    let port = effectiveConfig.hookServerPort || 18470;

    const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
    if (staleTuiCount > 0) {
      console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
    }

    console.log(chalk.cyan(`\n🚀 discode new — ${projectName}\n`));

    const tmux = runtimeMode === 'tmux' ? new TmuxManager(effectiveConfig.tmux.sessionPrefix) : undefined;
    if (tmux) {
      const prunedProjects = pruneStaleProjects(tmux, effectiveConfig.tmux);
      if (prunedProjects.length > 0) {
        console.log(chalk.yellow(`⚠️ Pruned stale project state: ${prunedProjects.join(', ')}`));
      }
    }

    let agentName: string;
    let activeInstanceId: string | undefined;
    let existingProject = stateManager.getProject(projectName);
    const requestedInstanceId = options.instance?.trim();

    if (agentArg) {
      const adapter = agentRegistry.get(agentArg.toLowerCase());
      if (!adapter) {
        console.error(chalk.red(`Unknown agent: ${agentArg}`));
        process.exit(1);
      }
      agentName = adapter.config.name;
      if (existingProject && requestedInstanceId) {
        const requested = getProjectInstance(existingProject, requestedInstanceId);
        if (requested && requested.agentType !== agentName) {
          console.error(chalk.red(`Instance '${requestedInstanceId}' belongs to '${requested.agentType}', not '${agentName}'.`));
          process.exit(1);
        }
      }
    } else if (existingProject) {
      const requested = requestedInstanceId ? getProjectInstance(existingProject, requestedInstanceId) : undefined;
      if (requested) {
        agentName = requested.agentType;
        activeInstanceId = requested.instanceId;
        console.log(chalk.gray(`   Reusing existing instance: ${requested.instanceId} (${requested.agentType})`));
      } else {
        const existing = listProjectInstances(existingProject)[0];
        if (!existing) {
          console.error(chalk.red('Existing project has no agent configured'));
          process.exit(1);
        }
        agentName = existing.agentType;
        activeInstanceId = existing.instanceId;
        console.log(chalk.gray(`   Reusing existing instance: ${existing.instanceId} (${existing.agentType})`));
      }
    } else {
      const installed = agentRegistry.getAll().filter((a) => a.isInstalled());
      if (installed.length === 0) {
        console.error(chalk.red('No agent CLIs found. Install one first (claude, gemini, opencode).'));
        process.exit(1);
      } else if (installed.length === 1) {
        agentName = installed[0].config.name;
        console.log(chalk.gray(`   Auto-selected agent: ${installed[0].config.displayName}`));
      } else {
        const defaultInstalled = effectiveConfig.defaultAgentCli
          ? installed.find((agent) => agent.config.name === effectiveConfig.defaultAgentCli)
          : undefined;
        if (defaultInstalled) {
          agentName = defaultInstalled.config.name;
          console.log(chalk.gray(`   Using default AI CLI: ${defaultInstalled.config.displayName}`));
        } else {
          if (effectiveConfig.defaultAgentCli) {
            console.log(chalk.yellow(`⚠️ Configured default AI CLI '${effectiveConfig.defaultAgentCli}' is not installed.`));
          }
          if (!isInteractiveShell()) {
            agentName = installed[0].config.name;
            console.log(chalk.yellow(`⚠️ Non-interactive shell: defaulting to ${installed[0].config.displayName}.`));
          } else {
            console.log(chalk.white('   Multiple agents installed:\n'));
            installed.forEach((a, i) => {
              console.log(chalk.gray(`   ${i + 1}. ${a.config.displayName} (${a.config.command})`));
            });
            const answer = await prompt(chalk.white(`\n   Select agent [1-${installed.length}]: `));
            const idx = parseInt(answer, 10) - 1;
            if (idx < 0 || idx >= installed.length) {
              console.error(chalk.red('Invalid selection'));
              process.exit(1);
            }
            agentName = installed[idx].config.name;
          }
        }
      }
    }

    await ensureOpencodePermissionChoice({ shouldPrompt: agentName === 'opencode' });

    const daemon = await ensureDaemonRunning();
    port = daemon.port;
    if (!daemon.alreadyRunning) {
      console.log(chalk.gray('   Starting bridge daemon...'));
      if (daemon.ready) {
        console.log(chalk.green(`✅ Bridge daemon started (port ${port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready yet. Check logs: ${daemon.logFile}`));
      }
    } else {
      console.log(chalk.green(`✅ Bridge daemon already running (port ${port})`));
    }

    const existingRequestedInstance = existingProject && requestedInstanceId
      ? getProjectInstance(existingProject, requestedInstanceId)
      : undefined;
    const shouldCreateNewInstance =
      !existingProject ||
      (!!requestedInstanceId && !existingRequestedInstance) ||
      (!!existingProject && !!agentArg && !existingRequestedInstance);

    if (shouldCreateNewInstance) {
      const instanceIdToCreate = requestedInstanceId || buildNextInstanceId(existingProject, agentName);
      activeInstanceId = instanceIdToCreate;
      const modeLabel = existingProject
        ? `Adding instance '${instanceIdToCreate}' (${agentName}) to existing project...`
        : 'Setting up new project...';
      console.log(chalk.gray(`   ${modeLabel}`));

      const result = await setupProjectInstance({
        config: effectiveConfig,
        projectName,
        projectPath,
        agentName,
        instanceId: instanceIdToCreate,
        port,
      });

      if (result.createdNewProject) {
        console.log(chalk.green('✅ Project created'));
      } else {
        console.log(chalk.green('✅ Agent instance added to existing project'));
      }
      console.log(chalk.cyan(`   Channel: #${result.channelName}`));
    } else {
      const resumeInstance =
        existingRequestedInstance ||
        (activeInstanceId ? getProjectInstance(existingProject!, activeInstanceId) : undefined) ||
        getPrimaryInstanceForAgent(existingProject!, agentName);
      if (!resumeInstance) {
        console.error(chalk.red(`No instance found to resume for agent '${agentName}'.`));
        process.exit(1);
      }
      activeInstanceId = resumeInstance.instanceId;

      const resumeResult = await resumeProjectInstance({
        config: effectiveConfig,
        projectName,
        project: existingProject!,
        instance: resumeInstance,
        port,
      });

      for (const message of resumeResult.infoMessages) {
        console.log(chalk.gray(`   ${message}`));
      }
      for (const message of resumeResult.warningMessages) {
        console.log(chalk.yellow(`⚠️ ${message}`));
      }
      console.log(chalk.green('✅ Existing project resumed'));
    }

    const projectState = stateManager.getProject(projectName);
    const sessionName = projectState?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
    const summaryInstance = projectState && activeInstanceId ? getProjectInstance(projectState, activeInstanceId) : undefined;
    if (summaryInstance) {
      agentName = summaryInstance.agentType;
    }
    const statusWindowName = projectState
      ? resolveProjectWindowName(projectState, agentName, effectiveConfig.tmux, activeInstanceId)
      : toSharedWindowName(projectName, activeInstanceId || agentName);
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    if (isInteractive && tmux) {
      try {
        ensureProjectTuiPane(tmux, sessionName, statusWindowName, options);
      } catch (error) {
        console.log(chalk.yellow(`⚠️ Could not start discode TUI pane: ${error instanceof Error ? error.message : String(error)}`));
      }
    } else if (!isInteractive) {
      console.log(chalk.gray('   Non-interactive shell detected; skipping automatic discode TUI pane startup.'));
    } else {
      console.log(chalk.gray('   Runtime mode is pty; skipping tmux pane startup.'));
    }
    console.log(chalk.cyan('\n✨ Ready!\n'));
    console.log(chalk.gray(`   Project:  ${projectName}`));
    console.log(chalk.gray(`   Session:  ${sessionName}`));
    console.log(chalk.gray(`   Agent:    ${agentName}`));
    console.log(chalk.gray(`   Instance: ${activeInstanceId || '(auto)'}`));
    console.log(chalk.gray(`   Port:     ${port}`));

    if (options.attach !== false) {
      const windowName = statusWindowName;
      const attachTarget = `${sessionName}:${windowName}`;
      if (runtimeMode === 'tmux') {
        console.log(chalk.cyan(`\n📺 Attaching to ${attachTarget}...\n`));
        attachToTmux(sessionName, windowName);
        return;
      }

      console.log(chalk.cyan(`\n🧭 Runtime window ready: ${attachTarget}`));
      console.log(chalk.cyan('📺 Opening discode TUI...\n'));
      const { attachCommand } = await import('./attach.js');
      await attachCommand(projectName, {
        instance: activeInstanceId,
        tmuxSharedSessionName: options.tmuxSharedSessionName,
      });
      return;
    }

    console.log(chalk.gray(`\n   To attach later: discode attach ${projectName}\n`));
  } catch (error) {
    console.error(chalk.red('Error:'), error);
    process.exit(1);
  }
}
