/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */

import { InputRenderable, RGBA, TextAttributes, TextareaRenderable } from '@opentui/core';
import { render, useKeyboard, usePaste, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/solid';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { copyTextToClipboard, readTextFromClipboard } from '../src/cli/common/clipboard.js';
import type { TerminalSegment, TerminalStyledLine } from '../src/runtime/vt-screen.js';

declare const DISCODE_VERSION: string | undefined;

function resolveTuiVersion(): string {
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

const TUI_VERSION = resolveTuiVersion();
const TUI_VERSION_LABEL = TUI_VERSION.startsWith('v') ? TUI_VERSION : `v${TUI_VERSION}`;
const PREFIX_KEY_NAME = 'b';
const PREFIX_LABEL = 'Ctrl+b';
const DEBUG_SELECTION = process.env.DISCODE_TUI_DEBUG_SELECTION === '1';

type TuiInput = {
  currentSession?: string;
  currentWindow?: string;
  initialCommand?: string;
  onCommand: (command: string, append: (line: string) => void) => Promise<boolean | void>;
  onStopProject: (project: string) => Promise<void>;
  onAttachProject: (project: string) => Promise<{ currentSession?: string; currentWindow?: string } | void>;
  onRuntimeKey?: (sessionName: string, windowName: string, raw: string) => Promise<void>;
  onRuntimeResize?: (sessionName: string, windowName: string, width: number, height: number) => Promise<void> | void;
  onRuntimeFrame?: (listener: (frame: {
    sessionName: string;
    windowName: string;
    output: string;
    styled?: TerminalStyledLine[];
    cursorRow?: number;
    cursorCol?: number;
  }) => void) => () => void;
  getRuntimeStatus?: () =>
    | {
      mode: 'stream';
      connected: boolean;
      detail: string;
      lastError?: string;
    }
    | Promise<{
      mode: 'stream';
      connected: boolean;
      detail: string;
      lastError?: string;
    }>;
  getCurrentWindowOutput?: (sessionName: string, windowName: string, width?: number, height?: number) => Promise<string | undefined>;
  getProjects: () =>
    | Array<{
      project: string;
      session: string;
      window: string;
      ai: string;
      channel: string;
      open: boolean;
    }>
    | Promise<Array<{
    project: string;
    session: string;
    window: string;
    ai: string;
    channel: string;
    open: boolean;
    }>>;
};

const palette = {
  bg: '#0a0a0a',
  panel: '#141414',
  border: '#484848',
  focus: '#4caf50',
  text: '#eeeeee',
  muted: '#9a9a9a',
  primary: '#fab283',
  selectedBg: '#2b2b2b',
  selectedFg: '#ffffff',
};

const slashCommands = [
  { command: '/new', description: 'create new session' },
  { command: '/onboard', description: 'run onboarding inside TUI' },
  { command: '/list', description: 'show current session list' },
  { command: '/stop', description: 'select and stop a project' },
  { command: '/projects', description: 'list configured projects' },
  { command: '/config', description: 'manage keepChannel/defaultAgent/defaultChannel/runtimeMode' },
  { command: '/help', description: 'show available commands' },
  { command: '/exit', description: 'close the TUI' },
  { command: '/quit', description: 'close the TUI' },
];

const paletteCommands = [
  { command: '/new', description: 'Create a new session' },
  { command: '/onboard', description: 'Run onboarding inside TUI' },
  { command: '/list', description: 'Show current session list' },
  { command: '/stop', description: 'Select and stop a project' },
  { command: '/projects', description: 'List configured projects' },
  { command: '/config', description: 'Manage keepChannel/defaultAgent/defaultChannel/runtimeMode' },
  { command: '/help', description: 'Show help' },
  { command: '/exit', description: 'Exit TUI' },
  { command: '/quit', description: 'Exit TUI' },
];

type TerminalCursor = {
  row: number;
  col: number;
};

type StyledCell = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

function toStyledCells(line: TerminalStyledLine): StyledCell[] {
  const cells: StyledCell[] = [];
  for (const segment of line.segments) {
    const chars = Array.from(segment.text);
    for (const ch of chars) {
      cells.push({
        text: ch,
        fg: segment.fg,
        bg: segment.bg,
        bold: segment.bold,
        italic: segment.italic,
        underline: segment.underline,
      });
    }
  }
  return cells;
}

function toStyledLine(cells: StyledCell[]): TerminalStyledLine {
  if (cells.length === 0) return { segments: [{ text: ' ' }] };

  const segments: TerminalSegment[] = [];
  let current: TerminalSegment | null = null;

  for (const cell of cells) {
    if (!current || current.fg !== cell.fg || current.bg !== cell.bg || current.bold !== cell.bold || current.italic !== cell.italic || current.underline !== cell.underline) {
      if (current) segments.push(current);
      current = {
        text: cell.text,
        fg: cell.fg,
        bg: cell.bg,
        bold: cell.bold,
        italic: cell.italic,
        underline: cell.underline,
      };
      continue;
    }
    current.text += cell.text;
  }

  if (current) segments.push(current);
  return { segments };
}

function withCursorStyledLine(line: TerminalStyledLine, col: number): TerminalStyledLine {
  const cells = toStyledCells(line);
  const cursorCol = Math.max(0, col);
  while (cells.length <= cursorCol) {
    cells.push({ text: ' ' });
  }

  const current = cells[cursorCol] || { text: ' ' };
  cells[cursorCol] = {
    ...current,
    text: '█',
    fg: '#ffffff',
    bold: true,
  };

  return toStyledLine(cells);
}

function withCursorPlainLine(line: string, col: number): string {
  const cursorCol = Math.max(0, col);
  const chars = Array.from(line || '');
  while (chars.length <= cursorCol) {
    chars.push(' ');
  }
  chars[cursorCol] = '█';
  return chars.join('');
}

function TuiApp(props: { input: TuiInput; close: () => void }) {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();
  const [value, setValue] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal('');
  const [paletteSelected, setPaletteSelected] = createSignal(0);
  const [newOpen, setNewOpen] = createSignal(false);
  const [newSelected, setNewSelected] = createSignal(0);
  const [listOpen, setListOpen] = createSignal(false);
  const [listSelected, setListSelected] = createSignal(0);
  const [configOpen, setConfigOpen] = createSignal(false);
  const [configSelected, setConfigSelected] = createSignal(0);
  const [configKeepChannel, setConfigKeepChannel] = createSignal<'on' | 'off'>('off');
  const [configRuntimeMode, setConfigRuntimeMode] = createSignal<'tmux' | 'pty'>('tmux');
  const [configDefaultAgent, setConfigDefaultAgent] = createSignal('(auto)');
  const [configDefaultChannel, setConfigDefaultChannel] = createSignal('(auto)');
  const [configAgentOptions, setConfigAgentOptions] = createSignal<string[]>([]);
  const [configMessage, setConfigMessage] = createSignal('Select an option');
  const [configLoading, setConfigLoading] = createSignal(false);
  const [stopOpen, setStopOpen] = createSignal(false);
  const [stopSelected, setStopSelected] = createSignal(0);
  const [currentSession, setCurrentSession] = createSignal(props.input.currentSession);
  const [currentWindow, setCurrentWindow] = createSignal(props.input.currentWindow);
  const [windowOutput, setWindowOutput] = createSignal('');
  const [windowStyledLines, setWindowStyledLines] = createSignal<TerminalStyledLine[] | undefined>(undefined);
  const [windowCursor, setWindowCursor] = createSignal<TerminalCursor | undefined>(undefined);
  const [cursorBlinkOn, setCursorBlinkOn] = createSignal(true);
  const [prefixPending, setPrefixPending] = createSignal(false);
  const [runtimeInputMode, setRuntimeInputMode] = createSignal(true);
  const [runtimeStatusLine, setRuntimeStatusLine] = createSignal('transport: stream');
  const [commandStatusLine, setCommandStatusLine] = createSignal('status: ready');
  const [clipboardToast, setClipboardToast] = createSignal<string | undefined>(undefined);
  const [composerReady, setComposerReady] = createSignal(false);
  const [projects, setProjects] = createSignal<Array<{
    project: string;
    session: string;
    window: string;
    ai: string;
    channel: string;
    open: boolean;
  }>>([]);
  let textarea: TextareaRenderable;
  let paletteInput: InputRenderable;
  let clipboardToastTimer: ReturnType<typeof setTimeout> | undefined;

  const openProjects = createMemo(() => projects().filter((item) => item.open));
  const sidebarWidth = createMemo(() => Math.max(34, Math.min(52, Math.floor(dims().width * 0.33))));
  const terminalPanelWidth = createMemo(() => Math.max(24, dims().width - sidebarWidth() - 7));
  const terminalPanelHeight = createMemo(() => Math.max(12, dims().height - 3));
  const quickSwitchWindows = createMemo(() =>
    openProjects()
      .slice()
      .sort((a, b) => {
        const bySession = b.session.localeCompare(a.session);
        if (bySession !== 0) return bySession;
        return b.window.localeCompare(a.window);
      })
      .slice(0, 9)
  );
  const stoppableProjects = createMemo(() => {
    const names = new Set<string>();
    openProjects().forEach((item) => names.add(item.project));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  });
  const newChoices = createMemo(() => {
    const existing = openProjects()
      .map((item) => item.project)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .sort((a, b) => a.localeCompare(b))
      .map((project) => ({
        type: 'existing' as const,
        project,
        label: `Use existing session: ${project}`,
      }));
    return [
      { type: 'create' as const, label: 'Create new session' },
      ...existing,
    ];
  });
  const currentWindowItems = createMemo(() => {
    if (!currentSession() || !currentWindow()) return [];
    return openProjects()
      .filter((item) => item.session === currentSession() && item.window === currentWindow())
      .sort((a, b) => a.project.localeCompare(b.project));
  });

  const shouldShowRuntimeCursor = createMemo(() => {
    const dialogOpen = paletteOpen() || stopOpen() || newOpen() || listOpen() || configOpen();
    const runtimeActive = runtimeInputMode() && !!currentSession() && !!currentWindow() && !value().startsWith('/');
    return runtimeActive && !dialogOpen && cursorBlinkOn();
  });

  const renderedStyledLines = createMemo(() => {
    const allLines = windowStyledLines() || [];
    const visibleHeight = terminalPanelHeight();
    const visible = allLines.slice(-visibleHeight);
    const cursor = windowCursor();
    if (!cursor || !shouldShowRuntimeCursor()) return visible;

    const start = Math.max(0, allLines.length - visibleHeight);
    const row = cursor.row - start;
    if (row < 0 || row >= visible.length) return visible;

    return visible.map((line, index) => (index === row ? withCursorStyledLine(line, cursor.col) : line));
  });

  const renderedPlainLines = createMemo(() => {
    const allLines = windowOutput().split('\n');
    const visibleHeight = terminalPanelHeight();
    const visible = allLines.slice(-visibleHeight);
    const cursor = windowCursor();
    if (!cursor || !shouldShowRuntimeCursor()) return visible;

    const start = Math.max(0, allLines.length - visibleHeight);
    const row = cursor.row - start;
    if (row < 0 || row >= visible.length) return visible;

    const next = visible.slice();
    next[row] = withCursorPlainLine(next[row] || '', cursor.col);
    return next;
  });
  const sessionList = createMemo(() => {
    const groups = new Map<string, { windows: Set<string>; projects: Set<string> }>();
    openProjects().forEach((item) => {
      const current = groups.get(item.session) || { windows: new Set<string>(), projects: new Set<string>() };
      current.windows.add(item.window);
      current.projects.add(item.project);
      groups.set(item.session, current);
    });
    return Array.from(groups.entries())
      .map(([session, info]) => {
        const projects = Array.from(info.projects).sort((a, b) => a.localeCompare(b));
        return {
          session,
          windows: info.windows.size,
          attachProject: projects[0],
        };
      })
      .sort((a, b) => a.session.localeCompare(b.session));
  });

  const query = createMemo(() => {
    const next = value();
    if (!next.startsWith('/')) return null;
    if (next.includes(' ')) return null;
    return next.slice(1).toLowerCase();
  });

  const matches = createMemo(() => {
    if (paletteOpen()) return [];
    const next = query();
    if (next === null) return [];
    if (next.length === 0) return slashCommands;
    return slashCommands.filter((item) => item.command.slice(1).startsWith(next));
  });

  const paletteMatches = createMemo(() => {
    const q = paletteQuery().trim().toLowerCase();
    if (!q) return paletteCommands;
    return paletteCommands.filter((item) => {
      return item.command.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
    });
  });

  const clampSelection = (offset: number) => {
    const items = matches();
    if (items.length === 0) return;
    const count = items.length;
    const next = (selected() + offset + count) % count;
    setSelected(next);
  };

  const applySelection = () => {
    const item = matches()[selected()];
    if (!item) return;
    const next = `${item.command} `;
    textarea.setText(next);
    setValue(next);
    textarea.gotoBufferEnd();
  };

  const parseValueLine = (lines: string[], key: string): string | undefined => {
    const prefix = `${key.toLowerCase()}:`;
    const line = lines.find((entry) => entry.toLowerCase().startsWith(prefix));
    if (!line) return undefined;
    const idx = line.indexOf(':');
    if (idx < 0) return undefined;
    return line.slice(idx + 1).trim();
  };

  const runCommandCapture = async (command: string): Promise<{ lines: string[]; shouldClose: boolean }> => {
    const lines: string[] = [];
    const shouldClose = await props.input.onCommand(command, (line) => {
      lines.push(line);
    });
    return { lines, shouldClose: shouldClose === true };
  };

  const setCompactStatus = (line: string) => {
    const text = line.trim().length > 0 ? line.trim() : 'status: done';
    setCommandStatusLine(text.length > 52 ? `${text.slice(0, 49)}...` : text);
  };

  const executeCommand = async (command: string) => {
    const { lines, shouldClose } = await runCommandCapture(command);
    const status = lines.find((line) => line.startsWith('⚠️')) || lines.find((line) => line.startsWith('✅')) || lines[lines.length - 1];
    setCompactStatus(status || 'status: command executed');
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  const showClipboardToast = (message: string) => {
    setClipboardToast(message);
    if (clipboardToastTimer) {
      clearTimeout(clipboardToastTimer);
      clipboardToastTimer = undefined;
    }
    clipboardToastTimer = setTimeout(() => {
      setClipboardToast(undefined);
      clipboardToastTimer = undefined;
    }, 1600);
  };

  const copySelectionToClipboard = async (selectedText?: string) => {
    const selected = selectedText ?? renderer.getSelection()?.getSelectedText();
    if (!selected || selected.length === 0) return;

    try {
      if (DEBUG_SELECTION) {
        setCompactStatus(`[selection] copy start chars=${selected.length}`);
      }
      await copyTextToClipboard(selected, renderer);
      showClipboardToast('Copied to clipboard');
      if (DEBUG_SELECTION) {
        setCompactStatus(`[selection] copy success chars=${selected.length}`);
      }
    } catch (error) {
      showClipboardToast(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
      if (DEBUG_SELECTION) {
        setCompactStatus(`[selection] copy error: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      renderer.clearSelection();
    }
  };

  useSelectionHandler((selection) => {
    if (DEBUG_SELECTION) {
      const preview = selection.getSelectedText();
      setCompactStatus(`[selection] event dragging=${selection.isDragging ? '1' : '0'} chars=${preview.length}`);
    }
    if (selection.isDragging) return;
    const selected = selection.getSelectedText();
    if (!selected || selected.length === 0) return;
    void copySelectionToClipboard(selected);
  });

  const refreshConfigDialog = async () => {
    setConfigLoading(true);
    try {
      const summary = await runCommandCapture('/config');
      const summaryLines = summary.lines;
      const keep = parseValueLine(summaryLines, 'keepChannel');
      if (keep === 'on' || keep === 'off') {
        setConfigKeepChannel(keep);
      }

      const defaultAgent = parseValueLine(summaryLines, 'defaultAgent');
      if (defaultAgent) {
        setConfigDefaultAgent(defaultAgent);
      }

      const defaultChannel = parseValueLine(summaryLines, 'defaultChannel');
      if (defaultChannel) {
        setConfigDefaultChannel(defaultChannel);
      }

      const runtimeMode = parseValueLine(summaryLines, 'runtimeMode');
      if (runtimeMode === 'tmux' || runtimeMode === 'pty') {
        setConfigRuntimeMode(runtimeMode);
      }

      const agentResult = await runCommandCapture('/config defaultAgent');
      const agentLines = agentResult.lines;
      const availableLine = agentLines.find((line) => line.startsWith('Available:'));
      if (availableLine) {
        const parsed = availableLine
          .slice('Available:'.length)
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        setConfigAgentOptions(parsed);
      } else {
        setConfigAgentOptions([]);
      }
    } finally {
      setConfigLoading(false);
    }
  };

  const closeConfigDialog = () => {
    setConfigOpen(false);
    setConfigSelected(0);
  };

  const openConfigDialog = () => {
    setConfigOpen(true);
    setConfigSelected(0);
    setConfigMessage('Loading...');
    textarea?.blur();
    void refreshConfigDialog();
  };

  const selectedDefaultAgent = createMemo(() => {
    const next = configDefaultAgent().trim();
    if (!next || next === '(auto)') return 'auto';
    return next;
  });

  const configItems = createMemo<Array<{ command: string; label: string }>>(() => {
    const items: Array<{ command: string; label: string }> = [
      {
        command: '/config keepChannel toggle',
        label: `keepChannel: ${configKeepChannel()} (toggle)`,
      },
      {
        command: '/config runtimeMode toggle',
        label: `runtimeMode: ${configRuntimeMode()} (toggle)`,
      },
    ];

    items.push({
      command: '/config runtimeMode tmux',
      label: `runtimeMode -> tmux${configRuntimeMode() === 'tmux' ? ' (current)' : ''}`,
    });
    items.push({
      command: '/config runtimeMode pty',
      label: `runtimeMode -> pty${configRuntimeMode() === 'pty' ? ' (current)' : ''}`,
    });

    const agentSet = new Set<string>(['auto', ...configAgentOptions()]);
    const selected = selectedDefaultAgent();
    if (selected !== 'auto') {
      agentSet.add(selected);
    }

    for (const option of agentSet) {
      const display = option === 'auto' ? '(auto)' : option;
      const current = selected === option ? ' (current)' : '';
      items.push({
        command: `/config defaultAgent ${option}`,
        label: `defaultAgent -> ${display}${current}`,
      });
    }

    items.push({
      command: '/config defaultChannel auto',
      label: 'defaultChannel -> (auto)',
    });

    return items;
  });

  const clampConfigSelection = (offset: number) => {
    const items = configItems();
    if (items.length === 0) return;
    const next = (configSelected() + offset + items.length) % items.length;
    setConfigSelected(next);
  };

  const executeConfigSelection = async () => {
    if (configLoading()) return;
    const item = configItems()[configSelected()];
    if (!item) return;
    const result = await runCommandCapture(item.command);
    const lines = result.lines;
    const line = lines.find((entry) => entry.startsWith('✅') || entry.startsWith('⚠️')) || 'Config updated';
    setConfigMessage(line);
    await refreshConfigDialog();
  };

  const openCommandPalette = () => {
    setPaletteOpen(true);
    setPaletteQuery('');
    setPaletteSelected(0);
    textarea?.blur();
    setTimeout(() => {
      if (!paletteInput || paletteInput.isDestroyed) return;
      paletteInput.focus();
    }, 1);
  };

  const closeCommandPalette = () => {
    setPaletteOpen(false);
    setPaletteQuery('');
    setPaletteSelected(0);
  };

  const clampPaletteSelection = (offset: number) => {
    const items = paletteMatches();
    if (items.length === 0) return;
    const next = (paletteSelected() + offset + items.length) % items.length;
    setPaletteSelected(next);
  };

  const executePaletteSelection = async () => {
    const item = paletteMatches()[paletteSelected()];
    if (!item) return;
    if (item.command === '/new') {
      closeCommandPalette();
      setNewOpen(true);
      setNewSelected(0);
      return;
    }
    if (item.command === '/stop') {
      closeCommandPalette();
      setStopOpen(true);
      setStopSelected(0);
      return;
    }
    if (item.command === '/list') {
      closeCommandPalette();
      setListOpen(true);
      setListSelected(0);
      return;
    }
    if (item.command === '/config') {
      closeCommandPalette();
      openConfigDialog();
      return;
    }
    closeCommandPalette();
    await executeCommand(item.command);
  };

  const closeStopDialog = () => {
    setStopOpen(false);
    setStopSelected(0);
  };

  const closeNewDialog = () => {
    setNewOpen(false);
    setNewSelected(0);
  };

  const closeListDialog = () => {
    setListOpen(false);
    setListSelected(0);
  };

  const clampListSelection = (offset: number) => {
    const items = sessionList();
    if (items.length === 0) return;
    const next = (listSelected() + offset + items.length) % items.length;
    setListSelected(next);
  };

  const executeListSelection = async () => {
    const selectedSession = sessionList()[listSelected()];
    if (!selectedSession?.attachProject) return;
    closeListDialog();
    await focusProject(selectedSession.attachProject);
  };

  const resolvePrefixedNumberIndex = (evt: { name?: string }): number | null => {
    if (!evt.name || !/^[1-9]$/.test(evt.name)) return null;
    const index = parseInt(evt.name, 10) - 1;
    if (!Number.isFinite(index) || index < 0) return null;
    return index;
  };

  const quickSwitchToIndex = async (index: number) => {
    const item = quickSwitchWindows()[index];
    if (!item) return;
    await focusProject(item.project);
  };

  const focusProject = async (project: string) => {
    const focused = await props.input.onAttachProject(project);
    if (!focused) return;
    setWindowCursor(undefined);
    if (focused.currentSession) setCurrentSession(focused.currentSession);
    if (focused.currentWindow) setCurrentWindow(focused.currentWindow);
  };

  const clampNewSelection = (offset: number) => {
    const items = newChoices();
    if (items.length === 0) return;
    const next = (newSelected() + offset + items.length) % items.length;
    setNewSelected(next);
  };

  const executeNewSelection = async () => {
    const choice = newChoices()[newSelected()];
    if (!choice) return;
    closeNewDialog();
    if (choice.type === 'create') {
      await executeCommand('/new');
      return;
    }
    await focusProject(choice.project);
  };

  const clampStopSelection = (offset: number) => {
    const items = stoppableProjects();
    if (items.length === 0) return;
    const next = (stopSelected() + offset + items.length) % items.length;
    setStopSelected(next);
  };

  const executeStopSelection = async () => {
    const project = stoppableProjects()[stopSelected()];
    if (!project) return;
    closeStopDialog();
    await props.input.onStopProject(project);
  };

  const submit = async () => {
    const raw = textarea?.plainText ?? '';
    const command = raw.trim();
    textarea?.setText('');
    setValue('');
    if (!command) return;

    if (command === 'new' || command === '/new') {
      setNewOpen(true);
      setNewSelected(0);
      return;
    }

    if (command === 'stop' || command === '/stop') {
      setStopOpen(true);
      setStopSelected(0);
      return;
    }

    if (command === 'list' || command === '/list') {
      setListOpen(true);
      setListSelected(0);
      return;
    }

    if (command === 'config' || command === '/config') {
      openConfigDialog();
      return;
    }

    await executeCommand(command);
  };

  const canHandleRuntimeInput = () => {
    return runtimeInputMode() && !paletteOpen() && !stopOpen() && !newOpen() && !listOpen() && !configOpen() && !!currentSession() && !!currentWindow() && !value().startsWith('/');
  };

  createEffect(() => {
    if (!composerReady()) return;
    if (!textarea || textarea.isDestroyed) return;

    const dialogOpen = paletteOpen() || stopOpen() || newOpen() || listOpen() || configOpen();
    if (dialogOpen) {
      textarea.blur();
      return;
    }

    if (canHandleRuntimeInput()) {
      textarea.blur();
      return;
    }

    textarea.focus();
  });

  const toRuntimeRawKey = (evt: {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
  }): string | null => {
    const name = evt.name || '';
    if (name === 'return' || name === 'enter') return '\r';
    if (name === 'backspace') return '\x7f';
    if (name === 'tab') return '\t';
    if (name === 'escape') return '\x1b';
    if (name === 'up') return '\x1b[A';
    if (name === 'down') return '\x1b[B';
    if (name === 'right') return '\x1b[C';
    if (name === 'left') return '\x1b[D';
    if (name === 'home') return '\x1b[H';
    if (name === 'end') return '\x1b[F';
    if (name === 'delete') return '\x1b[3~';
    if (name === 'pageup') return '\x1b[5~';
    if (name === 'pagedown') return '\x1b[6~';

    if (evt.ctrl && name.length === 1 && /^[a-z]$/i.test(name)) {
      const code = name.toLowerCase().charCodeAt(0) - 96;
      if (code >= 1 && code <= 26) return String.fromCharCode(code);
    }

    const sequence = evt.sequence || '';
    if (!evt.meta && sequence.length > 0) {
      return sequence;
    }

    return null;
  };

  const sendRawToRuntime = (raw: string) => {
    if (!raw || !props.input.onRuntimeKey) return;
    const session = currentSession();
    const window = currentWindow();
    if (!session || !window) return;
    void props.input.onRuntimeKey(session, window, raw);
  };

  const pasteClipboardToRuntime = async () => {
    try {
      const text = await readTextFromClipboard();
      if (!text || text.length === 0) {
        showClipboardToast('Clipboard is empty');
        return;
      }
      sendRawToRuntime(text);
      showClipboardToast('Pasted from clipboard');
    } catch (error) {
      showClipboardToast(`Paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const toTextAttributes = (segment: { bold?: boolean; italic?: boolean; underline?: boolean }): number => {
    let attr = 0;
    if (segment.bold) attr |= TextAttributes.BOLD;
    if (segment.italic) attr |= TextAttributes.ITALIC;
    if (segment.underline) attr |= TextAttributes.UNDERLINE;
    return attr;
  };

  useKeyboard((evt) => {
    if (prefixPending()) {
      evt.preventDefault();
      setPrefixPending(false);

      if (evt.name === 'c') {
        renderer.destroy();
        props.close();
        return;
      }

      const prefixedNumberIndex = resolvePrefixedNumberIndex(evt);
      if (prefixedNumberIndex !== null) {
        if (!paletteOpen() && !stopOpen() && !newOpen() && !listOpen() && !configOpen()) {
          void quickSwitchToIndex(prefixedNumberIndex);
        }
        return;
      }

      if (evt.name === 'p') {
        if (paletteOpen()) {
          clampPaletteSelection(-1);
          return;
        }
        if (stopOpen()) {
          clampStopSelection(-1);
          return;
        }
        if (newOpen()) {
          clampNewSelection(-1);
          return;
        }
        if (listOpen()) {
          clampListSelection(-1);
          return;
        }
        if (configOpen()) {
          clampConfigSelection(-1);
          return;
        }
        openCommandPalette();
        return;
      }

      if (evt.name === 'n') {
        if (paletteOpen()) {
          clampPaletteSelection(1);
          return;
        }
        if (stopOpen()) {
          clampStopSelection(1);
          return;
        }
        if (newOpen()) {
          clampNewSelection(1);
          return;
        }
        if (listOpen()) {
          clampListSelection(1);
          return;
        }
        if (configOpen()) {
          clampConfigSelection(1);
          return;
        }
      }

      if (evt.name === PREFIX_KEY_NAME && canHandleRuntimeInput()) {
        sendRawToRuntime(String.fromCharCode(2));
      }
      return;
    }

    if (evt.ctrl && evt.name === PREFIX_KEY_NAME) {
      evt.preventDefault();
      setPrefixPending(true);
      return;
    }

    if (evt.ctrl && evt.name === 'p' && (evt.shift || evt.sequence === 'P')) {
      evt.preventDefault();
      if (stopOpen()) closeStopDialog();
      if (newOpen()) closeNewDialog();
      if (listOpen()) closeListDialog();
      if (configOpen()) closeConfigDialog();
      if (!paletteOpen()) {
        openCommandPalette();
      }
      return;
    }

    if (evt.ctrl && evt.name === 'v' && canHandleRuntimeInput()) {
      evt.preventDefault();
      void pasteClipboardToRuntime();
      return;
    }

    if (paletteOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeCommandPalette();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        clampPaletteSelection(-1);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        clampPaletteSelection(1);
        return;
      }
      if (evt.name === 'pageup') {
        evt.preventDefault();
        clampPaletteSelection(-10);
        return;
      }
      if (evt.name === 'pagedown') {
        evt.preventDefault();
        clampPaletteSelection(10);
        return;
      }
      if (evt.name === 'home') {
        evt.preventDefault();
        setPaletteSelected(0);
        return;
      }
      if (evt.name === 'end') {
        evt.preventDefault();
        setPaletteSelected(Math.max(0, paletteMatches().length - 1));
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executePaletteSelection();
        return;
      }
      if (evt.name === 'tab') {
        evt.preventDefault();
        return;
      }
    }

    if (stopOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeStopDialog();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        clampStopSelection(-1);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        clampStopSelection(1);
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executeStopSelection();
        return;
      }
    }

    if (newOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeNewDialog();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        clampNewSelection(-1);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        clampNewSelection(1);
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executeNewSelection();
        return;
      }
    }

    if (listOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeListDialog();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        clampListSelection(-1);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        clampListSelection(1);
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executeListSelection();
        return;
      }
    }

    if (configOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeConfigDialog();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        clampConfigSelection(-1);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        clampConfigSelection(1);
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executeConfigSelection();
        return;
      }
    }

    if (!runtimeInputMode() && !paletteOpen() && !stopOpen() && !newOpen() && !listOpen() && !configOpen() && evt.name === 'escape') {
      evt.preventDefault();
      textarea?.setText('');
      setValue('');
      setRuntimeInputMode(true);
      return;
    }

    if (canHandleRuntimeInput()) {
      const raw = toRuntimeRawKey(evt);
      if (raw) {
        evt.preventDefault();
        sendRawToRuntime(raw);
        if (value() && !value().startsWith('/')) {
          textarea?.setText('');
          setValue('');
        }
      }
    }
  });

  usePaste((evt) => {
    if (!canHandleRuntimeInput()) return;
    const text = evt.text || '';
    if (!text) return;
    evt.preventDefault();
    sendRawToRuntime(text);
  });

  onMount(() => {
    let stopped = false;
    let detachRuntimeFrame: (() => void) | undefined;

    if (DEBUG_SELECTION) {
      setCompactStatus('[selection-debug] enabled');
    }

    const refreshProjects = async () => {
      try {
        const next = await props.input.getProjects();
        if (stopped) return;
        setProjects(next);

        if (props.input.getRuntimeStatus) {
          const status = await props.input.getRuntimeStatus();
          if (stopped || !status) return;
          const suffix = status.lastError ? ` (${status.lastError})` : '';
          const line = status.connected
            ? `transport: stream (${status.detail})`
            : `transport: stream error (${status.detail})${suffix}`;
          setRuntimeStatusLine(line.length > 52 ? `${line.slice(0, 49)}...` : line);
          if (!status.connected) {
            setWindowStyledLines(undefined);
            setWindowCursor(undefined);
          }
        }
      } catch (error) {
        if (stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        const line = `transport: stream error (${message})`;
        setRuntimeStatusLine(line.length > 52 ? `${line.slice(0, 49)}...` : line);
      }
    };

    const syncOutput = async () => {
      const session = currentSession();
      const window = currentWindow();
      if (!session || !window || !props.input.getCurrentWindowOutput) {
        setWindowOutput('');
        setWindowStyledLines(undefined);
        setWindowCursor(undefined);
        return;
      }

      const panelWidth = terminalPanelWidth();
      const panelHeight = terminalPanelHeight();
      let output: string | undefined;
      try {
        output = await props.input.getCurrentWindowOutput(session, window, panelWidth, panelHeight);
      } catch {
        return;
      }
      if (stopped) return;
      setWindowOutput(output || '');
      if (!output) {
        setWindowStyledLines(undefined);
      }
    };

    if (props.input.onRuntimeFrame) {
      detachRuntimeFrame = props.input.onRuntimeFrame((frame) => {
        if (frame.sessionName !== currentSession() || frame.windowName !== currentWindow()) return;
        setWindowOutput(frame.output || '');
        setWindowStyledLines(frame.styled);
        const hasCursor = Number.isFinite(frame.cursorRow) && Number.isFinite(frame.cursorCol);
        setWindowCursor(hasCursor
          ? {
            row: Math.max(0, Math.floor(frame.cursorRow as number)),
            col: Math.max(0, Math.floor(frame.cursorCol as number)),
          }
          : undefined);
      });
    }

    renderer.console.onCopySelection = (text) => {
      void copySelectionToClipboard(text);
    };

    const cursorTimer = setInterval(() => {
      setCursorBlinkOn((value) => !value);
    }, 520);

    createEffect(() => {
      const session = currentSession();
      const window = currentWindow();
      const width = terminalPanelWidth();
      const height = terminalPanelHeight();
      if (session && window && props.input.onRuntimeResize) {
        void props.input.onRuntimeResize(session, window, width, height);
      }
      void syncOutput();
    });

    void refreshProjects();
    void syncOutput();
    const projectTimer = setInterval(() => {
      void refreshProjects();
    }, 2000);
    const outputFallbackTimer = setInterval(() => {
      void syncOutput();
    }, 1200);

    onCleanup(() => {
      stopped = true;
      clearInterval(projectTimer);
      clearInterval(outputFallbackTimer);
      clearInterval(cursorTimer);
      detachRuntimeFrame?.();
      if (clipboardToastTimer) {
        clearTimeout(clipboardToastTimer);
        clipboardToastTimer = undefined;
      }
      renderer.console.onCopySelection = undefined;
    });

    const initial = props.input.initialCommand?.trim();
    if (initial) {
      setRuntimeInputMode(false);
      void executeCommand(initial);
    }

    setTimeout(() => {
      if (canHandleRuntimeInput()) {
        textarea?.blur();
      } else {
        textarea?.focus();
      }
    }, 1);
  });

  return (
    <box
      width={dims().width}
      height={dims().height}
      backgroundColor={palette.bg}
      flexDirection="column"
      onMouseDown={(event) => {
        if (DEBUG_SELECTION) {
          setCompactStatus(`[mouse] down x=${event.x} y=${event.y} btn=${event.button}`);
        }
      }}
      onMouseDrag={(event) => {
        if (DEBUG_SELECTION) {
          setCompactStatus(`[mouse] drag x=${event.x} y=${event.y}`);
        }
      }}
      onMouseUp={(event) => {
        if (DEBUG_SELECTION) {
          setCompactStatus(`[mouse] up x=${event.x} y=${event.y} btn=${event.button}`);
        }
      }}
    >
      <box flexGrow={1} backgroundColor={palette.bg} flexDirection="row" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <box
          flexGrow={1}
          border
          borderColor={canHandleRuntimeInput() ? palette.focus : palette.border}
          backgroundColor={palette.panel}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <box flexDirection="column" flexGrow={1}>
            <Show when={currentWindow()} fallback={<text fg={palette.muted}>No active window</text>}>
              <Show when={windowOutput().length > 0} fallback={<text fg={palette.muted}>Waiting for agent output...</text>}>
                <Show when={windowStyledLines() && windowStyledLines()!.length > 0} fallback={
                  <For each={renderedPlainLines()}>
                    {(line) => <text fg={palette.text}>{line.length > 0 ? line : ' '}</text>}
                  </For>
                }>
                  <For each={renderedStyledLines()}>
                    {(line) => (
                      <box flexDirection="row">
                        <For each={line.segments}>
                          {(segment) => (
                            <text
                              fg={segment.fg || palette.text}
                              bg={segment.bg || palette.panel}
                              attributes={toTextAttributes(segment)}
                            >{segment.text.length > 0 ? segment.text : ' '}</text>
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </box>
        </box>

        <box width={sidebarWidth()} marginLeft={1} border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column" paddingLeft={1} paddingRight={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>discode</text>
            <text fg={palette.muted}>{TUI_VERSION_LABEL}</text>
          </box>
          <text fg={runtimeInputMode() ? palette.primary : palette.muted}>{runtimeInputMode() ? 'mode: runtime input' : 'mode: command input'}</text>
          <text fg={palette.muted}>{runtimeStatusLine()}</text>
          <text fg={palette.muted}>{commandStatusLine()}</text>
          <text fg={prefixPending() ? palette.primary : palette.muted}>{`prefix: ${PREFIX_LABEL}${prefixPending() ? ' (waiting key)' : ''}`}</text>
          <text fg={palette.muted}>runtime: slash/ctrl pass to AI</text>
          <text fg={palette.muted}>window: prefix + 1..9</text>
          <text fg={palette.muted}>palette: Ctrl+Shift+P</text>
          <text fg={palette.muted}>commands: / + Enter</text>

          <box flexDirection="column" marginTop={1}>
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>Current Sessions</text>
            <Show when={sessionList().length > 0} fallback={<text fg={palette.muted}>No running sessions</text>}>
              <For each={sessionList().slice(0, 10)}>
                {(item) => <text fg={palette.text}>{`- ${item.session} (${item.windows})`}</text>}
              </For>
            </Show>
          </box>

          <box flexDirection="column" marginTop={1}>
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>Quick Switch</text>
            <Show when={quickSwitchWindows().length > 0} fallback={<text fg={palette.muted}>No mapped windows</text>}>
              <For each={quickSwitchWindows()}>
                {(item, index) => <text fg={palette.muted}>{`prefix+${index() + 1} ${item.project}`}</text>}
              </For>
            </Show>
          </box>

          <box flexDirection="column" marginTop={1}>
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>Window Info</text>
            <Show when={currentWindowItems().length > 0} fallback={<text fg={palette.muted}>No project mapped</text>}>
              <For each={currentWindowItems().slice(0, 3)}>
                {(item) => (
                  <>
                    <text fg={palette.text}>{item.project}</text>
                    <text fg={palette.muted}>{`ai: ${item.ai}`}</text>
                    <text fg={palette.muted}>{`channel: ${item.channel}`}</text>
                  </>
                )}
              </For>
            </Show>
          </box>

          <box flexGrow={1} />

          <Show when={matches().length > 0}>
            <box marginTop={1} border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column">
              <For each={matches().slice(0, 6)}>
                {(item, index) => (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={selected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={selected() === index() ? palette.selectedFg : palette.text}>{item.command}</text>
                    <text fg={palette.muted}>{`  ${item.description}`}</text>
                  </box>
                )}
              </For>
            </box>
          </Show>

          <box
            marginTop={1}
            marginBottom={1}
            border
            borderColor={!canHandleRuntimeInput() && !paletteOpen() && !stopOpen() && !newOpen() && !listOpen() && !configOpen() ? palette.focus : palette.border}
            backgroundColor={palette.panel}
            flexDirection="column"
          >
            <box paddingLeft={1} paddingRight={1}>
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>{'discode> '}</text>
            </box>
            <box paddingLeft={1} paddingRight={1}>
              <textarea
                ref={(input: TextareaRenderable) => {
                  textarea = input;
                  setComposerReady(true);
                }}
                minHeight={1}
                maxHeight={4}
                onSubmit={submit}
                keyBindings={[{ name: 'return', action: 'submit' }]}
                placeholder={runtimeInputMode() ? 'Type /command and press Enter' : 'Type a command'}
                textColor={palette.text}
                focusedTextColor={palette.text}
                cursorColor={palette.primary}
                onContentChange={() => {
                  const next = textarea.plainText;
                  setValue(next);
                  setSelected(0);
                }}
                onKeyDown={(event) => {
                  if (paletteOpen() || stopOpen() || newOpen() || listOpen() || configOpen()) {
                    event.preventDefault();
                    return;
                  }
                  if (runtimeInputMode() && !value().startsWith('/') && event.sequence !== '/') {
                    event.preventDefault();
                    return;
                  }
                  if (matches().length === 0) return;
                  if (event.name === 'up') {
                    event.preventDefault();
                    clampSelection(-1);
                    return;
                  }
                  if (event.name === 'down') {
                    event.preventDefault();
                    clampSelection(1);
                    return;
                  }
                  if (event.name === 'tab') {
                    event.preventDefault();
                    applySelection();
                    return;
                  }
                  if (event.name === 'return' && query() !== null) {
                    event.preventDefault();
                    applySelection();
                  }
                }}
              />
            </box>
          </box>
        </box>
      </box>

      <Show when={clipboardToast()}>
        <box
          position="absolute"
          top={1}
          right={2}
          border
          borderColor={palette.focus}
          backgroundColor={palette.selectedBg}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={palette.selectedFg}>{clipboardToast()}</text>
        </box>
      </Show>

      <Show when={newOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(50, Math.min(70, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>New session</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <For each={newChoices().slice(0, 12)}>
              {(item, index) => (
                <box
                  paddingLeft={3}
                  paddingRight={1}
                  paddingTop={index() === 0 ? 1 : 0}
                  backgroundColor={newSelected() === index() ? palette.selectedBg : palette.panel}
                >
                  <text fg={newSelected() === index() ? palette.selectedFg : palette.text}>{item.label}</text>
                </box>
              )}
            </For>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Select </text>
              <text fg={palette.muted}>enter</text>
            </box>
          </box>
        </box>
      </Show>

      <Show when={paletteOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(50, Math.min(70, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>Commands</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <box paddingLeft={4} paddingRight={4} paddingTop={1}>
              <input
                ref={(r: InputRenderable) => {
                  paletteInput = r;
                }}
                placeholder="Search"
                cursorColor={palette.primary}
                focusedTextColor={palette.muted}
                focusedBackgroundColor={palette.bg}
                onInput={(next) => {
                  setPaletteQuery(next);
                  setPaletteSelected(0);
                }}
              />
            </box>
            <Show when={paletteMatches().length > 0} fallback={<box paddingLeft={4} paddingRight={4} paddingTop={1}><text fg={palette.muted}>No commands</text></box>}>
              <For each={paletteMatches().slice(0, Math.max(8, Math.floor(dims().height / 2) - 6))}>
                {(item, index) => (
                  <box
                    paddingLeft={3}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 1 : 0}
                    backgroundColor={paletteSelected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={paletteSelected() === index() ? palette.selectedFg : palette.text}>{item.command}</text>
                    <text fg={palette.muted}>{`  ${item.description}`}</text>
                  </box>
                )}
              </For>
            </Show>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Select </text>
              <text fg={palette.muted}>enter</text>
            </box>
          </box>
        </box>
      </Show>

      <Show when={stopOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(50, Math.min(70, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>Stop project</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <Show when={stoppableProjects().length > 0} fallback={<box paddingLeft={4} paddingRight={4} paddingTop={1}><text fg={palette.muted}>No running projects</text></box>}>
              <For each={stoppableProjects().slice(0, 10)}>
                {(item, index) => (
                  <box
                    paddingLeft={3}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 1 : 0}
                    backgroundColor={stopSelected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={stopSelected() === index() ? palette.selectedFg : palette.text}>{item}</text>
                  </box>
                )}
              </For>
            </Show>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Stop </text>
              <text fg={palette.muted}>enter</text>
            </box>
          </box>
        </box>
      </Show>

      <Show when={configOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(54, Math.min(74, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>Config</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <box paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="column">
              <text fg={palette.text}>{`keepChannel: ${configKeepChannel()}`}</text>
              <text fg={palette.text}>{`runtimeMode: ${configRuntimeMode()}`}</text>
              <text fg={palette.text}>{`defaultAgent: ${configDefaultAgent()}`}</text>
              <text fg={palette.text}>{`defaultChannel: ${configDefaultChannel()}`}</text>
            </box>
            <Show when={!configLoading()} fallback={<box paddingLeft={4} paddingRight={4} paddingTop={1}><text fg={palette.muted}>Loading...</text></box>}>
              <For each={configItems().slice(0, 12)}>
                {(item, index) => (
                  <box
                    paddingLeft={3}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 1 : 0}
                    backgroundColor={configSelected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={configSelected() === index() ? palette.selectedFg : palette.text}>{item.label}</text>
                  </box>
                )}
              </For>
            </Show>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Apply </text>
              <text fg={palette.muted}>enter</text>
              <text fg={palette.text}>  Close </text>
              <text fg={palette.muted}>esc</text>
            </box>
            <box paddingLeft={4} paddingRight={2}>
              <text fg={palette.muted}>{configMessage()}</text>
            </box>
          </box>
        </box>
      </Show>

      <Show when={listOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(50, Math.min(70, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>Session list</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <Show when={sessionList().length > 0} fallback={<box paddingLeft={4} paddingRight={4} paddingTop={1}><text fg={palette.muted}>No running sessions</text></box>}>
              <For each={sessionList().slice(0, 12)}>
                {(item, index) => (
                  <box
                    paddingLeft={3}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 1 : 0}
                    backgroundColor={listSelected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={listSelected() === index() ? palette.selectedFg : palette.text}>{item.session}</text>
                    <text fg={palette.muted}>{`  (${item.windows} windows)`}</text>
                  </box>
                )}
              </For>
            </Show>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Open </text>
              <text fg={palette.muted}>enter</text>
              <text fg={palette.text}>  Close </text>
              <text fg={palette.muted}>esc</text>
            </box>
          </box>
        </box>
      </Show>
    </box>
  );
}

export function runTui(input: TuiInput): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      resolve();
    };
    void render(() => <TuiApp input={input} close={close} />, {
      targetFps: 60,
      exitOnCtrlC: false,
      autoFocus: true,
    });
  });
}
