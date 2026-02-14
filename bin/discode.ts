#!/usr/bin/env bun

/**
 * CLI entry point for discode
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { Argv } from 'yargs';
import { AgentBridge } from '../src/index.js';
import { stateManager, type ProjectState } from '../src/state/index.js';
import { validateConfig, config, saveConfig, getConfigPath, getConfigValue } from '../src/config/index.js';
import { TmuxManager } from '../src/tmux/manager.js';
import { agentRegistry } from '../src/agents/index.js';
import { DiscordClient } from '../src/discord/client.js';
import { defaultDaemonManager } from '../src/daemon.js';
import { existsSync, readFileSync, rmSync } from 'fs';
import { basename, join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';
import { homedir } from 'os';
import { createInterface } from 'readline';
import chalk from 'chalk';
import type { BridgeConfig } from '../src/types/index.js';
import { installOpencodePlugin } from '../src/opencode/plugin-installer.js';
import { installClaudePlugin } from '../src/claude/plugin-installer.js';
import { installGeminiHook, removeGeminiHook } from '../src/gemini/hook-installer.js';
import { installCodexHook } from '../src/codex/plugin-installer.js';
import {
  buildNextInstanceId,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectAgentTypes,
  listProjectInstances,
  normalizeProjectState,
} from '../src/state/instances.js';

declare const DISCODE_VERSION: string | undefined;

type TmuxCliOptions = {
  tmuxSharedSessionName?: string;
};

type RegisteredAgentAdapter = ReturnType<typeof agentRegistry.getAll>[number];

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

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildExportPrefix(env: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    parts.push(`export ${key}=${escapeShellArg(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') + '; ' : '';
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

const TUI_PROCESS_COMMAND_MARKERS = ['/dist/bin/discode.js tui', '/bin/discode.js tui', 'discode.js tui'];

function isDiscodeTuiProcess(command: string): boolean {
  return TUI_PROCESS_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

function listPanePids(target: string): number[] {
  try {
    const output = execSync(`tmux list-panes -t ${escapeShellArg(target)} -F "#{pane_pid}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    const pids = output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 1);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Fall through to direct PID signal.
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function terminateTmuxPaneProcesses(target: string): Promise<number> {
  const panePids = listPanePids(target);
  if (panePids.length === 0) return 0;

  for (const pid of panePids) {
    signalProcessTree(pid, 'SIGTERM');
  }

  await new Promise((resolve) => setTimeout(resolve, 250));

  let forcedKillCount = 0;
  for (const pid of panePids) {
    if (!isProcessRunning(pid)) continue;
    if (signalProcessTree(pid, 'SIGKILL')) {
      forcedKillCount += 1;
    }
  }
  return forcedKillCount;
}

function listActiveTmuxPaneTtys(): Set<string> {
  try {
    const output = execSync(`tmux list-panes -a -F "#{pane_tty}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return new Set(
      output
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('/dev/'))
    );
  } catch {
    return new Set();
  }
}

function cleanupStaleDiscodeTuiProcesses(): number {
  const activePaneTtys = listActiveTmuxPaneTtys();
  if (activePaneTtys.size === 0) return 0;

  let processTable = '';
  try {
    processTable = execSync('ps -axo pid=,ppid=,tty=,command=', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
  } catch {
    return 0;
  }

  type PsRow = {
    pid: number;
    ppid: number;
    tty: string | undefined;
    command: string;
  };

  const rows: PsRow[] = processTable
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const ttyRaw = match[3];
      const tty = ttyRaw === '?' ? undefined : ttyRaw.startsWith('/dev/') ? ttyRaw : `/dev/${ttyRaw}`;
      const command = match[4];
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return [];
      return [{ pid, ppid, tty, command }];
    });

  const tmuxPids = new Set(
    rows
      .filter((row) => row.command === 'tmux')
      .map((row) => row.pid)
  );
  if (tmuxPids.size === 0) return 0;

  let cleaned = 0;
  for (const row of rows) {
    if (!tmuxPids.has(row.ppid)) continue;
    if (!isDiscodeTuiProcess(row.command)) continue;
    if (row.tty && activePaneTtys.has(row.tty)) continue;

    if (signalProcessTree(row.pid, 'SIGTERM')) {
      cleaned += 1;
    }
  }
  return cleaned;
}

function ensureTmuxInstalled(): void {
  if (process.platform === 'win32') {
    console.error(chalk.red('tmux is required but not available on native Windows.'));
    console.log(chalk.gray('Use WSL, or run on macOS/Linux with tmux installed.'));
    process.exit(1);
  }

  try {
    execSync('tmux -V', { stdio: ['ignore', 'pipe', 'ignore'] });
    return;
  } catch {
    console.error(chalk.red('tmux is required but not installed (or not in PATH).'));
    console.log(chalk.gray('Install tmux and retry:'));
    if (process.platform === 'darwin') {
      console.log(chalk.gray('  brew install tmux'));
    } else {
      console.log(chalk.gray('  sudo apt-get install -y tmux   # Debian/Ubuntu'));
      console.log(chalk.gray('  sudo dnf install -y tmux       # Fedora/RHEL'));
    }
    process.exit(1);
  }
}

function applyTmuxCliOverrides(base: BridgeConfig, options: TmuxCliOptions): BridgeConfig {
  // NOTE: `config` comes from src/config via a Proxy (lazy getter). Do not spread it.
  // Access properties explicitly so the Proxy's `get` trap is used.
  const baseDiscord = base.discord;
  const baseTmux = base.tmux;
  const baseHookPort = base.hookServerPort;
  const baseDefaultAgentCli = base.defaultAgentCli;
  const baseOpencode = base.opencode;

  const sharedNameRaw = options?.tmuxSharedSessionName as string | undefined;

  return {
    discord: baseDiscord,
    hookServerPort: baseHookPort,
    defaultAgentCli: baseDefaultAgentCli,
    opencode: baseOpencode,
    tmux: {
      ...baseTmux,
      ...(sharedNameRaw !== undefined ? { sharedSessionName: sharedNameRaw } : {}),
    },
  };
}

function toSharedWindowName(projectName: string, agentType: string): string {
  const raw = `${projectName}-${agentType}`;
  const safe = raw
    .replace(/[:\n\r\t]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe.length > 0 ? safe : agentType;
}

function getEnabledAgentNames(project?: ProjectState): string[] {
  if (!project) return [];
  return listProjectAgentTypes(normalizeProjectState(project));
}

function resolveProjectWindowName(
  project: ProjectState,
  agentName: string,
  tmuxConfig: BridgeConfig['tmux'],
  instanceId?: string,
): string {
  const normalized = normalizeProjectState(project);
  const mapped =
    (instanceId ? getProjectInstance(normalized, instanceId)?.tmuxWindow : undefined) ||
    getPrimaryInstanceForAgent(normalized, agentName)?.tmuxWindow ||
    project.tmuxWindows?.[agentName];
  if (mapped && mapped.length > 0) return mapped;

  const sharedSession = `${tmuxConfig.sessionPrefix}${tmuxConfig.sharedSessionName || 'bridge'}`;
  if (project.tmuxSession === sharedSession) {
    const token = instanceId || agentName;
    return toSharedWindowName(project.projectName, token);
  }
  return instanceId || agentName;
}

function pruneStaleProjects(tmux: TmuxManager, tmuxConfig: BridgeConfig['tmux']): string[] {
  const removed: string[] = [];
  for (const project of stateManager.listProjects()) {
    const instances = listProjectInstances(project);
    if (instances.length === 0) {
      stateManager.removeProject(project.projectName);
      removed.push(project.projectName);
      continue;
    }

    const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
    const hasLiveWindow = sessionUp && instances.some((instance) => {
      const windowName = resolveProjectWindowName(project, instance.agentType, tmuxConfig, instance.instanceId);
      return tmux.windowExists(project.tmuxSession, windowName);
    });
    if (hasLiveWindow) continue;

    stateManager.removeProject(project.projectName);
    removed.push(project.projectName);
  }
  return removed;
}

function ensureProjectTuiPane(
  tmux: TmuxManager,
  sessionName: string,
  windowName: string,
  options: TmuxCliOptions,
): void {
  const discodeRunner = resolve(import.meta.dirname, './discode.js');
  const commandParts = ['bun', discodeRunner, 'tui'];
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

async function confirmYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  while (true) {
    const answer = (await prompt(question)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log(chalk.yellow('Please answer y(es) or n(o).'));
  }
}

function isInteractiveShell(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

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
  const running = await defaultDaemonManager.isRunning();
  if (!running) return;

  const port = defaultDaemonManager.getPort();
  console.log(chalk.gray('   Restarting bridge daemon to apply update...'));

  if (!defaultDaemonManager.stopDaemon()) {
    console.log(chalk.yellow('⚠️ Could not stop daemon automatically. Restart manually with: discode daemon stop && discode daemon start'));
    return;
  }

  const entryPoint = resolve(import.meta.dirname, '../src/daemon-entry.js');
  defaultDaemonManager.startDaemon(entryPoint);
  const ready = await defaultDaemonManager.waitForReady();
  if (ready) {
    console.log(chalk.green(`✅ Bridge daemon restarted (port ${port})`));
  } else {
    console.log(chalk.yellow(`⚠️ Daemon may not be ready yet. Check logs: ${defaultDaemonManager.getLogFile()}`));
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

async function ensureOpencodePermissionChoice(options: {
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

async function chooseDefaultAgentCli(installedAgents: RegisteredAgentAdapter[]): Promise<string | undefined> {
  if (installedAgents.length === 0) {
    console.log(chalk.yellow('⚠️ No installed AI CLI detected. Install one of: claude, codex, gemini, opencode.'));
    return undefined;
  }

  const configured = config.defaultAgentCli;
  const configuredIndex = configured
    ? installedAgents.findIndex((agent) => agent.config.name === configured)
    : -1;
  const defaultIndex = configuredIndex >= 0 ? configuredIndex : 0;

  if (!isInteractiveShell()) {
    const selected = installedAgents[defaultIndex];
    console.log(chalk.yellow(`⚠️ Non-interactive shell: default AI CLI set to ${selected.config.name}.`));
    return selected.config.name;
  }

  console.log(chalk.white('\nChoose default AI CLI'));
  installedAgents.forEach((agent, index) => {
    const marker = index === defaultIndex ? ' (default)' : '';
    console.log(chalk.gray(`   ${index + 1}. ${agent.config.displayName} (${agent.config.name})${marker}`));
  });

  while (true) {
    const answer = await prompt(chalk.white(`\nSelect default AI CLI [1-${installedAgents.length}] (Enter = default): `));
    if (!answer) {
      return installedAgents[defaultIndex].config.name;
    }

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < installedAgents.length) {
      return installedAgents[idx].config.name;
    }

    console.log(chalk.yellow('Please enter a valid number.'));
  }
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
} {
  const parts = raw.split(/\s+/).filter(Boolean);
  const attach = parts.includes('--attach');
  const values = parts.filter((item) => !item.startsWith('--'));
  const projectName = values[1];
  const agentName = values[2];
  return { projectName, agentName, attach };
}

async function tuiCommand(options: TmuxCliOptions): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const handler = async (command: string, append: (line: string) => void): Promise<boolean> => {
    if (command === '/exit' || command === '/quit') {
      append('Bye!');
      return true;
    }

    if (command === '/help') {
      append('Commands: /session_new [name] [agent] [--attach], /list, /projects, /help, /exit');
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
      const projectName = command.replace(/^\/?stop\s+/, '').trim();
      if (!projectName) {
        append('⚠️ Project name is required. Example: stop my-project');
        return false;
      }
      await stopCommand(projectName, {
        tmuxSharedSessionName: options.tmuxSharedSessionName,
      });
      append(`✅ Stopped project: ${projectName}`);
      return false;
    }

    if (command.startsWith('/session_new') || command.startsWith('/new')) {
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

        const parsed = parseSessionNew(command);
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
  if (startedFromTmux && !isTmuxPaneAlive(tmuxPaneTarget)) {
    console.log(chalk.yellow('⚠️ Stale tmux environment detected; skipping TUI startup to avoid orphaned process.'));
    return;
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
    new URL('../../dist/bin/tui.js', import.meta.url),
    new URL('../../bin/tui.tsx', import.meta.url),
  ];
  let mod: any;
  for (const candidate of sourceCandidates) {
    try {
      mod = await import(candidate.href);
      break;
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
          const channelCount = instances.filter((instance) => !!instance.discordChannelId).length;
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

async function onboardCommand(options: { token?: string }) {
  try {
    console.log(chalk.cyan('\n🚀 Discode Onboarding\n'));

    const existingToken = getConfigValue('token')?.trim();
    let token = options.token?.trim();
    if (!token) {
      if (existingToken) {
        if (isInteractiveShell()) {
          const maskedToken = `****${existingToken.slice(-4)}`;
          const reuseToken = await confirmYesNo(
            chalk.white(`Previously saved Discord bot token found (${maskedToken}). Use it? [Y/n]: `),
            true
          );
          if (reuseToken) {
            token = existingToken;
            console.log(chalk.green(`✅ Reusing saved bot token (${maskedToken})`));
          }
        } else {
          token = existingToken;
          console.log(chalk.yellow(`⚠️ Non-interactive shell: using previously saved bot token (****${existingToken.slice(-4)}).`));
        }
      }

      if (!token && !isInteractiveShell()) {
        console.error(chalk.red('Token is required in non-interactive mode.'));
        console.log(chalk.gray('Run: discode onboard --token YOUR_DISCORD_BOT_TOKEN'));
        process.exit(1);
      }

      if (!token) {
        token = await prompt(chalk.white('Discord bot token: '));
      }
      if (!token) {
        console.error(chalk.red('Bot token is required.'));
        process.exit(1);
      }
    }

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

      if (!isInteractiveShell()) {
        selectedGuild = guilds[0];
        console.log(chalk.yellow(`⚠️ Non-interactive shell: selecting first server ${selectedGuild.name} (${selectedGuild.id}).`));
      } else {
        const answer = await prompt(chalk.white(`\n   Select server [1-${guilds.length}]: `));
        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= guilds.length) {
          console.error(chalk.red('Invalid selection.'));
          await client.disconnect();
          process.exit(1);
        }
        selectedGuild = guilds[idx];
        console.log(chalk.green(`✅ Server selected: ${selectedGuild.name}`));
      }
    }

    stateManager.setGuildId(selectedGuild.id);
    saveConfig({ serverId: selectedGuild.id });

    const installedAgents = agentRegistry.getAll().filter(a => a.isInstalled());
    const defaultAgentCli = await chooseDefaultAgentCli(installedAgents);
    if (defaultAgentCli) {
      saveConfig({ defaultAgentCli });
      console.log(chalk.green(`✅ Default AI CLI saved: ${defaultAgentCli}`));
    }

    await ensureOpencodePermissionChoice({ shouldPrompt: true, forcePrompt: true });

    await client.disconnect();

    console.log(chalk.cyan('\n✨ Onboarding complete!\n'));
    console.log(chalk.white('Next step:'));
    console.log(chalk.gray('   cd <your-project>'));
    console.log(chalk.gray('   discode new\n'));
  } catch (error) {
    console.error(chalk.red('Onboarding failed:'), error);
    process.exit(1);
  }
}

async function startCommand(options: TmuxCliOptions & { project?: string; attach?: boolean }) {
  try {
    ensureTmuxInstalled();
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);

    const projects = stateManager.listProjects();

    if (projects.length === 0) {
      console.log(chalk.yellow('⚠️  No projects configured.'));
      console.log(chalk.gray('   Run `discode new` in a project directory first.'));
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
        const instances = listProjectInstances(project);
        const labels = instances.map((instance) => {
          const adapter = agentRegistry.get(instance.agentType);
          const display = adapter?.config.displayName || instance.agentType;
          return `${display}#${instance.instanceId}`;
        });

        console.log(chalk.green(`   ✓ ${project.projectName}`));
        console.log(chalk.gray(`     Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
        console.log(chalk.gray(`     Path: ${project.projectPath}`));
    }
    console.log('');

    const bridge = new AgentBridge({ config: effectiveConfig });

      // If --attach, start bridge in background and attach to tmux
    if (options.attach) {
      const project = activeProjects[0];
        const sessionName = project.tmuxSession;
        const firstInstance = listProjectInstances(project)[0];
        const windowName = firstInstance
          ? resolveProjectWindowName(project, firstInstance.agentType, effectiveConfig.tmux, firstInstance.instanceId)
          : undefined;
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

async function newCommand(
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

      // Determine agent
    let agentName: string;
    let activeInstanceId: string | undefined;
    let existingProject = stateManager.getProject(projectName);
    const requestedInstanceId = options.instance?.trim();

    if (agentArg) {
        // Explicitly specified
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
          // Reuse existing project's primary agent
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
        // Auto-detect installed agents
        const installed = agentRegistry.getAll().filter(a => a.isInstalled());
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
        const resumeInstance =
          existingRequestedInstance ||
          (activeInstanceId ? getProjectInstance(existingProject!, activeInstanceId) : undefined) ||
          getPrimaryInstanceForAgent(existingProject!, agentName);
        if (!resumeInstance) {
          console.error(chalk.red(`No instance found to resume for agent '${agentName}'.`));
          process.exit(1);
        }
        activeInstanceId = resumeInstance.instanceId;

        // Existing project: ensure tmux session exists (use stored full session name)
        const fullSessionName = existingProject.tmuxSession;
        const prefix = effectiveConfig.tmux.sessionPrefix;
        if (fullSessionName.startsWith(prefix)) {
          tmux.getOrCreateSession(fullSessionName.slice(prefix.length));
        }
        // Avoid setting AGENT_DISCORD_PROJECT on shared session env (ambiguous across windows).
        const sharedFull = `${prefix}${effectiveConfig.tmux.sharedSessionName || 'bridge'}`;
        const isSharedSession = fullSessionName === sharedFull;
        if (!isSharedSession) {
          tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PROJECT', projectName);
        }
        tmux.setSessionEnv(fullSessionName, 'AGENT_DISCORD_PORT', String(port));

        const resumeWindowName = resolveProjectWindowName(existingProject, resumeInstance.agentType, effectiveConfig.tmux, resumeInstance.instanceId);
        if (!tmux.windowExists(fullSessionName, resumeWindowName)) {
          const adapter = agentRegistry.get(resumeInstance.agentType);
          if (adapter) {
            let claudePluginDir: string | undefined;
            let hookEnabled = !!resumeInstance.eventHook;

            if (resumeInstance.agentType === 'opencode') {
              try {
                const pluginPath = installOpencodePlugin(existingProject.projectPath);
                hookEnabled = true;
                console.log(chalk.gray(`   Reinstalled OpenCode plugin: ${pluginPath}`));
              } catch (error) {
                console.log(chalk.yellow(`⚠️ Could not reinstall OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`));
              }
            }

            if (resumeInstance.agentType === 'claude') {
              try {
                claudePluginDir = installClaudePlugin(existingProject.projectPath);
                hookEnabled = true;
                console.log(chalk.gray(`   Reinstalled Claude Code plugin: ${claudePluginDir}`));
              } catch (error) {
                console.log(chalk.yellow(`⚠️ Could not reinstall Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`));
              }
            }

            if (resumeInstance.agentType === 'gemini') {
              try {
                const hookPath = installGeminiHook(existingProject.projectPath);
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
            let baseCommand = adapter.getStartCommand(existingProject.projectPath, permissionAllow);

            // Append --plugin-dir for Claude if plugin was installed.
            // Match `claude` as a shell command (after && or ; or at start), not inside a path.
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

            // Update instance hook state if changed
            if (hookEnabled && !resumeInstance.eventHook) {
              const normalizedProject = normalizeProjectState(existingProject);
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
        console.log(chalk.green(`✅ Existing project resumed`));
    }

      // Summary
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

async function configCommand(options: {
  show?: boolean;
  server?: string;
  token?: string;
  port?: string | number;
  defaultAgent?: string;
  opencodePermission?: 'allow' | 'default';
}) {
  if (options.show) {
      console.log(chalk.cyan('\n📋 Current configuration:\n'));
      console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
      console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId() || '(not set)'}`));
      console.log(chalk.gray(`   Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
      console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
      console.log(chalk.gray(`   Default AI CLI: ${config.defaultAgentCli || '(not set)'}`));
      console.log(chalk.gray(`   OpenCode Permission Mode: ${config.opencode?.permissionMode || '(not set)'}`));
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

  if (options.defaultAgent) {
    const normalized = options.defaultAgent.trim().toLowerCase();
    const adapter = agentRegistry.get(normalized);
    if (!adapter) {
      console.error(chalk.red(`Unknown agent: ${options.defaultAgent}`));
      console.log(chalk.gray(`Available agents: ${agentRegistry.getAll().map((a) => a.config.name).join(', ')}`));
      process.exit(1);
    }
    saveConfig({ defaultAgentCli: adapter.config.name });
    console.log(chalk.green(`✅ Default AI CLI saved: ${adapter.config.name}`));
    updated = true;
  }

  if (options.opencodePermission) {
    saveConfig({ opencodePermissionMode: options.opencodePermission });
    console.log(chalk.green(`✅ OpenCode permission mode saved: ${options.opencodePermission}`));
    updated = true;
  }

  if (!updated) {
    console.log(chalk.yellow('No options provided. Use --help to see available options.'));
    console.log(chalk.gray('\nExample:'));
    console.log(chalk.gray('  discode config --token YOUR_BOT_TOKEN'));
    console.log(chalk.gray('  discode config --server YOUR_SERVER_ID'));
    console.log(chalk.gray('  discode config --default-agent claude'));
    console.log(chalk.gray('  discode config --opencode-permission allow'));
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
      console.log(chalk.gray('   No projects configured. Run `discode new` in a project directory.'));
    } else {
      for (const project of projects) {
        const sessionActive = sessions.some(s => s.name === project.tmuxSession);
        const status = sessionActive ? chalk.green('● active') : chalk.gray('○ inactive');

        console.log(chalk.white(`   ${project.projectName}`), status);
        console.log(chalk.gray(`     Path: ${project.projectPath}`));

        const instances = listProjectInstances(project);
        const labels = instances.map((instance) => {
          const agentLabel = agentRegistry.get(instance.agentType)?.config.displayName || instance.agentType;
          return `${agentLabel}#${instance.instanceId}`;
        });
        console.log(chalk.gray(`     Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
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
      const instances = listProjectInstances(project);
      const labels = instances.map((instance) => {
        const agentLabel = agentRegistry.get(instance.agentType)?.config.displayName || instance.agentType;
        return `${agentLabel}#${instance.instanceId}`;
      });
      const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
      const windows = instances.map((instance) => ({
        instanceId: instance.instanceId,
        agentName: instance.agentType,
        windowName: resolveProjectWindowName(project, instance.agentType, config.tmux, instance.instanceId),
      }));
      const runningWindows = sessionUp
        ? windows.filter((window) => tmux.windowExists(project.tmuxSession, window.windowName))
        : [];
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
          console.log(chalk.gray(`    tmux(${window.instanceId}): ${project.tmuxSession}:${window.windowName}`));
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
  ensureTmuxInstalled();
  const effectiveConfig = applyTmuxCliOverrides(config, options);
    const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);

    if (!projectName) {
      // Use current directory name
      projectName = basename(process.cwd());
    }

    const project = stateManager.getProject(projectName);
    const sessionName = project?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
    const firstInstance = project ? listProjectInstances(project)[0] : undefined;
    const windowName =
      project && firstInstance
        ? resolveProjectWindowName(project, firstInstance.agentType, effectiveConfig.tmux, firstInstance.instanceId)
        : undefined;
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

    // 1. Kill tmux windows in shared session (legacy dedicated sessions are killed whole)
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
        console.log(chalk.gray(`   No active instances in state; not killing tmux windows`));
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

    // 2. Delete Discord channel (unless --keep-channel)
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

    // 3. Remove from state
    if (project) {
      stateManager.removeProject(projectName);
      console.log(chalk.green(`✅ Project removed from state`));
    }

    const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
    if (staleTuiCount > 0) {
      console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
    }

    // Note: daemon is global and shared, don't stop it here
    // Use `discode daemon stop` to stop the daemon

  console.log(chalk.cyan('\n✨ Done\n'));
}

function removePathIfExists(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

type PackageManager = 'npm' | 'bun';

function uninstallViaPackageManager(manager: PackageManager): boolean {
  const command = manager === 'npm'
    ? ['uninstall', '-g', '@siisee11/discode']
    : ['remove', '-g', '@siisee11/discode'];

  const result = spawnSync(manager, command, { stdio: 'inherit' });
  return !result.error && result.status === 0;
}

async function uninstallCommand(options: {
  purge?: boolean;
  yes?: boolean;
  skipPackageUninstall?: boolean;
}) {
  const shouldPurge = !!options.purge;
  const skipPackageUninstall = !!options.skipPackageUninstall;
  const isInteractive = isInteractiveShell();

  if (!options.yes && isInteractive) {
    const confirmed = await confirmYesNo(
      chalk.white('Uninstall Discode from this machine? [y/N]: '),
      false
    );
    if (!confirmed) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }

  console.log(chalk.cyan('\n🧹 Uninstalling Discode\n'));

  const running = await defaultDaemonManager.isRunning();
  if (running) {
    if (defaultDaemonManager.stopDaemon()) {
      console.log(chalk.green('✅ Daemon stopped'));
    } else {
      console.log(chalk.yellow('⚠️ Daemon appears running but could not be stopped automatically.'));
    }
  } else {
    console.log(chalk.gray('   Daemon not running'));
  }

  const localBinaryPath = join(homedir(), '.discode', 'bin', 'discode');
  if (removePathIfExists(localBinaryPath)) {
    console.log(chalk.green(`✅ Removed local binary: ${localBinaryPath}`));
  }

  if (shouldPurge) {
    const removedState = removePathIfExists(join(homedir(), '.discode'));
    const removedOpencodePlugin = removePathIfExists(join(homedir(), '.opencode', 'plugins', 'agent-opencode-bridge-plugin.ts'));
    const removedClaudePlugin = removePathIfExists(join(homedir(), '.claude', 'plugins', 'discode-claude-bridge'));
    const removedGeminiHook = removeGeminiHook();

    if (removedState) {
      console.log(chalk.green('✅ Removed ~/.discode (state/config/logs)'));
    }
    if (removedOpencodePlugin) {
      console.log(chalk.green('✅ Removed OpenCode bridge plugin'));
    }
    if (removedClaudePlugin) {
      console.log(chalk.green('✅ Removed Claude bridge plugin'));
    }
    if (removedGeminiHook) {
      console.log(chalk.green('✅ Removed Gemini bridge hook'));
    }
  }

  if (!skipPackageUninstall) {
    let packageUninstalled = false;

    if (hasCommand('npm')) {
      packageUninstalled = uninstallViaPackageManager('npm') || packageUninstalled;
    }
    if (hasCommand('bun')) {
      packageUninstalled = uninstallViaPackageManager('bun') || packageUninstalled;
    }

    if (packageUninstalled) {
      console.log(chalk.green('✅ Global package uninstall command completed'));
    } else {
      console.log(chalk.yellow('⚠️ Could not run global package uninstall automatically.'));
      console.log(chalk.gray('   Try one of:'));
      console.log(chalk.gray('   npm uninstall -g @siisee11/discode'));
      console.log(chalk.gray('   bun remove -g @siisee11/discode'));
    }
  }

  if (!shouldPurge) {
    console.log(chalk.gray('\nTip: use `discode uninstall --purge --yes` to remove config/state/plugins too.'));
  }

  console.log(chalk.cyan('\n✨ Uninstall complete\n'));
}

async function daemonCommand(action: string) {
  const port = defaultDaemonManager.getPort();

    switch (action) {
      case 'start': {
        ensureTmuxInstalled();
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
    .option('tmux-shared-session-name', {
      type: 'string',
      describe: 'shared tmux session name (without prefix)',
    });
}

const rawArgs = hideBin(process.argv);
await maybePromptForUpgrade(rawArgs);

await yargs(rawArgs)
  .scriptName('discode')
  .usage('$0 [command]')
  .version(CLI_VERSION)
  .help()
  .strict()
  .command(
    ['$0', 'tui'],
    'Interactive terminal UI (supports /session_new)',
    (y: Argv) => addTmuxOptions(y),
    async (argv: any) =>
      tuiCommand({
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'onboard',
    'One-time onboarding: save token, choose default AI CLI, configure OpenCode permission',
    (y: Argv) => y.option('token', { alias: 't', type: 'string', describe: 'Discord bot token (optional; prompt if omitted)' }),
    async (argv: any) => onboardCommand({ token: argv.token })
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
      .positional('agent', { type: 'string', describe: 'Agent to use (claude, codex, gemini, opencode)' })
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
    'Configure Discord bridge settings',
    (y: Argv) => y
      .option('server', { alias: 's', type: 'string', describe: 'Set Discord server ID' })
      .option('token', { alias: 't', type: 'string', describe: 'Set Discord bot token' })
      .option('port', { alias: 'p', type: 'string', describe: 'Set hook server port' })
      .option('default-agent', { type: 'string', describe: 'Set default AI CLI for `discode new`' })
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
        port: argv.port,
        defaultAgent: argv.defaultAgent,
        opencodePermission: argv.opencodePermission,
      })
  )
  .command(
    'status',
    'Show bridge and project status',
    (y: Argv) => addTmuxOptions(y),
    (argv: any) =>
      statusCommand({
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
        tmuxSharedSessionName: argv.tmuxSharedSessionName,
      })
  )
  .command(
    'daemon <action>',
    'Manage the global bridge daemon (start|stop|status)',
    (y: Argv) => y.positional('action', { type: 'string', demandOption: true }),
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
