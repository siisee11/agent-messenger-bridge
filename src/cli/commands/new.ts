import { basename, resolve } from 'path';
import chalk from 'chalk';
import { AgentBridge } from '../../index.js';
import { stateManager, type ProjectState } from '../../state/index.js';
import { validateConfig, config } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { agentRegistry } from '../../agents/index.js';
import { defaultDaemonManager } from '../../daemon.js';
import { installOpencodePlugin } from '../../opencode/plugin-installer.js';
import { installClaudePlugin } from '../../claude/plugin-installer.js';
import { installGeminiHook } from '../../gemini/hook-installer.js';
import { installCodexHook } from '../../codex/plugin-installer.js';
import {
  buildNextInstanceId,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  attachToTmux,
  buildExportPrefix,
  cleanupStaleDiscodeTuiProcesses,
  ensureProjectTuiPane,
  ensureTmuxInstalled,
  escapeShellArg,
  pruneStaleProjects,
  resolveProjectWindowName,
  toSharedWindowName,
} from '../common/tmux.js';
import { isInteractiveShell, prompt } from '../common/interactive.js';
import { ensureOpencodePermissionChoice } from '../common/opencode-permission.js';

export async function newCommand(
  agentArg: string | undefined,
  options: TmuxCliOptions & { name?: string; attach?: boolean; instance?: string }
) {
  try {
    ensureTmuxInstalled();
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);

    if (!stateManager.getGuildId()) {
      console.error(chalk.red('Not set up yet. Run: discode onboard'));
      process.exit(1);
    }

    const projectPath = process.cwd();
    const projectName = options.name || basename(projectPath);
    const port = defaultDaemonManager.getPort();

    const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
    if (staleTuiCount > 0) {
      console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
    }

    console.log(chalk.cyan(`\n🚀 discode new — ${projectName}\n`));

    const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);
    const prunedProjects = pruneStaleProjects(tmux, effectiveConfig.tmux);
    if (prunedProjects.length > 0) {
      console.log(chalk.yellow(`⚠️ Pruned stale project state: ${prunedProjects.join(', ')}`));
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
        console.error(chalk.red('No agent CLIs found. Install one first (claude, codex, gemini, opencode).'));
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

    const running = await defaultDaemonManager.isRunning();
    if (!running) {
      console.log(chalk.gray('   Starting bridge daemon...'));
      const entryPoint = resolve(import.meta.dirname, '../../daemon-entry.js');
      defaultDaemonManager.startDaemon(entryPoint);
      const ready = await defaultDaemonManager.waitForReady();
      if (ready) {
        console.log(chalk.green(`✅ Bridge daemon started (port ${port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready yet. Check logs: ${defaultDaemonManager.getLogFile()}`));
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

      const bridge = new AgentBridge({ config: effectiveConfig });
      await bridge.connect();
      const agents = { [agentName]: true };
      const result = await bridge.setupProject(
        projectName,
        existingProject?.projectPath || projectPath,
        agents,
        undefined,
        port,
        { instanceId: instanceIdToCreate },
      );
      await bridge.stop();

      if (!existingProject) {
        console.log(chalk.green('✅ Project created'));
      } else {
        console.log(chalk.green('✅ Agent instance added to existing project'));
      }
      console.log(chalk.cyan(`   Channel: #${result.channelName}`));

      try {
        const http = await import('http');
        await new Promise<void>((resolveDone) => {
          const req = http.request(`http://127.0.0.1:${port}/reload`, { method: 'POST' }, () => resolveDone());
          req.on('error', () => resolveDone());
          req.setTimeout(2000, () => {
            req.destroy();
            resolveDone();
          });
          req.end();
        });
      } catch {
        // daemon will pick up on next restart
      }
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

      const fullSessionName = existingProject!.tmuxSession;
      const prefix = effectiveConfig.tmux.sessionPrefix;
      if (fullSessionName.startsWith(prefix)) {
        tmux.getOrCreateSession(fullSessionName.slice(prefix.length));
      }
      const sharedFull = `${prefix}${effectiveConfig.tmux.sharedSessionName || 'bridge'}`;
      const isSharedSession = fullSessionName === sharedFull;
      if (!isSharedSession) {
        tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PROJECT', projectName);
      }
      tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PORT', String(port));

      const resumeWindowName = resolveProjectWindowName(existingProject!, resumeInstance.agentType, effectiveConfig.tmux, resumeInstance.instanceId);
      if (!tmux.windowExists(fullSessionName, resumeWindowName)) {
        const adapter = agentRegistry.get(resumeInstance.agentType);
        if (adapter) {
          let claudePluginDir: string | undefined;
          let hookEnabled = !!resumeInstance.eventHook;

          if (resumeInstance.agentType === 'opencode') {
            try {
              const pluginPath = installOpencodePlugin(existingProject!.projectPath);
              hookEnabled = true;
              console.log(chalk.gray(`   Reinstalled OpenCode plugin: ${pluginPath}`));
            } catch (error) {
              console.log(chalk.yellow(`⚠️ Could not reinstall OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`));
            }
          }

          if (resumeInstance.agentType === 'claude') {
            try {
              claudePluginDir = installClaudePlugin(existingProject!.projectPath);
              hookEnabled = true;
              console.log(chalk.gray(`   Reinstalled Claude Code plugin: ${claudePluginDir}`));
            } catch (error) {
              console.log(chalk.yellow(`⚠️ Could not reinstall Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`));
            }
          }

          if (resumeInstance.agentType === 'gemini') {
            try {
              const hookPath = installGeminiHook(existingProject!.projectPath);
              hookEnabled = true;
              console.log(chalk.gray(`   Reinstalled Gemini CLI hook: ${hookPath}`));
            } catch (error) {
              console.log(chalk.yellow(`⚠️ Could not reinstall Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`));
            }
          }

          if (resumeInstance.agentType === 'codex') {
            try {
              const hookPath = installCodexHook();
              hookEnabled = true;
              console.log(chalk.gray(`   Reinstalled Codex notify hook: ${hookPath}`));
            } catch (error) {
              console.log(chalk.yellow(`⚠️ Could not reinstall Codex notify hook: ${error instanceof Error ? error.message : String(error)}`));
            }
          }

          const permissionAllow =
            resumeInstance.agentType === 'opencode' && effectiveConfig.opencode?.permissionMode === 'allow';
          let baseCommand = adapter.getStartCommand(existingProject!.projectPath, permissionAllow);

          if (claudePluginDir && !(/--plugin-dir\b/.test(baseCommand))) {
            const pluginPattern = /((?:^|&&|;)\s*)claude\b/;
            if (pluginPattern.test(baseCommand)) {
              baseCommand = baseCommand.replace(pluginPattern, `$1claude --plugin-dir ${escapeShellArg(claudePluginDir)}`);
            }
          }

          const startCommand =
            buildExportPrefix({
              AGENT_DISCORD_PROJECT: projectName,
              AGENT_DISCORD_PORT: String(port),
              AGENT_DISCORD_AGENT: resumeInstance.agentType,
              AGENT_DISCORD_INSTANCE: resumeInstance.instanceId,
              ...(permissionAllow ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {}),
            }) + baseCommand;

          tmux.startAgentInWindow(fullSessionName, resumeWindowName, startCommand);
          console.log(chalk.gray(`   Restored missing tmux window: ${resumeWindowName}`));

          if (hookEnabled && !resumeInstance.eventHook) {
            const normalizedProject = normalizeProjectState(existingProject!);
            const updatedProject: ProjectState = {
              ...normalizedProject,
              instances: {
                ...(normalizedProject.instances || {}),
                [resumeInstance.instanceId]: {
                  ...resumeInstance,
                  eventHook: true,
                },
              },
            };
            stateManager.setProject(updatedProject);
          }
        }
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
    if (isInteractive) {
      try {
        ensureProjectTuiPane(tmux, sessionName, statusWindowName, options);
      } catch (error) {
        console.log(chalk.yellow(`⚠️ Could not start discode TUI pane: ${error instanceof Error ? error.message : String(error)}`));
      }
    } else {
      console.log(chalk.gray('   Non-interactive shell detected; skipping automatic discode TUI pane startup.'));
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
      console.log(chalk.cyan(`\n📺 Attaching to ${attachTarget}...\n`));
      attachToTmux(sessionName, windowName);
      return;
    }

    console.log(chalk.gray(`\n   To attach later: discode attach ${projectName}\n`));
  } catch (error) {
    console.error(chalk.red('Error:'), error);
    process.exit(1);
  }
}
