import { basename } from 'path';
import { execSync, spawnSync } from 'child_process';
import { request as httpRequest } from 'http';
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
import { RuntimeStreamClient, getDefaultRuntimeSocketPath } from '../common/runtime-stream-client.js';
import { attachCommand } from './attach.js';
import { newCommand } from './new.js';
import { stopCommand } from './stop.js';
import { renderTerminalSnapshot } from '../../capture/parser.js';
import type { TerminalStyledLine } from '../../runtime/vt-screen.js';

type RuntimeWindowPayload = {
  windowId: string;
  sessionName: string;
  windowName: string;
  status?: string;
  pid?: number;
};

type RuntimeWindowsPayload = {
  activeWindowId?: string;
  windows: RuntimeWindowPayload[];
};

type RuntimeBufferPayload = {
  windowId: string;
  since: number;
  next: number;
  chunk: string;
};

type HttpJsonResult = {
  status: number;
  body: string;
};

type RuntimeTransportStatus = {
  mode: 'stream' | 'http-fallback';
  connected: boolean;
  fallback: boolean;
  detail: string;
  lastError?: string;
};

function requestRuntimeApi(params: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  payload?: unknown;
}): Promise<HttpJsonResult> {
  return new Promise((resolve, reject) => {
    const body = params.payload === undefined ? '' : JSON.stringify(params.payload);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: params.port,
        path: params.path,
        method: params.method,
        headers: params.method === 'POST'
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          }
          : undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: data });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('Runtime API request timeout'));
    });
    if (params.method === 'POST') {
      req.write(body);
    }
    req.end();
  });
}

function parseRuntimeWindowsPayload(raw: string): RuntimeWindowsPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeWindowsPayload>;
    if (!Array.isArray(parsed.windows)) return null;
    const windows = parsed.windows
      .filter((item): item is RuntimeWindowPayload => {
        if (!item || typeof item !== 'object') return false;
        const event = item as Record<string, unknown>;
        return typeof event.windowId === 'string' && typeof event.sessionName === 'string' && typeof event.windowName === 'string';
      })
      .map((item) => ({
        windowId: item.windowId,
        sessionName: item.sessionName,
        windowName: item.windowName,
        status: item.status,
        pid: item.pid,
      }));

    return {
      activeWindowId: typeof parsed.activeWindowId === 'string' ? parsed.activeWindowId : undefined,
      windows,
    };
  } catch {
    return null;
  }
}

function parseRuntimeBufferPayload(raw: string): RuntimeBufferPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeBufferPayload>;
    if (typeof parsed.windowId !== 'string') return null;
    if (typeof parsed.since !== 'number') return null;
    if (typeof parsed.next !== 'number') return null;
    if (typeof parsed.chunk !== 'string') return null;
    return {
      windowId: parsed.windowId,
      since: parsed.since,
      next: parsed.next,
      chunk: parsed.chunk,
    };
  } catch {
    return null;
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

function reloadStateFromDisk(): void {
  stateManager.reload();
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

function handoffToBunRuntime(): never {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
  }

  const result = spawnSync('bun', [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DISCODE_TUI_BUN_HANDOFF: '1',
    },
  });

  if (result.error) {
    throw new Error('TUI requires Bun runtime and could not auto-run Bun. Ensure `bun` is on PATH.');
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

export async function tuiCommand(options: TmuxCliOptions): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const runtimePort = effectiveConfig.hookServerPort || 18470;
  let keepChannelOnStop = getConfigValue('keepChannelOnStop') === true;
  let runtimeSupported: boolean | undefined;
  let runtimeWindowsCache: RuntimeWindowsPayload | null = null;
  let transportStatus: RuntimeTransportStatus = {
    mode: 'http-fallback',
    connected: false,
    fallback: true,
    detail: 'stream unavailable',
  };
  const runtimeBufferOffsets = new Map<string, number>();
  const runtimeBufferCache = new Map<string, string>();
  const runtimeFrameCache = new Map<string, string>();
  const runtimeFrameLines = new Map<string, string[]>();
  const runtimeStyledCache = new Map<string, TerminalStyledLine[]>();
  const runtimeFrameListeners = new Set<(frame: { sessionName: string; windowName: string; output: string; styled?: TerminalStyledLine[] }) => void>();
  const streamSubscriptions = new Map<string, { cols: number; rows: number; subscribedAt: number }>();

  const setTransportStatus = (next: Partial<RuntimeTransportStatus>) => {
    transportStatus = {
      ...transportStatus,
      ...next,
    };
  };

  const splitWindowId = (windowId: string): { sessionName: string; windowName: string } | null => {
    const idx = windowId.indexOf(':');
    if (idx <= 0 || idx >= windowId.length - 1) return null;
    return {
      sessionName: windowId.slice(0, idx),
      windowName: windowId.slice(idx + 1),
    };
  };

  let runtimeStreamConnected = false;
  const streamClient = new RuntimeStreamClient(getDefaultRuntimeSocketPath(), {
    onFrame: (frame) => {
      const output = frame.lines.join('\n');
      runtimeFrameLines.set(frame.windowId, frame.lines.slice());
      runtimeFrameCache.set(frame.windowId, output);
      runtimeStyledCache.delete(frame.windowId);
      const parsed = splitWindowId(frame.windowId);
      if (parsed) {
        for (const listener of runtimeFrameListeners) {
          listener({
            sessionName: parsed.sessionName,
            windowName: parsed.windowName,
            output,
            styled: undefined,
          });
        }
      }
      runtimeSupported = true;
    },
    onFrameStyled: (frame) => {
      const output = frame.lines
        .map((line) => line.segments.map((seg) => seg.text).join(''))
        .join('\n');
      runtimeFrameCache.set(frame.windowId, output);
      runtimeStyledCache.set(frame.windowId, frame.lines);
      const parsed = splitWindowId(frame.windowId);
      if (parsed) {
        for (const listener of runtimeFrameListeners) {
          listener({
            sessionName: parsed.sessionName,
            windowName: parsed.windowName,
            output,
            styled: frame.lines,
          });
        }
      }
      runtimeSupported = true;
    },
    onPatchStyled: (patch) => {
      const current = runtimeStyledCache.get(patch.windowId) || [];
      const next = current.slice(0, patch.lineCount).map((line) => ({
        segments: line.segments.map((seg) => ({
          text: seg.text,
          fg: seg.fg,
          bg: seg.bg,
          bold: seg.bold,
          italic: seg.italic,
          underline: seg.underline,
        })),
      }));
      while (next.length < patch.lineCount) {
        next.push({
          segments: [{
            text: '',
            fg: undefined,
            bg: undefined,
            bold: undefined,
            italic: undefined,
            underline: undefined,
          }],
        });
      }

      for (const op of patch.ops) {
        if (op.index >= 0 && op.index < patch.lineCount) {
          next[op.index] = {
            segments: op.line.segments.map((seg) => ({
              text: seg.text,
              fg: seg.fg,
              bg: seg.bg,
              bold: seg.bold,
              italic: seg.italic,
              underline: seg.underline,
            })),
          };
        }
      }

      const output = next
        .map((line) => line.segments.map((seg) => seg.text).join(''))
        .join('\n');
      runtimeFrameCache.set(patch.windowId, output);
      runtimeStyledCache.set(patch.windowId, next);

      const parsed = splitWindowId(patch.windowId);
      if (parsed) {
        for (const listener of runtimeFrameListeners) {
          listener({
            sessionName: parsed.sessionName,
            windowName: parsed.windowName,
            output,
            styled: next,
          });
        }
      }
      runtimeSupported = true;
    },
    onPatch: (patch) => {
      const current = runtimeFrameLines.get(patch.windowId) || [];
      const next = current.slice(0, patch.lineCount);
      while (next.length < patch.lineCount) next.push('');
      for (const op of patch.ops) {
        if (op.index >= 0 && op.index < patch.lineCount) {
          next[op.index] = op.line;
        }
      }

      const output = next.join('\n');
      runtimeFrameLines.set(patch.windowId, next);
      runtimeFrameCache.set(patch.windowId, output);
      runtimeStyledCache.delete(patch.windowId);

      const parsed = splitWindowId(patch.windowId);
      if (parsed) {
        for (const listener of runtimeFrameListeners) {
          listener({
            sessionName: parsed.sessionName,
            windowName: parsed.windowName,
            output,
            styled: undefined,
          });
        }
      }
      runtimeSupported = true;
    },
    onWindowExit: (event) => {
      runtimeFrameCache.delete(event.windowId);
      runtimeFrameLines.delete(event.windowId);
      runtimeStyledCache.delete(event.windowId);
      streamSubscriptions.delete(event.windowId);
      const parsed = splitWindowId(event.windowId);
      if (parsed) {
        for (const listener of runtimeFrameListeners) {
          listener({
            sessionName: parsed.sessionName,
            windowName: parsed.windowName,
            output: '',
            styled: undefined,
          });
        }
      }
      setTransportStatus({
        mode: 'stream',
        connected: true,
        fallback: false,
        detail: `window exited: ${event.windowId}`,
      });
    },
    onError: (message) => {
      setTransportStatus({
        mode: 'http-fallback',
        connected: false,
        fallback: true,
        detail: 'stream error, using fallback',
        lastError: message,
      });
    },
    onStateChange: (state) => {
      if (state === 'connected') {
        runtimeStreamConnected = true;
        streamSubscriptions.clear();
        setTransportStatus({
          mode: 'stream',
          connected: true,
          fallback: false,
          detail: 'stream connected',
        });
      } else {
        runtimeStreamConnected = false;
        streamSubscriptions.clear();
        setTransportStatus({
          mode: 'http-fallback',
          connected: false,
          fallback: true,
          detail: 'stream disconnected, using fallback',
        });
      }
    },
  });
  runtimeStreamConnected = await streamClient.connect();
  if (runtimeStreamConnected) {
    setTransportStatus({
      mode: 'stream',
      connected: true,
      fallback: false,
      detail: 'stream connected',
    });
  }
  let lastStreamConnectAttemptAt = Date.now();

  const ensureStreamConnected = async (): Promise<boolean> => {
    if (runtimeStreamConnected && streamClient.isConnected()) {
      return true;
    }
    const now = Date.now();
    if (now - lastStreamConnectAttemptAt < 1000) {
      return runtimeStreamConnected;
    }
    lastStreamConnectAttemptAt = now;
    runtimeStreamConnected = await streamClient.connect().catch(() => false);
    if (runtimeStreamConnected) {
      setTransportStatus({
        mode: 'stream',
        connected: true,
        fallback: false,
        detail: 'stream connected',
      });
    } else {
      setTransportStatus({
        mode: 'http-fallback',
        connected: false,
        fallback: true,
        detail: 'stream unavailable, using fallback',
      });
    }
    return runtimeStreamConnected;
  };

  const ensureStreamSubscribed = (windowId: string, width?: number, height?: number): void => {
    if (!runtimeStreamConnected) return;
    const cols = Math.max(30, Math.min(240, Math.floor(width || 120)));
    const rows = Math.max(10, Math.min(120, Math.floor(height || 40)));
    const prev = streamSubscriptions.get(windowId);
    if (prev && prev.cols === cols && prev.rows === rows) return;
    streamClient.subscribe(windowId, cols, rows);
    streamSubscriptions.set(windowId, { cols, rows, subscribedAt: Date.now() });
  };

  const fetchRuntimeWindows = async (): Promise<RuntimeWindowsPayload | null> => {
    try {
      const result = await requestRuntimeApi({
        port: runtimePort,
        method: 'GET',
        path: '/runtime/windows',
      });

      if (result.status === 200) {
        const payload = parseRuntimeWindowsPayload(result.body);
        runtimeSupported = !!payload;
        runtimeWindowsCache = payload;
        return payload;
      }

      if (result.status === 501 || result.status === 404 || result.status === 405) {
        runtimeSupported = false;
        runtimeWindowsCache = null;
        return null;
      }

      return runtimeWindowsCache;
    } catch {
      return runtimeWindowsCache;
    }
  };

  const focusRuntimeWindow = async (windowId: string): Promise<boolean> => {
    if (runtimeStreamConnected) {
      streamClient.focus(windowId);
    }

    try {
      const result = await requestRuntimeApi({
        port: runtimePort,
        method: 'POST',
        path: '/runtime/focus',
        payload: { windowId },
      });
      if (result.status === 200) {
        if (!runtimeWindowsCache || !runtimeWindowsCache.windows.some((item) => item.windowId === windowId)) {
          await fetchRuntimeWindows();
        }
        if (runtimeWindowsCache) {
          runtimeWindowsCache.activeWindowId = windowId;
        }
        runtimeSupported = true;
        return true;
      }
      if (result.status === 501 || result.status === 404 || result.status === 405) {
        runtimeSupported = false;
      }
      if (result.status === 0 && runtimeStreamConnected) {
        return true;
      }
      return false;
    } catch {
      return runtimeStreamConnected;
    }
  };

  const resolveRuntimeWindowForProject = (projectName: string): { windowId: string; sessionName: string; windowName: string } | null => {
    const project = stateManager.getProject(projectName);
    if (!project) return null;
    const instances = listProjectInstances(project);
    const firstInstance = instances[0];
    if (!firstInstance) return null;
    const windowName = resolveProjectWindowName(project, firstInstance.agentType, effectiveConfig.tmux, firstInstance.instanceId);
    return {
      windowId: `${project.tmuxSession}:${windowName}`,
      sessionName: project.tmuxSession,
      windowName,
    };
  };

  const parseWindowId = (windowId: string | undefined): { sessionName: string; windowName: string } | null => {
    if (!windowId) return null;
    return splitWindowId(windowId);
  };

  const readRuntimeWindowOutput = async (
    sessionName: string,
    windowName: string,
    width?: number,
    height?: number,
  ): Promise<string | undefined> => {
    await ensureStreamConnected();

    if (runtimeSupported === false) {
      return undefined;
    }

    const windowId = `${sessionName}:${windowName}`;

    if (runtimeStreamConnected) {
      ensureStreamSubscribed(windowId, width, height);
      const frame = runtimeFrameCache.get(windowId);
      if (frame !== undefined) {
        setTransportStatus({
          mode: 'stream',
          connected: true,
          fallback: false,
          detail: 'stream live',
        });
        return frame;
      }

      const subscribed = streamSubscriptions.get(windowId);
      if (subscribed && Date.now() - subscribed.subscribedAt < 1500) {
        // Stream-first path: avoid immediate HTTP fallback while waiting
        // for first pushed frame after subscribe/reconnect.
        return undefined;
      }
    }

    const since = runtimeBufferOffsets.get(windowId) || 0;
    try {
      const path = `/runtime/buffer?windowId=${encodeURIComponent(windowId)}&since=${since}`;
      const result = await requestRuntimeApi({
        port: runtimePort,
        method: 'GET',
        path,
      });

      if (result.status !== 200) {
        if (result.status === 501 || result.status === 404 || result.status === 405) {
          runtimeSupported = false;
          return undefined;
        }
        setTransportStatus({
          mode: 'http-fallback',
          connected: false,
          fallback: true,
          detail: `fallback buffer read (status ${result.status})`,
        });
        return runtimeBufferCache.get(windowId);
      }

      const payload = parseRuntimeBufferPayload(result.body);
      if (!payload) return runtimeBufferCache.get(windowId);

      const nextOutput = `${runtimeBufferCache.get(windowId) || ''}${payload.chunk}`;
      const trimmed = nextOutput.length > 32768 ? nextOutput.slice(nextOutput.length - 32768) : nextOutput;
      runtimeBufferCache.set(windowId, trimmed);
      runtimeBufferOffsets.set(windowId, payload.next);
      runtimeSupported = true;
      setTransportStatus({
        mode: 'http-fallback',
        connected: false,
        fallback: true,
        detail: 'fallback buffer read',
      });
      return renderTerminalSnapshot(trimmed, { width, height });
    } catch {
      const raw = runtimeBufferCache.get(windowId);
      setTransportStatus({
        mode: 'http-fallback',
        connected: false,
        fallback: true,
        detail: 'fallback buffer cache',
      });
      return raw ? renderTerminalSnapshot(raw, { width, height }) : raw;
    }
  };

  const sendRuntimeRawKey = async (sessionName: string, windowName: string, raw: string): Promise<void> => {
    await ensureStreamConnected();

    if (!raw || runtimeSupported === false) return;
    const windowId = `${sessionName}:${windowName}`;
    if (runtimeStreamConnected) {
      streamClient.input(windowId, Buffer.from(raw, 'latin1'));
      setTransportStatus({
        mode: 'stream',
        connected: true,
        fallback: false,
        detail: 'stream input',
      });
      return;
    }
    await requestRuntimeApi({
      port: runtimePort,
      method: 'POST',
      path: '/runtime/input',
      payload: {
        windowId,
        text: raw,
        submit: false,
      },
    }).catch(() => ({ status: 0, body: '' }));
    setTransportStatus({
      mode: 'http-fallback',
      connected: false,
      fallback: true,
      detail: 'fallback input',
    });
  };

  const sendRuntimeResize = async (sessionName: string, windowName: string, width: number, height: number): Promise<void> => {
    await ensureStreamConnected();
    if (!runtimeStreamConnected) return;
    const windowId = `${sessionName}:${windowName}`;
    streamClient.resize(windowId, width, height);
    ensureStreamSubscribed(windowId, width, height);
  };

  const registerRuntimeFrameListener = (listener: (frame: { sessionName: string; windowName: string; output: string; styled?: TerminalStyledLine[] }) => void): (() => void) => {
    runtimeFrameListeners.add(listener);
    return () => {
      runtimeFrameListeners.delete(listener);
    };
  };

  const handler = async (command: string, append: (line: string) => void): Promise<boolean> => {
    if (command === '/exit' || command === '/quit') {
      append('Bye!');
      return true;
    }

    if (command === '/help') {
      append('Commands: /new [name] [agent] [--instance id] [--attach], /list, /projects, /config [keepChannel [on|off|toggle] | defaultAgent [agent|auto] | defaultChannel [channelId|auto]], /help, /exit');
      return false;
    }

    if (command === '/config' || command === 'config') {
      append(`keepChannel: ${keepChannelOnStop ? 'on' : 'off'}`);
      append(`defaultAgent: ${config.defaultAgentCli || '(auto)'}`);
      append(`defaultChannel: ${config.discord.channelId || '(auto)'}`);
      append('Usage: /config keepChannel [on|off|toggle]');
      append('Usage: /config defaultAgent [agent|auto]');
      append('Usage: /config defaultChannel [channelId|auto]');
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

      if (key === 'defaultchannel' || key === 'default-channel' || key === 'channel') {
        const value = (parts[2] || '').trim();
        const lowered = value.toLowerCase();
        if (!value) {
          append(`defaultChannel: ${config.discord.channelId || '(auto)'}`);
          append('Use: /config defaultChannel [channelId|auto]');
          return false;
        }

        if (lowered === 'auto' || lowered === 'clear' || lowered === 'unset') {
          try {
            saveConfig({ channelId: undefined });
            append('✅ defaultChannel is now auto (per-project channel).');
          } catch (error) {
            append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
          }
          return false;
        }

        const normalized = value.replace(/^<#(\d+)>$/, '$1');
        try {
          saveConfig({ channelId: normalized });
          append(`✅ defaultChannel is now ${normalized}`);
        } catch (error) {
          append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
      }

      if (key !== 'keepchannel' && key !== 'keep-channel') {
        append(`⚠️ Unknown config key: ${parts[1] || '(empty)'}`);
        append('Supported keys: keepChannel, defaultAgent, defaultChannel');
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
      reloadStateFromDisk();
      const runtimeWindows = await fetchRuntimeWindows();
      if (runtimeWindows && runtimeWindows.windows.length > 0) {
        const sessions = new Map<string, number>();
        for (const window of runtimeWindows.windows) {
          sessions.set(window.sessionName, (sessions.get(window.sessionName) || 0) + 1);
        }
        [...sessions.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([sessionName, count]) => {
            append(`[session] ${sessionName} (${count} windows)`);
          });
        return false;
      }

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
      reloadStateFromDisk();
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
        reloadStateFromDisk();
        validateConfig();
        if (!stateManager.getGuildId()) {
          append('⚠️ Not set up yet. Run: discode onboard');
          return false;
        }

        const installed = agentRegistry.getAll().filter((agent) => agent.isInstalled());
        if (installed.length === 0) {
          append('⚠️ No agent CLIs found. Install one first (claude, gemini, opencode).');
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
          append(`⚠️ Unknown agent '${parsed.agentName}'. Try claude, gemini, or opencode.`);
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

    if (runtimeSupported !== false) {
      const focusedWindowId = runtimeWindowsCache?.activeWindowId;
      if (focusedWindowId) {
        if (runtimeStreamConnected) {
          streamClient.input(focusedWindowId, Buffer.from(`${command}\r`, 'latin1'));
          setTransportStatus({
            mode: 'stream',
            connected: true,
            fallback: false,
            detail: 'stream input',
          });
          append(`→ sent to ${focusedWindowId}`);
          return false;
        }

        const sent = await requestRuntimeApi({
          port: runtimePort,
          method: 'POST',
          path: '/runtime/input',
          payload: {
            windowId: focusedWindowId,
            text: command,
            submit: true,
          },
        }).catch(() => ({ status: 0, body: '' }));

        if (sent.status === 200) {
          setTransportStatus({
            mode: 'http-fallback',
            connected: false,
            fallback: true,
            detail: 'fallback input',
          });
          append(`→ sent to ${focusedWindowId}`);
          return false;
        }
      }
    }

    append(`Unknown command: ${command}`);
    append('Try /help (or focus a runtime window to send direct input)');
    return false;
  };

  const isBunRuntime = Boolean((process as { versions?: { bun?: string } }).versions?.bun);
  if (!isBunRuntime) {
    if (process.env.DISCODE_TUI_BUN_HANDOFF === '1') {
      throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
    }
    handoffToBunRuntime();
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
  const runtimeAtStartup = await fetchRuntimeWindows();
  const runtimeActiveAtStartup = parseWindowId(runtimeAtStartup?.activeWindowId);
  const currentSession = runtimeActiveAtStartup?.sessionName || tmux.getCurrentSession(process.env.TMUX_PANE);
  const currentWindow = runtimeActiveAtStartup?.windowName || tmux.getCurrentWindow(process.env.TMUX_PANE);

  const sourceCandidates = [
    new URL('./tui.js', import.meta.url),
    new URL('./tui.tsx', import.meta.url),
    new URL('../../bin/tui.tsx', import.meta.url),
    new URL('../../../dist/bin/tui.js', import.meta.url),
    new URL('../../../bin/tui.tsx', import.meta.url),
  ];
  let mod: any;
  let lastImportError: unknown;
  for (const candidate of sourceCandidates) {
    const candidatePath = fileURLToPath(candidate);
    if (!existsSync(candidatePath)) continue;
    try {
      const loaded = await import(candidate.href);
      if (loaded && typeof loaded.runTui === 'function') {
        mod = loaded;
        break;
      }
    } catch (error) {
      lastImportError = error;
      // Try next candidate.
    }
  }
  if (!mod) {
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);
    const suffix = lastImportError instanceof Error ? ` (last import error: ${lastImportError.message})` : '';
    throw new Error(`OpenTUI entry not found: bin/tui.tsx or dist/bin/tui.js${suffix}`);
  }

  try {
    await mod.runTui({
      currentSession: currentSession || undefined,
      currentWindow: currentWindow || undefined,
      onCommand: handler,
      onAttachProject: async (project: string) => {
        reloadStateFromDisk();
        const runtimeTarget = resolveRuntimeWindowForProject(project);
        if (runtimeTarget && runtimeSupported !== false) {
          const focused = await focusRuntimeWindow(runtimeTarget.windowId);
          if (focused) {
            return {
              currentSession: runtimeTarget.sessionName,
              currentWindow: runtimeTarget.windowName,
            };
          }
        }
        if (effectiveConfig.runtimeMode === 'pty') {
          return runtimeTarget
            ? {
              currentSession: runtimeTarget.sessionName,
              currentWindow: runtimeTarget.windowName,
            }
            : undefined;
        }
        await attachCommand(project, {
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
        if (!runtimeTarget) return;
        return {
          currentSession: runtimeTarget.sessionName,
          currentWindow: runtimeTarget.windowName,
        };
      },
      onStopProject: async (project: string) => {
        await stopCommand(project, {
          keepChannel: keepChannelOnStop,
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
      },
      getProjects: async () => {
        reloadStateFromDisk();
        const runtimeWindows = await fetchRuntimeWindows();
        const runtimeSet = new Set(
          (runtimeWindows?.windows || []).map((window) => `${window.sessionName}:${window.windowName}`),
        );

        return stateManager.listProjects().map((project) => {
          const instances = listProjectInstances(project);
          const agentNames = getEnabledAgentNames(project);
          const labels = agentNames.map((agentName) => agentRegistry.get(agentName)?.config.displayName || agentName);
          const primaryInstance = instances[0];
          const window = primaryInstance
            ? resolveProjectWindowName(project, primaryInstance.agentType, effectiveConfig.tmux, primaryInstance.instanceId)
            : '(none)';
          const channelCount = instances.filter((instance) => !!instance.channelId).length;
          const channelBase = channelCount > 0 ? `${channelCount} channel(s)` : 'not connected';
          const windowUp = runtimeWindows
            ? instances.some((instance) => {
              const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
              return runtimeSet.has(`${project.tmuxSession}:${name}`);
            })
            : (() => {
              const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
              return sessionUp && instances.some((instance) => {
                const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
                return tmux.windowExists(project.tmuxSession, name);
              });
            })();

          return {
            project: project.projectName,
            session: project.tmuxSession,
            window,
            ai: labels.length > 0 ? labels.join(', ') : 'none',
            channel: channelBase,
            open: windowUp,
          };
        });
      },
      getCurrentWindowOutput: async (sessionName: string, windowName: string, width?: number, height?: number) => {
        return readRuntimeWindowOutput(sessionName, windowName, width, height);
      },
      onRuntimeKey: async (sessionName: string, windowName: string, raw: string) => {
        await sendRuntimeRawKey(sessionName, windowName, raw);
      },
      onRuntimeResize: async (sessionName: string, windowName: string, width: number, height: number) => {
        await sendRuntimeResize(sessionName, windowName, width, height);
      },
      onRuntimeFrame: (listener: (frame: { sessionName: string; windowName: string; output: string; styled?: TerminalStyledLine[] }) => void) => {
        return registerRuntimeFrameListener(listener);
      },
      getRuntimeStatus: async () => {
        await ensureStreamConnected();
        return {
          mode: transportStatus.mode,
          connected: transportStatus.connected,
          fallback: transportStatus.fallback,
          detail: transportStatus.detail,
          lastError: transportStatus.lastError,
        };
      },
    });
  } finally {
    streamClient.disconnect();
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);
  }
}
