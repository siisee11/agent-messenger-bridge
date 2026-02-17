import { basename } from 'path';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { config, getConfigValue, saveConfig, validateConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { agentRegistry } from '../../agents/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  escapeShellArg,
  getEnabledAgentNames,
  resolveProjectWindowName,
} from '../common/tmux.js';
import { attachCommand } from './attach.js';
import { newCommand } from './new.js';
import { stopCommand } from './stop.js';

function isTmuxPaneAlive(paneTarget?: string): boolean {
  if (!paneTarget || paneTarget.trim().length === 0) return false;
  try {
    execSync(`tmux display-message -p -t ${escapeShellArg(paneTarget)} "#{pane_id}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForTmuxPaneAlive(paneTarget: string, timeoutMs: number = 1200, intervalMs: number = 100): Promise<boolean> {
  if (!paneTarget || paneTarget.trim().length === 0) return false;
  if (isTmuxPaneAlive(paneTarget)) return true;

  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (isTmuxPaneAlive(paneTarget)) return true;
  }
  return false;
}

function nextProjectName(baseName: string): string {
  if (!stateManager.getProject(baseName)) return baseName;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!stateManager.getProject(candidate)) return candidate;
  }
  return `${baseName}-${Date.now()}`;
}

function parseNewCommand(raw: string): {
  projectName?: string;
  agentName?: string;
  attach: boolean;
  instanceId?: string;
} {
  const parts = raw.split(/\s+/).filter(Boolean);
  let attach = false;
  let instanceId: string | undefined;
  const values: string[] = [];

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '--attach') {
      attach = true;
      continue;
    }
    if (part === '--instance' && parts[i + 1]) {
      instanceId = parts[i + 1];
      i += 1;
      continue;
    }
    if (part.startsWith('--instance=')) {
      const value = part.slice('--instance='.length).trim();
      if (value) instanceId = value;
      continue;
    }
    if (part.startsWith('--')) continue;
    values.push(part);
  }

  const projectName = values[0];
  const agentName = values[1];
  return { projectName, agentName, attach, instanceId };
}

export async function tuiCommand(options: TmuxCliOptions): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  let keepChannelOnStop = getConfigValue('keepChannelOnStop') === true;

  const handler = async (command: string, append: (line: string) => void): Promise<boolean> => {
    if (command === '/exit' || command === '/quit') {
      append('Bye!');
      return true;
    }

    if (command === '/help') {
      append('Commands: /new [name] [agent] [--instance id] [--attach], /list, /projects, /config [keepChannel [on|off|toggle] | defaultAgent [agent|auto]], /help, /exit');
      return false;
    }

    if (command === '/config' || command === 'config') {
      append(`keepChannel: ${keepChannelOnStop ? 'on' : 'off'}`);
      append(`defaultAgent: ${config.defaultAgentCli || '(auto)'}`);
      append('Usage: /config keepChannel [on|off|toggle]');
      append('Usage: /config defaultAgent [agent|auto]');
      return false;
    }

    if (command.startsWith('/config ') || command.startsWith('config ')) {
      const parts = command.trim().split(/\s+/).filter(Boolean);
      const key = (parts[1] || '').toLowerCase();
      if (key === 'defaultagent' || key === 'default-agent') {
        const availableAgents = agentRegistry.getAll().map((agent) => agent.config.name).sort((a, b) => a.localeCompare(b));
        const value = (parts[2] || '').trim().toLowerCase();

        if (!value) {
          append(`defaultAgent: ${config.defaultAgentCli || '(auto)'}`);
          append(`Available: ${availableAgents.join(', ')}`);
          append('Use: /config defaultAgent [agent|auto]');
          return false;
        }

        if (value === 'auto' || value === 'clear' || value === 'unset') {
          try {
            saveConfig({ defaultAgentCli: undefined });
            append('✅ defaultAgent is now auto (first installed agent).');
          } catch (error) {
            append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
          }
          return false;
        }

        const selected = agentRegistry.get(value);
        if (!selected) {
          append(`⚠️ Unknown agent: ${value}`);
          append(`Available: ${availableAgents.join(', ')}`);
          return false;
        }

        try {
          saveConfig({ defaultAgentCli: selected.config.name });
          append(`✅ defaultAgent is now ${selected.config.name}`);
        } catch (error) {
          append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
      }

      if (key !== 'keepchannel' && key !== 'keep-channel') {
        append(`⚠️ Unknown config key: ${parts[1] || '(empty)'}`);
        append('Supported keys: keepChannel, defaultAgent');
        return false;
      }

      const modeRaw = (parts[2] || 'toggle').toLowerCase();
      if (modeRaw === 'on' || modeRaw === 'true' || modeRaw === '1') {
        keepChannelOnStop = true;
      } else if (modeRaw === 'off' || modeRaw === 'false' || modeRaw === '0') {
        keepChannelOnStop = false;
      } else if (modeRaw === 'toggle') {
        keepChannelOnStop = !keepChannelOnStop;
      } else {
        append(`⚠️ Unknown mode: ${parts[2]}`);
        append('Use on, off, or toggle');
        return false;
      }

      try {
        saveConfig({ keepChannelOnStop });
      } catch (error) {
        append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
      }

      append(`✅ keepChannel is now ${keepChannelOnStop ? 'on' : 'off'}`);
      append(
        keepChannelOnStop
          ? 'stop will preserve Discord channels.'
          : 'stop will delete Discord channels (default).',
      );
      return false;
    }

    if (command === '/list') {
      const sessions = new Set(
        stateManager
          .listProjects()
          .map((project) => project.tmuxSession)
          .filter((name) => tmux.sessionExistsFull(name)),
      );
      if (sessions.size === 0) {
        append('No running sessions.');
        return false;
      }
      [...sessions].sort((a, b) => a.localeCompare(b)).forEach((session) => {
        append(`[session] ${session}`);
      });
      return false;
    }

    if (command === '/projects') {
      const projects = stateManager.listProjects();
      if (projects.length === 0) {
        append('No projects configured.');
        return false;
      }
      projects.forEach((project) => {
        const instances = listProjectInstances(project);
        const label = instances.length > 0
          ? instances.map((instance) => `${instance.agentType}#${instance.instanceId}`).join(', ')
          : 'none';
        append(`[project] ${project.projectName} (${label})`);
      });
      return false;
    }

    if (command === 'stop' || command === '/stop') {
      append('Use stop dialog to choose a project.');
      return false;
    }

    if (command.startsWith('stop ') || command.startsWith('/stop ')) {
      const args = command.replace(/^\/?stop\s+/, '').trim().split(/\s+/).filter(Boolean);
      let projectName = '';
      let instanceId: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--instance' && args[i + 1]) {
          instanceId = args[i + 1];
          i += 1;
          continue;
        }
        if (arg.startsWith('--instance=')) {
          const value = arg.slice('--instance='.length).trim();
          if (value) instanceId = value;
          continue;
        }
        if (arg.startsWith('--')) continue;
        if (!projectName) projectName = arg;
      }
      if (!projectName) {
        append('⚠️ Project name is required. Example: stop my-project --instance gemini-2');
        return false;
      }
      await stopCommand(projectName, {
        instance: instanceId,
        keepChannel: keepChannelOnStop,
        tmuxSharedSessionName: options.tmuxSharedSessionName,
      });
      append(`✅ Stopped ${instanceId ? `instance ${instanceId}` : 'project'}: ${projectName}`);
      return false;
    }

    if (command.startsWith('/new')) {
      try {
        validateConfig();
        if (!stateManager.getGuildId()) {
          append('⚠️ Not set up yet. Run: discode onboard');
          return false;
        }

        const installed = agentRegistry.getAll().filter((agent) => agent.isInstalled());
        if (installed.length === 0) {
          append('⚠️ No agent CLIs found. Install one first (claude, codex, gemini, opencode).');
          return false;
        }

        const parsed = parseNewCommand(command);
        const cwdName = basename(process.cwd());
        const projectName = parsed.projectName && parsed.projectName.trim().length > 0
          ? parsed.projectName.trim()
          : nextProjectName(cwdName);

        const selected = parsed.agentName
          ? installed.find((agent) => agent.config.name === parsed.agentName)
          : installed.find((agent) => agent.config.name === config.defaultAgentCli) || installed[0];

        if (!selected) {
          append(`⚠️ Unknown agent '${parsed.agentName}'. Try claude, codex, gemini, or opencode.`);
          return false;
        }

        append(`Creating session '${projectName}' with ${selected.config.displayName}...`);
        await newCommand(selected.config.name, {
          name: projectName,
          instance: parsed.instanceId,
          attach: parsed.attach,
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
        append(`✅ Session created: ${projectName}`);
        append(`[project] ${projectName} (${selected.config.name})`);
        return false;
      } catch (error) {
        append(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }

    append(`Unknown command: ${command}`);
    append('Try /help');
    return false;
  };

  const isBunRuntime = Boolean((process as { versions?: { bun?: string } }).versions?.bun);
  if (!isBunRuntime) {
    throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
  }

  const preloadModule = '@opentui/solid/preload';
  await import(preloadModule);
  const tmuxPaneTarget = process.env.TMUX_PANE;
  const startedFromTmux = !!process.env.TMUX;
  if (startedFromTmux) {
    const paneReady = tmuxPaneTarget ? await waitForTmuxPaneAlive(tmuxPaneTarget) : false;
    if (!paneReady) {
      console.log(chalk.yellow('⚠️ Stale tmux environment detected; skipping TUI startup to avoid orphaned process.'));
      return;
    }
  }

  let tmuxHealthTimer: ReturnType<typeof setInterval> | undefined;
  if (startedFromTmux) {
    tmuxHealthTimer = setInterval(() => {
      if (isTmuxPaneAlive(tmuxPaneTarget)) return;
      console.log(chalk.yellow('\n⚠️ tmux session/pane ended; exiting TUI to prevent leaked process.'));
      process.exit(0);
    }, 5000);
    tmuxHealthTimer.unref();
  }

  const clearTmuxHealthTimer = () => {
    if (!tmuxHealthTimer) return;
    clearInterval(tmuxHealthTimer);
    tmuxHealthTimer = undefined;
  };
  process.once('exit', clearTmuxHealthTimer);

  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const currentSession = tmux.getCurrentSession(process.env.TMUX_PANE);
  const currentWindow = tmux.getCurrentWindow(process.env.TMUX_PANE);

  const sourceCandidates = [
    new URL('./tui.js', import.meta.url),
    new URL('./tui.tsx', import.meta.url),
    new URL('../../../dist/bin/tui.js', import.meta.url),
    new URL('../../../bin/tui.tsx', import.meta.url),
  ];
  let mod: any;
  for (const candidate of sourceCandidates) {
    const candidatePath = fileURLToPath(candidate);
    if (!existsSync(candidatePath)) continue;
    try {
      const loaded = await import(candidate.href);
      if (loaded && typeof loaded.runTui === 'function') {
        mod = loaded;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!mod) {
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);
    throw new Error('OpenTUI entry not found: bin/tui.tsx or dist/bin/tui.js');
  }

  try {
    await mod.runTui({
      currentSession: currentSession || undefined,
      currentWindow: currentWindow || undefined,
      onCommand: handler,
      onAttachProject: async (project: string) => {
        attachCommand(project, {
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
      },
      onStopProject: async (project: string) => {
        await stopCommand(project, {
          keepChannel: keepChannelOnStop,
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
      },
      getProjects: () =>
        stateManager.listProjects().map((project) => {
          const instances = listProjectInstances(project);
          const agentNames = getEnabledAgentNames(project);
          const labels = agentNames.map((agentName) => agentRegistry.get(agentName)?.config.displayName || agentName);
          const primaryInstance = instances[0];
          const window = primaryInstance
            ? resolveProjectWindowName(project, primaryInstance.agentType, effectiveConfig.tmux, primaryInstance.instanceId)
            : '(none)';
          const channelCount = instances.filter((instance) => !!instance.channelId).length;
          const channelBase = channelCount > 0 ? `${channelCount} channel(s)` : 'not connected';
          const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
          const windowUp = sessionUp && instances.some((instance) => {
            const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
            return tmux.windowExists(project.tmuxSession, name);
          });
          return {
            project: project.projectName,
            session: project.tmuxSession,
            window,
            ai: labels.length > 0 ? labels.join(', ') : 'none',
            channel: channelBase,
            open: windowUp,
          };
        }),
    });
  } finally {
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);
  }
}
