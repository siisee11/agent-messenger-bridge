#!/usr/bin/env bun

/**
 * CLI entry point for discode
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { Argv } from 'yargs';
import { AgentBridge } from '../src/index.js';
import { stateManager } from '../src/state/index.js';
import { validateConfig, config, saveConfig, getConfigPath } from '../src/config/index.js';
import { TmuxManager } from '../src/tmux/manager.js';
import { agentRegistry } from '../src/agents/index.js';
import { DiscordClient } from '../src/discord/client.js';
import { defaultDaemonManager } from '../src/daemon.js';
import { basename, resolve } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import type { BridgeConfig } from '../src/types/index.js';

type TmuxCliOptions = {
  tmuxSessionMode?: string;
  tmuxSharedSessionName?: string;
};

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function attachToTmux(sessionName: string, windowName?: string): void {
  const sessionTarget = sessionName;
  const windowTarget = windowName ? `${sessionName}:${windowName}` : undefined;
  const tmuxAction = process.env.TMUX ? 'switch-client' : 'attach-session';

  if (!windowTarget) {
    execSync(`tmux ${tmuxAction} -t ${escapeShellArg(sessionTarget)}`, { stdio: 'inherit' });
    return;
  }

  try {
    execSync(`tmux ${tmuxAction} -t ${escapeShellArg(windowTarget)}`, { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow(`⚠️ Window '${windowName}' not found, attaching to session '${sessionName}' instead.`));
    execSync(`tmux ${tmuxAction} -t ${escapeShellArg(sessionTarget)}`, { stdio: 'inherit' });
  }
}

function applyTmuxCliOverrides(base: BridgeConfig, options: TmuxCliOptions): BridgeConfig {
  // NOTE: `config` comes from src/config via a Proxy (lazy getter). Do not spread it.
  // Access properties explicitly so the Proxy's `get` trap is used.
  const baseDiscord = base.discord;
  const baseTmux = base.tmux;
  const baseHookPort = base.hookServerPort;

  const modeRaw = options?.tmuxSessionMode as string | undefined;
  const sharedNameRaw = options?.tmuxSharedSessionName as string | undefined;

  let mode: BridgeConfig['tmux']['sessionMode'] | undefined = undefined;
  if (modeRaw !== undefined) {
    if (modeRaw === 'per-project' || modeRaw === 'shared') {
      mode = modeRaw;
    } else {
      console.error(chalk.red(`Invalid --tmux-session-mode: ${modeRaw}`));
      console.error(chalk.gray(`Valid values: per-project, shared`));
      process.exit(1);
    }
  }

  return {
    discord: baseDiscord,
    hookServerPort: baseHookPort,
    tmux: {
      ...baseTmux,
      ...(mode !== undefined ? { sessionMode: mode } : {}),
      ...(sharedNameRaw !== undefined ? { sharedSessionName: sharedNameRaw } : {}),
    },
  };
}

function ensureProjectTuiPane(
  tmux: TmuxManager,
  sessionName: string,
  windowName: string,
  options: TmuxCliOptions,
): void {
  const discodeRunner = resolve(import.meta.dirname, './discode.js');
  const commandParts = ['bun', discodeRunner, 'tui'];
  if (options.tmuxSessionMode) {
    commandParts.push('--tmux-session-mode', options.tmuxSessionMode);
  }
  if (options.tmuxSharedSessionName) {
    commandParts.push('--tmux-shared-session-name', options.tmuxSharedSessionName);
  }
  const tuiCommand = commandParts.map((part) => escapeShellArg(part)).join(' ');
  tmux.ensureTuiPane(sessionName, windowName, tuiCommand);
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function nextProjectName(baseName: string): string {
  if (!stateManager.getProject(baseName)) return baseName;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!stateManager.getProject(candidate)) return candidate;
  }
  return `${baseName}-${Date.now()}`;
}

function parseSessionNew(raw: string): {
  projectName?: string;
  agentName?: string;
  attach: boolean;
  yolo: boolean;
  sandbox: boolean;
} {
  const parts = raw.split(/\s+/).filter(Boolean);
  const attach = parts.includes('--attach');
  const yolo = parts.includes('--yolo');
  const sandbox = parts.includes('--sandbox');
  const values = parts.filter((item) => !item.startsWith('--'));
  const projectName = values[1];
  const agentName = values[2];
  return { projectName, agentName, attach, yolo, sandbox };
}

async function tuiCommand(options: TmuxCliOptions): Promise<void> {
  const handler = async (command: string, append: (line: string) => void): Promise<boolean> => {
    if (command === '/exit' || command === '/quit') {
      append('Bye!');
      return true;
    }

    if (command === '/help') {
      append('Commands: /session_new [name] [agent] [--yolo] [--sandbox] [--attach], /projects, /help, /exit');
      return false;
    }

    if (command === '/projects') {
      const projects = stateManager.listProjects();
      if (projects.length === 0) {
        append('No projects configured.');
        return false;
      }
      projects.forEach((project) => {
        const agentName = Object.entries(project.agents).find(([_, enabled]) => enabled)?.[0] || 'none';
        append(`[project] ${project.projectName} (${agentName})`);
      });
      return false;
    }

    if (command === 'stop' || command === '/stop') {
      append('Use stop dialog to choose a project.');
      return false;
    }

    if (command.startsWith('stop ') || command.startsWith('/stop ')) {
      const projectName = command.replace(/^\/?stop\s+/, '').trim();
      if (!projectName) {
        append('⚠️ Project name is required. Example: stop my-project');
        return false;
      }
      await stopCommand(projectName, {
        tmuxSessionMode: options.tmuxSessionMode,
        tmuxSharedSessionName: options.tmuxSharedSessionName,
      });
      append(`✅ Stopped project: ${projectName}`);
      return false;
    }

    if (command.startsWith('/session_new') || command.startsWith('/new')) {
      try {
        validateConfig();
        if (!stateManager.getGuildId()) {
          append('⚠️ Not set up yet. Run: discode setup <token>');
          return false;
        }

        const installed = agentRegistry.getAll().filter((agent) => agent.isInstalled());
        if (installed.length === 0) {
          append('⚠️ No agent CLIs found. Install one first (claude, codex, opencode).');
          return false;
        }

        const parsed = parseSessionNew(command);
        const cwdName = basename(process.cwd());
        const projectName = parsed.projectName && parsed.projectName.trim().length > 0
          ? parsed.projectName.trim()
          : nextProjectName(cwdName);

        const selected = parsed.agentName
          ? installed.find((agent) => agent.config.name === parsed.agentName)
          : installed[0];

        if (!selected) {
          append(`⚠️ Unknown agent '${parsed.agentName}'. Try claude, codex, or opencode.`);
          return false;
        }

        append(`Creating session '${projectName}' with ${selected.config.displayName}...`);
        await goCommand(selected.config.name, {
          name: projectName,
          attach: parsed.attach,
          yolo: parsed.yolo,
          sandbox: parsed.sandbox,
          tmuxSessionMode: options.tmuxSessionMode,
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
  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const currentSession = process.env.TMUX_PANE
    ? tmux.getSessionForPane(process.env.TMUX_PANE)
    : null;

  const sourceCandidates = [
    new URL('./tui.tsx', import.meta.url),
    new URL('../../bin/tui.tsx', import.meta.url),
  ];
  const sourceUrl = sourceCandidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (!sourceUrl) {
    throw new Error('OpenTUI source entry not found: bin/tui.tsx');
  }

  const mod = await import(sourceUrl.href);
  await mod.runTui({
    currentSession: currentSession || undefined,
    onCommand: handler,
    onAttachProject: async (project: string) => {
      attachCommand(project, {
        tmuxSessionMode: options.tmuxSessionMode,
        tmuxSharedSessionName: options.tmuxSharedSessionName,
      });
    },
    onStopProject: async (project: string) => {
      await stopCommand(project, {
        tmuxSessionMode: options.tmuxSessionMode,
        tmuxSharedSessionName: options.tmuxSharedSessionName,
      });
    },
    getProjects: () =>
      stateManager.listProjects().map((project) => {
        const agentName = Object.entries(project.agents).find(([_, enabled]) => enabled)?.[0] || 'none';
        const adapter = agentRegistry.get(agentName);
        const window = project.tmuxWindows?.[agentName] || agentName;
        const channelId = project.discordChannels[agentName];
        const channelBase = channelId ? `discord#${agentName}-${project.projectName}` : 'not connected';
        const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
        const windowUp = sessionUp ? tmux.windowExists(project.tmuxSession, window) : false;
        return {
          project: project.projectName,
          session: project.tmuxSession,
          window,
          ai: adapter?.config.displayName || agentName,
          channel: channelBase,
          open: windowUp,
        };
      }),
  });
}

async function setupCommand(token: string) {
  try {
    console.log(chalk.cyan('\n🔧 Discode Setup\n'));

    saveConfig({ token });
    console.log(chalk.green('✅ Bot token saved'));

    console.log(chalk.gray('   Connecting to Discord...'));
    const client = new DiscordClient(token);
    await client.connect();

    const guilds = client.getGuilds();
    let selectedGuild: { id: string; name: string };

    if (guilds.length === 0) {
      console.error(chalk.red('\n❌ Bot is not in any server.'));
      console.log(chalk.gray('   Invite your bot to a server first:'));
      console.log(chalk.gray('   https://discord.com/developers/applications → OAuth2 → URL Generator'));
      await client.disconnect();
      process.exit(1);
    }

    if (guilds.length === 1) {
      selectedGuild = guilds[0];
      console.log(chalk.green(`✅ Server detected: ${selectedGuild.name} (${selectedGuild.id})`));
    } else {
      console.log(chalk.white('\n   Bot is in multiple servers:\n'));
      guilds.forEach((g, i) => {
        console.log(chalk.gray(`   ${i + 1}. ${g.name} (${g.id})`));
      });
      const answer = await prompt(chalk.white(`\n   Select server [1-${guilds.length}]: `));
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= guilds.length) {
        console.error(chalk.red('Invalid selection'));
        await client.disconnect();
        process.exit(1);
      }
      selectedGuild = guilds[idx];
      console.log(chalk.green(`✅ Server selected: ${selectedGuild.name}`));
    }

    stateManager.setGuildId(selectedGuild.id);
    saveConfig({ serverId: selectedGuild.id });

    const installedAgents = agentRegistry.getAll().filter(a => a.isInstalled());
    console.log(chalk.white('\n🤖 Installed agents:'));
    if (installedAgents.length === 0) {
      console.log(chalk.yellow('   None detected. Install an agent CLI (claude, opencode) first.'));
    } else {
      for (const a of installedAgents) {
        console.log(chalk.green(`   ✓ ${a.config.displayName} (${a.config.command})`));
      }
    }

    await client.disconnect();

    console.log(chalk.cyan('\n✨ Setup complete!\n'));
    console.log(chalk.white('Next step:'));
    console.log(chalk.gray('   cd <your-project>'));
    console.log(chalk.gray('   discode new\n'));
  } catch (error) {
    console.error(chalk.red('Setup failed:'), error);
    process.exit(1);
  }
}

async function startCommand(options: TmuxCliOptions & { project?: string; attach?: boolean }) {
  try {
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);

    const projects = stateManager.listProjects();

    if (projects.length === 0) {
      console.log(chalk.yellow('⚠️  No projects configured.'));
      console.log(chalk.gray('   Run `discode init` in a project directory first.'));
      process.exit(1);
    }

      // Filter by project if specified
    const activeProjects = options.project
      ? projects.filter(p => p.projectName === options.project)
      : projects;

    if (activeProjects.length === 0) {
      console.log(chalk.red(`Project "${options.project}" not found.`));
      process.exit(1);
    }

      // --attach requires --project
    if (options.attach && !options.project) {
      console.log(chalk.red('--attach requires --project option'));
      console.log(chalk.gray('Example: discode start -p myproject --attach'));
      process.exit(1);
    }

    console.log(chalk.cyan('\n🚀 Starting Discode\n'));
    console.log(chalk.white('Configuration:'));
    console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId()}`));
    console.log(chalk.gray(`   Hook port: ${config.hookServerPort || 18470}`));

    console.log(chalk.white('\nProjects to bridge:'));
    for (const project of activeProjects) {
        const agentName = Object.entries(project.agents)
          .find(([_, enabled]) => enabled)?.[0];
        const adapter = agentName ? agentRegistry.get(agentName) : null;

        console.log(chalk.green(`   ✓ ${project.projectName}`));
        console.log(chalk.gray(`     Agent: ${adapter?.config.displayName || agentName || 'none'}`));
        console.log(chalk.gray(`     Channel: #${project.projectName}-${adapter?.config.channelSuffix || agentName}`));
        console.log(chalk.gray(`     Path: ${project.projectPath}`));
    }
    console.log('');

    const bridge = new AgentBridge({ config: effectiveConfig });

      // If --attach, start bridge in background and attach to tmux
    if (options.attach) {
      const project = activeProjects[0];
        const sessionName = project.tmuxSession;
        const agentType = Object.entries(project.agents).find(([_, enabled]) => enabled)?.[0];
        const windowName = agentType ? (project.tmuxWindows?.[agentType] || agentType) : undefined;
        const attachTarget = windowName ? `${sessionName}:${windowName}` : sessionName;

        // Start bridge, then attach
      await bridge.start();
      console.log(chalk.cyan(`\n📺 Attaching to ${attachTarget}...\n`));
      attachToTmux(sessionName, windowName);
      return;
    }

    await bridge.start();
  } catch (error) {
    console.error(chalk.red('Error starting bridge:'), error);
    process.exit(1);
  }
}

async function initCommand(agentName: string, description: string, options: TmuxCliOptions & { name?: string }) {
  try {
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);

      // Check server ID
    if (!stateManager.getGuildId()) {
      console.error(chalk.red('Server ID not configured.'));
      console.log(chalk.gray('Run: discode config --server <your-server-id>'));
      process.exit(1);
    }

      // Validate agent
    const adapter = agentRegistry.get(agentName.toLowerCase());
    if (!adapter) {
      console.error(chalk.red(`Unknown agent: ${agentName}`));
      console.log(chalk.gray('Available agents:'));
      for (const a of agentRegistry.getAll()) {
        console.log(chalk.gray(`  - ${a.config.name} (${a.config.displayName})`));
      }
      process.exit(1);
    }

    const projectPath = process.cwd();
    const projectName = options.name || basename(projectPath);

      // Channel name format: "Agent - description"
    const channelDisplayName = `${adapter.config.displayName} - ${description}`;

    console.log(chalk.cyan(`\n📦 Initializing project: ${projectName}\n`));

    const bridge = new AgentBridge({ config: effectiveConfig });
    console.log(chalk.gray('   Connecting to Discord...'));
    await bridge.connect();

      // Only enable the selected agent
    const agents = { [adapter.config.name]: true };
    const result = await bridge.setupProject(projectName, projectPath, agents, channelDisplayName);

    console.log(chalk.green('\n✅ Project initialized!\n'));

    console.log(chalk.white('📋 Setup Summary:'));
    console.log(chalk.gray(`   Project:    ${projectName}`));
    console.log(chalk.gray(`   Path:       ${projectPath}`));
    console.log(chalk.gray(`   Agent:      ${result.agentName}`));
    console.log(chalk.cyan(`   Channel:    #${result.channelName}`));
    console.log(chalk.gray(`   tmux:       ${result.tmuxSession}`));

    console.log(chalk.green('✅ Environment variables auto-configured in tmux session'));

    console.log(chalk.white('\n🚀 Next step:\n'));
    console.log(chalk.gray('   discode new'));
    console.log(chalk.cyan(`   Then send messages in Discord #${result.channelName}\n`));

    await bridge.stop();
  } catch (error) {
    console.error(chalk.red('Error initializing project:'), error);
    process.exit(1);
  }
}

async function goCommand(
  agentArg: string | undefined,
  options: TmuxCliOptions & { name?: string; attach?: boolean; yolo?: boolean; sandbox?: boolean }
) {
  try {
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);

    if (!stateManager.getGuildId()) {
      console.error(chalk.red('Not set up yet. Run: discode setup <token>'));
      process.exit(1);
    }

    const projectPath = process.cwd();
    const projectName = options.name || basename(projectPath);
    const port = defaultDaemonManager.getPort();

    console.log(chalk.cyan(`\n🚀 discode new — ${projectName}\n`));

      // Determine agent
    let agentName: string;
    const existingProject = stateManager.getProject(projectName);

    if (agentArg) {
        // Explicitly specified
        const adapter = agentRegistry.get(agentArg.toLowerCase());
        if (!adapter) {
          console.error(chalk.red(`Unknown agent: ${agentArg}`));
          process.exit(1);
        }
        agentName = adapter.config.name;
    } else if (existingProject) {
        // Reuse existing project's agent
        const existing = Object.entries(existingProject.agents).find(([_, enabled]) => enabled)?.[0];
        if (!existing) {
          console.error(chalk.red('Existing project has no agent configured'));
          process.exit(1);
        }
        agentName = existing;
        console.log(chalk.gray(`   Reusing existing agent: ${agentName}`));
    } else {
        // Auto-detect installed agents
        const installed = agentRegistry.getAll().filter(a => a.isInstalled());
        if (installed.length === 0) {
          console.error(chalk.red('No agent CLIs found. Install one first (claude, opencode).'));
          process.exit(1);
        } else if (installed.length === 1) {
          agentName = installed[0].config.name;
          console.log(chalk.gray(`   Auto-selected agent: ${installed[0].config.displayName}`));
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

      // Ensure global daemon is running
    const running = await defaultDaemonManager.isRunning();
    if (!running) {
      console.log(chalk.gray('   Starting bridge daemon...'));
      const entryPoint = resolve(import.meta.dirname, '../src/daemon-entry.js');
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

    const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);
    const yolo = !!options.yolo;
    const sandbox = !!options.sandbox;

    if (sandbox) {
      console.log(chalk.cyan('   🐳 Sandbox mode: --sandbox (Docker container)'));
    }
    if (yolo) {
      console.log(chalk.yellow('   ⚡ YOLO mode: --dangerously-skip-permissions'));
    }

    if (!existingProject) {
        // New project: full setup via bridge
        console.log(chalk.gray('   Setting up new project...'));
        const bridge = new AgentBridge({ config: effectiveConfig });
        await bridge.connect();

        const adapter = agentRegistry.get(agentName)!;
        const channelDisplayName = `${adapter.config.displayName} - ${projectName}`;
        const agents = { [agentName]: true };
        const result = await bridge.setupProject(projectName, projectPath, agents, channelDisplayName, undefined, yolo, sandbox);

        console.log(chalk.green(`✅ Project created`));
        console.log(chalk.cyan(`   Channel: #${result.channelName}`));

        await bridge.stop();

        // Notify the running daemon to reload channel mappings
      try {
        const http = await import('http');
        await new Promise<void>((resolve) => {
          const req = http.request(`http://127.0.0.1:${port}/reload`, { method: 'POST' }, () => resolve());
          req.on('error', () => resolve());
          req.setTimeout(2000, () => {
            req.destroy();
            resolve();
          });
          req.end();
        });
      } catch {
        // daemon will pick up on next restart
      }
    } else {
        // Existing project: ensure tmux session exists (use stored full session name)
        const fullSessionName = existingProject.tmuxSession;
        const prefix = effectiveConfig.tmux.sessionPrefix;
        if (fullSessionName.startsWith(prefix)) {
          tmux.getOrCreateSession(fullSessionName.slice(prefix.length));
        }
        // Keep legacy port env on per-project sessions; avoid setting per-project env on shared sessions.
        const sharedFull = `${prefix}${effectiveConfig.tmux.sharedSessionName || 'bridge'}`;
        const isSharedSession = fullSessionName === sharedFull;
        if (!isSharedSession) {
          tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PROJECT', projectName);
        }
        tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PORT', String(port));
        console.log(chalk.green(`✅ Existing project resumed`));
    }

      // Summary
    const projectState = stateManager.getProject(projectName);
    const sessionName = projectState?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
    const statusWindowName = projectState?.tmuxWindows?.[agentName] || agentName;
    try {
      ensureProjectTuiPane(tmux, sessionName, statusWindowName, options);
    } catch (error) {
      console.log(chalk.yellow(`⚠️ Could not start discode TUI pane: ${error instanceof Error ? error.message : String(error)}`));
    }
    console.log(chalk.cyan('\n✨ Ready!\n'));
    console.log(chalk.gray(`   Project:  ${projectName}`));
    console.log(chalk.gray(`   Session:  ${sessionName}`));
    console.log(chalk.gray(`   Agent:    ${agentName}`));
    console.log(chalk.gray(`   Port:     ${port}`));

      // Attach
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

async function configCommand(options: { show?: boolean; server?: string; token?: string; port?: string | number }) {
  if (options.show) {
      console.log(chalk.cyan('\n📋 Current configuration:\n'));
      console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
      console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId() || '(not set)'}`));
      console.log(chalk.gray(`   Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
      console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
      console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
      for (const adapter of agentRegistry.getAll()) {
        console.log(chalk.gray(`   - ${adapter.config.displayName} (${adapter.config.name})`));
      }
      console.log('');
    return;
  }

  let updated = false;

  if (options.server) {
      stateManager.setGuildId(options.server);
      saveConfig({ serverId: options.server });
      console.log(chalk.green(`✅ Server ID saved: ${options.server}`));
      updated = true;
  }

  if (options.token) {
      saveConfig({ token: options.token });
      console.log(chalk.green(`✅ Bot token saved (****${options.token.slice(-4)})`));
      updated = true;
  }

  if (options.port) {
    const port = parseInt(String(options.port), 10);
      saveConfig({ hookServerPort: port });
      console.log(chalk.green(`✅ Hook port saved: ${port}`));
      updated = true;
  }

  if (!updated) {
    console.log(chalk.yellow('No options provided. Use --help to see available options.'));
    console.log(chalk.gray('\nExample:'));
    console.log(chalk.gray('  discode config --token YOUR_BOT_TOKEN'));
    console.log(chalk.gray('  discode config --server YOUR_SERVER_ID'));
    console.log(chalk.gray('  discode config --show'));
  }
}

function statusCommand(options: TmuxCliOptions) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
    const projects = stateManager.listProjects();
    const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);
    const sessions = tmux.listSessions();

    console.log(chalk.cyan('\n📊 Discode Status\n'));

    console.log(chalk.white('Configuration:'));
    console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId() || '(not configured)'}`));
    console.log(chalk.gray(`   Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));

    console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
    for (const adapter of agentRegistry.getAll()) {
      console.log(chalk.gray(`   ${adapter.config.displayName} (${adapter.config.command})`));
    }

    console.log(chalk.cyan('\n📂 Projects:\n'));

    if (projects.length === 0) {
      console.log(chalk.gray('   No projects configured. Run `discode init` in a project directory.'));
    } else {
      for (const project of projects) {
        const sessionActive = sessions.some(s => s.name === project.tmuxSession);
        const status = sessionActive ? chalk.green('● active') : chalk.gray('○ inactive');

        console.log(chalk.white(`   ${project.projectName}`), status);
        console.log(chalk.gray(`     Path: ${project.projectPath}`));

        // Show the single agent
        const agentName = Object.entries(project.agents)
          .find(([_, enabled]) => enabled)?.[0];
        const adapter = agentName ? agentRegistry.get(agentName) : null;
        console.log(chalk.gray(`     Agent: ${adapter?.config.displayName || agentName || 'none'}`));
        console.log('');
      }
    }

    console.log(chalk.cyan('📺 tmux Sessions:\n'));
    if (sessions.length === 0) {
      console.log(chalk.gray('   No active sessions'));
    } else {
      for (const session of sessions) {
        console.log(chalk.white(`   ${session.name}`), chalk.gray(`(${session.windows} windows)`));
      }
    }
  console.log('');
}

function listCommand(options?: { prune?: boolean }) {
  const projects = stateManager.listProjects();
  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const prune = !!options?.prune;

    if (projects.length === 0) {
      console.log(chalk.gray('No projects configured.'));
      return;
    }

    const pruned: string[] = [];
    console.log(chalk.cyan('\n📂 Configured Projects:\n'));
    for (const project of projects) {
      const agentName = Object.entries(project.agents)
        .find(([_, enabled]) => enabled)?.[0];
      const adapter = agentName ? agentRegistry.get(agentName) : null;
      const windowName = agentName ? (project.tmuxWindows?.[agentName] || agentName) : undefined;
      const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
      const windowUp = sessionUp && !!windowName ? tmux.windowExists(project.tmuxSession, windowName) : false;
      const status = windowUp ? 'running' : sessionUp ? 'session only' : 'stale';

      if (prune && status !== 'running') {
        stateManager.removeProject(project.projectName);
        pruned.push(project.projectName);
        continue;
      }

      console.log(chalk.white(`  • ${project.projectName}`));
      console.log(chalk.gray(`    Agent: ${adapter?.config.displayName || agentName || 'none'}`));
      console.log(chalk.gray(`    Path: ${project.projectPath}`));
      console.log(chalk.gray(`    Status: ${status}`));
      if (windowName) {
        console.log(chalk.gray(`    tmux: ${project.tmuxSession}:${windowName}`));
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

function agentsCommand() {
  console.log(chalk.cyan('\n🤖 Available Agent Adapters:\n'));
    for (const adapter of agentRegistry.getAll()) {
      console.log(chalk.white(`  ${adapter.config.displayName}`));
      console.log(chalk.gray(`    Name: ${adapter.config.name}`));
      console.log(chalk.gray(`    Command: ${adapter.config.command}`));
    console.log('');
  }
}

function attachCommand(projectName: string | undefined, options: TmuxCliOptions) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
    const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);

    if (!projectName) {
      // Use current directory name
      projectName = basename(process.cwd());
    }

    const project = stateManager.getProject(projectName);
    const sessionName = project?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
    const agentType = project
      ? Object.entries(project.agents).find(([_, enabled]) => enabled)?.[0]
      : undefined;
    const windowName = agentType ? (project?.tmuxWindows?.[agentType] || agentType) : undefined;
    const attachTarget = windowName ? `${sessionName}:${windowName}` : sessionName;

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

async function stopCommand(
  projectName: string | undefined,
  options: TmuxCliOptions & { keepChannel?: boolean }
) {
  if (!projectName) {
      projectName = basename(process.cwd());
  }

    console.log(chalk.cyan(`\n🛑 Stopping project: ${projectName}\n`));

    const project = stateManager.getProject(projectName);
    const effectiveConfig = applyTmuxCliOverrides(config, options);

    // 1. Kill tmux (session in per-project mode, windows in shared/non-dedicated mode)
    const prefix = effectiveConfig.tmux.sessionPrefix;
    const expectedDedicatedSession = `${prefix}${projectName}`;
    const sessionName = project?.tmuxSession || expectedDedicatedSession;
    const killWindows =
      !!project && (
        effectiveConfig.tmux.sessionMode === 'shared' ||
        sessionName !== expectedDedicatedSession
      );

    if (!killWindows) {
      try {
        execSync(`tmux kill-session -t ${escapeShellArg(sessionName)}`, { stdio: 'ignore' });
        console.log(chalk.green(`✅ tmux session killed: ${sessionName}`));
      } catch {
        console.log(chalk.gray(`   tmux session ${sessionName} not running`));
      }
    } else {
      const enabledAgentTypes = Object.entries(project.agents).filter(([_, enabled]) => enabled).map(([agentType]) => agentType);
      if (enabledAgentTypes.length === 0) {
        console.log(chalk.gray(`   No enabled agents in state; not killing tmux windows`));
      } else {
        for (const agentType of enabledAgentTypes) {
          const windowName = project.tmuxWindows?.[agentType] || agentType;
          const target = `${sessionName}:${windowName}`;
          try {
            execSync(`tmux kill-window -t ${escapeShellArg(target)}`, { stdio: 'ignore' });
            console.log(chalk.green(`✅ tmux window killed: ${target}`));
          } catch {
            console.log(chalk.gray(`   tmux window ${target} not running`));
          }
        }
      }
    }

    // 2. Delete Discord channel (unless --keep-channel)
    if (project && !options.keepChannel) {
      const channelIds = Object.values(project.discordChannels).filter(Boolean) as string[];
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

    // 3. Remove from state
    if (project) {
      stateManager.removeProject(projectName);
      console.log(chalk.green(`✅ Project removed from state`));
    }

    // Note: daemon is global and shared, don't stop it here
    // Use `discode daemon stop` to stop the daemon

  console.log(chalk.cyan('\n✨ Done\n'));
}

async function daemonCommand(action: string) {
  const port = defaultDaemonManager.getPort();

    switch (action) {
      case 'start': {
        const running = await defaultDaemonManager.isRunning();
        if (running) {
          console.log(chalk.green(`✅ Daemon already running (port ${port})`));
          return;
        }
        console.log(chalk.gray('Starting daemon...'));
        const entryPoint = resolve(import.meta.dirname, '../src/daemon-entry.js');
        defaultDaemonManager.startDaemon(entryPoint);
        const ready = await defaultDaemonManager.waitForReady();
        if (ready) {
          console.log(chalk.green(`✅ Daemon started (port ${port})`));
        } else {
          console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${defaultDaemonManager.getLogFile()}`));
        }
        break;
      }
      case 'stop': {
        if (defaultDaemonManager.stopDaemon()) {
          console.log(chalk.green('✅ Daemon stopped'));
        } else {
          console.log(chalk.gray('Daemon was not running'));
        }
        break;
      }
      case 'status': {
        const running = await defaultDaemonManager.isRunning();
        if (running) {
          console.log(chalk.green(`✅ Daemon running (port ${port})`));
        } else {
          console.log(chalk.gray('Daemon not running'));
        }
        console.log(chalk.gray(`   Log: ${defaultDaemonManager.getLogFile()}`));
        console.log(chalk.gray(`   PID: ${defaultDaemonManager.getPidFile()}`));
        break;
      }
      default:
        console.error(chalk.red(`Unknown action: ${action}`));
        console.log(chalk.gray('Available actions: start, stop, status'));
        process.exit(1);
  }
}

function addTmuxOptions<T>(y: Argv<T>) {
  return y
    .option('tmux-session-mode', {
      type: 'string',
      describe: 'tmux session mode: shared (default) or per-project',
    })
    .option('tmux-shared-session-name', {
      type: 'string',
      describe: 'shared tmux session name (without prefix) when using shared mode',
    });
}

await yargs(hideBin(process.argv))
  .scriptName('discode')
  .usage('$0 [command]')
  .version('0.1.0')
  .help()
  .strict()
  .command(
    ['$0', 'tui'],
    'Interactive terminal UI (supports /session_new)',
    (y: Argv) => addTmuxOptions(y),
    async (argv: any) =>
      tuiCommand({
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'setup <token>',
    'One-time setup: save token, detect server, install hooks',
    (y: Argv) => y.positional('token', { type: 'string', describe: 'Discord bot token', demandOption: true }),
    async (argv: any) => setupCommand(argv.token)
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
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'init <agent> <description>',
    'Initialize Discord bridge for current project',
    (y: Argv) => addTmuxOptions(y)
      .positional('agent', { type: 'string', describe: 'Agent to use (claude, codex, or opencode)', demandOption: true })
      .positional('description', { type: 'string', describe: 'Channel description (e.g., "내 프로젝트 작업")', demandOption: true })
      .option('name', { alias: 'n', type: 'string', describe: 'Project name (defaults to directory name)' }),
    async (argv: any) =>
      initCommand(argv.agent, argv.description, {
        name: argv.name,
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'new [agent]',
    'Quick start: launch daemon, setup project, attach tmux',
    (y: Argv) => addTmuxOptions(y)
      .positional('agent', { type: 'string', describe: 'Agent to use (claude, codex, opencode)' })
      .option('name', { alias: 'n', type: 'string', describe: 'Project name (defaults to directory name)' })
      .option('attach', { type: 'boolean', default: true, describe: 'Attach to tmux session after setup' })
      .option('yolo', { type: 'boolean', describe: 'YOLO mode: run agent with --dangerously-skip-permissions (no approval needed)' })
      .option('sandbox', { type: 'boolean', describe: 'Sandbox mode: run Claude Code in a sandboxed Docker container' }),
    async (argv: any) =>
      goCommand(argv.agent, {
        name: argv.name,
        attach: argv.attach,
        yolo: argv.yolo,
        sandbox: argv.sandbox,
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'config',
    'Configure Discord bridge settings',
    (y: Argv) => y
      .option('server', { alias: 's', type: 'string', describe: 'Set Discord server ID' })
      .option('token', { alias: 't', type: 'string', describe: 'Set Discord bot token' })
      .option('port', { alias: 'p', type: 'string', describe: 'Set hook server port' })
      .option('show', { type: 'boolean', describe: 'Show current configuration' }),
    async (argv: any) => configCommand(argv)
  )
  .command(
    'status',
    'Show bridge and project status',
    (y: Argv) => addTmuxOptions(y),
    (argv: any) =>
      statusCommand({
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'list',
    'List all configured projects',
    (y: Argv) => y.option('prune', { type: 'boolean', describe: 'Remove projects whose tmux window is not running' }),
    (argv: any) => listCommand({ prune: argv.prune })
  )
  .command(
    'ls',
    false,
    (y: Argv) => y.option('prune', { type: 'boolean', describe: 'Remove projects whose tmux window is not running' }),
    (argv: any) => listCommand({ prune: argv.prune })
  )
  .command('agents', 'List available AI agent adapters', () => {}, () => agentsCommand())
  .command(
    'attach [project]',
    'Attach to a project tmux session',
    (y: Argv) => addTmuxOptions(y).positional('project', { type: 'string' }),
    (argv: any) =>
      attachCommand(argv.project, {
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'stop [project]',
    'Stop a project (kills tmux session, deletes Discord channel)',
    (y: Argv) => addTmuxOptions(y)
      .positional('project', { type: 'string' })
      .option('keep-channel', { type: 'boolean', describe: 'Keep Discord channel (only kill tmux)' }),
    async (argv: any) =>
      stopCommand(argv.project, {
        keepChannel: argv.keepChannel,
        tmuxSessionMode: argv.tmuxSessionMode,
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'daemon <action>',
    'Manage the global bridge daemon (start|stop|status)',
    (y: Argv) => y.positional('action', { type: 'string', demandOption: true }),
    async (argv: any) => daemonCommand(argv.action)
  )
  .parseAsync();
