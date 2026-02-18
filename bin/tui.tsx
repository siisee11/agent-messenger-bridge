/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */

import { InputRenderable, RGBA, TextAttributes, TextareaRenderable } from '@opentui/core';
import { render, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { TerminalStyledLine } from '../src/runtime/vt-screen.js';

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

type TuiInput = {
  currentSession?: string;
  currentWindow?: string;
  onCommand: (command: string, append: (line: string) => void) => Promise<boolean | void>;
  onStopProject: (project: string) => Promise<void>;
  onAttachProject: (project: string) => Promise<{ currentSession?: string; currentWindow?: string } | void>;
  onRuntimeKey?: (sessionName: string, windowName: string, raw: string) => Promise<void>;
  onRuntimeResize?: (sessionName: string, windowName: string, width: number, height: number) => Promise<void> | void;
  onRuntimeFrame?: (listener: (frame: { sessionName: string; windowName: string; output: string; styled?: TerminalStyledLine[] }) => void) => () => void;
  getRuntimeStatus?: () =>
    | {
      mode: 'stream' | 'http-fallback';
      connected: boolean;
      fallback: boolean;
      detail: string;
      lastError?: string;
    }
    | Promise<{
      mode: 'stream' | 'http-fallback';
      connected: boolean;
      fallback: boolean;
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
  text: '#eeeeee',
  muted: '#9a9a9a',
  primary: '#fab283',
  selectedBg: '#2b2b2b',
  selectedFg: '#ffffff',
};

const slashCommands = [
  { command: '/new', description: 'create new session' },
  { command: '/list', description: 'show current session list' },
  { command: '/stop', description: 'select and stop a project' },
  { command: '/projects', description: 'list configured projects' },
  { command: '/config', description: 'manage keepChannel/defaultAgent' },
  { command: '/help', description: 'show available commands' },
  { command: '/exit', description: 'close the TUI' },
  { command: '/quit', description: 'close the TUI' },
];

const paletteCommands = [
  { command: '/new', description: 'Create a new session' },
  { command: '/list', description: 'Show current session list' },
  { command: '/stop', description: 'Select and stop a project' },
  { command: '/projects', description: 'List configured projects' },
  { command: '/config', description: 'Manage keepChannel/defaultAgent' },
  { command: '/help', description: 'Show help' },
  { command: '/exit', description: 'Exit TUI' },
  { command: '/quit', description: 'Exit TUI' },
];

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
  const [stopOpen, setStopOpen] = createSignal(false);
  const [stopSelected, setStopSelected] = createSignal(0);
  const [currentSession, setCurrentSession] = createSignal(props.input.currentSession);
  const [currentWindow, setCurrentWindow] = createSignal(props.input.currentWindow);
  const [windowOutput, setWindowOutput] = createSignal('');
  const [windowStyledLines, setWindowStyledLines] = createSignal<TerminalStyledLine[] | undefined>(undefined);
  const [runtimeInputMode, setRuntimeInputMode] = createSignal(true);
  const [runtimeStatusLine, setRuntimeStatusLine] = createSignal('transport: stream');
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

  const openProjects = createMemo(() => projects().filter((item) => item.open));
  const sidebarWidth = createMemo(() => Math.max(34, Math.min(52, Math.floor(dims().width * 0.33))));
  const terminalPanelWidth = createMemo(() => Math.max(24, dims().width - sidebarWidth() - 7));
  const terminalPanelHeight = createMemo(() => Math.max(12, dims().height - 3));
  const quickSwitchWindows = createMemo(() =>
    openProjects()
      .slice()
      .sort((a, b) => {
        const bySession = a.session.localeCompare(b.session);
        if (bySession !== 0) return bySession;
        return a.window.localeCompare(b.window);
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
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return;
      textarea.focus();
    }, 1);
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
    closeCommandPalette();
    const shouldClose = await props.input.onCommand(item.command, () => {});
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  const closeStopDialog = () => {
    setStopOpen(false);
    setStopSelected(0);
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return;
      textarea.focus();
    }, 1);
  };

  const closeNewDialog = () => {
    setNewOpen(false);
    setNewSelected(0);
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return;
      textarea.focus();
    }, 1);
  };

  const closeListDialog = () => {
    setListOpen(false);
    setListSelected(0);
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return;
      textarea.focus();
    }, 1);
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

  const resolveCtrlNumberIndex = (evt: { ctrl?: boolean; name?: string }): number | null => {
    if (!evt.ctrl) return null;
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
      await props.input.onCommand('/new', () => {});
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

    const shouldClose = await props.input.onCommand(command, () => {});
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  const canHandleRuntimeInput = () => {
    return runtimeInputMode() && !paletteOpen() && !stopOpen() && !newOpen() && !listOpen() && !!currentSession() && !!currentWindow() && !value().startsWith('/');
  };

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
    if (!evt.ctrl && !evt.meta && sequence.length > 0) {
      return sequence;
    }

    return null;
  };

  const toTextAttributes = (segment: { bold?: boolean; italic?: boolean; underline?: boolean }): number => {
    let attr = 0;
    if (segment.bold) attr |= TextAttributes.BOLD;
    if (segment.italic) attr |= TextAttributes.ITALIC;
    if (segment.underline) attr |= TextAttributes.UNDERLINE;
    return attr;
  };

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === 'g') {
      evt.preventDefault();
      setRuntimeInputMode(!runtimeInputMode());
      return;
    }

    const ctrlNumberIndex = resolveCtrlNumberIndex(evt);
    if (ctrlNumberIndex !== null) {
      if (!paletteOpen() && !stopOpen() && !newOpen() && !listOpen()) {
        evt.preventDefault();
        void quickSwitchToIndex(ctrlNumberIndex);
      }
      return;
    }

    if (evt.ctrl && evt.name === 'p') {
      evt.preventDefault();
      if (!paletteOpen()) {
        openCommandPalette();
      }
      return;
    }

    if (paletteOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeCommandPalette();
        return;
      }
      if (evt.name === 'up' || (evt.ctrl && evt.name === 'p')) {
        evt.preventDefault();
        clampPaletteSelection(-1);
        return;
      }
      if (evt.name === 'down' || (evt.ctrl && evt.name === 'n')) {
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
      if (evt.name === 'up' || (evt.ctrl && evt.name === 'p')) {
        evt.preventDefault();
        clampStopSelection(-1);
        return;
      }
      if (evt.name === 'down' || (evt.ctrl && evt.name === 'n')) {
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
      if (evt.name === 'up' || (evt.ctrl && evt.name === 'p')) {
        evt.preventDefault();
        clampNewSelection(-1);
        return;
      }
      if (evt.name === 'down' || (evt.ctrl && evt.name === 'n')) {
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
      if (evt.name === 'up' || (evt.ctrl && evt.name === 'p')) {
        evt.preventDefault();
        clampListSelection(-1);
        return;
      }
      if (evt.name === 'down' || (evt.ctrl && evt.name === 'n')) {
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

    if (evt.ctrl && evt.name === 'c') {
      evt.preventDefault();
      renderer.destroy();
      props.close();
      return;
    }

    if (canHandleRuntimeInput()) {
      if (evt.sequence === '/') {
        return;
      }
      const raw = toRuntimeRawKey(evt);
      if (raw) {
        evt.preventDefault();
        const session = currentSession();
        const window = currentWindow();
        if (session && window && props.input.onRuntimeKey) {
          void props.input.onRuntimeKey(session, window, raw);
        }
        if (value() && !value().startsWith('/')) {
          textarea?.setText('');
          setValue('');
        }
      }
    }
  });

  onMount(() => {
    let stopped = false;
    let detachRuntimeFrame: (() => void) | undefined;

    const refreshProjects = async () => {
      const next = await props.input.getProjects();
      if (stopped) return;
      setProjects(next);

      if (props.input.getRuntimeStatus) {
        const status = await props.input.getRuntimeStatus();
        if (stopped || !status) return;
        const suffix = status.lastError ? ` (${status.lastError})` : '';
        const line =
          status.mode === 'stream' && status.connected
            ? `transport: stream (${status.detail})`
            : `transport: http fallback (${status.detail})${suffix}`;
        setRuntimeStatusLine(line.length > 52 ? `${line.slice(0, 49)}...` : line);
        if (status.mode === 'http-fallback') {
          setWindowStyledLines(undefined);
        }
      }
    };

    const syncOutput = async () => {
      const session = currentSession();
      const window = currentWindow();
      if (!session || !window || !props.input.getCurrentWindowOutput) {
        setWindowOutput('');
        setWindowStyledLines(undefined);
        return;
      }

      const panelWidth = terminalPanelWidth();
      const panelHeight = terminalPanelHeight();
      const output = await props.input.getCurrentWindowOutput(session, window, panelWidth, panelHeight);
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
      });
    }

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
      detachRuntimeFrame?.();
    });
    setTimeout(() => textarea?.focus(), 1);
  });

  return (
    <box width={dims().width} height={dims().height} backgroundColor={palette.bg} flexDirection="column">
      <box flexGrow={1} backgroundColor={palette.bg} flexDirection="row" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <box flexGrow={1} border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column" paddingLeft={1} paddingRight={1}>
          <box flexDirection="column" flexGrow={1}>
            <Show when={currentWindow()} fallback={<text fg={palette.muted}>No active window</text>}>
              <Show when={windowOutput().length > 0} fallback={<text fg={palette.muted}>Waiting for agent output...</text>}>
                <Show when={windowStyledLines() && windowStyledLines()!.length > 0} fallback={
                  <For each={windowOutput().split('\n').slice(-terminalPanelHeight())}>
                    {(line) => <text fg={palette.text}>{line.length > 0 ? line : ' '}</text>}
                  </For>
                }>
                  <For each={(windowStyledLines() || []).slice(-terminalPanelHeight())}>
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
          <text fg={palette.muted}>toggle: Ctrl+g</text>
          <text fg={palette.muted}>window: Ctrl+1..9</text>
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
                {(item, index) => <text fg={palette.muted}>{`Ctrl+${index() + 1} ${item.project}`}</text>}
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

          <box marginTop={1} marginBottom={1} border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column">
            <box paddingLeft={1} paddingRight={1}>
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>{'discode> '}</text>
            </box>
            <box paddingLeft={1} paddingRight={1}>
              <textarea
                ref={(input: TextareaRenderable) => {
                  textarea = input;
                }}
                minHeight={1}
                maxHeight={4}
                onSubmit={submit}
                keyBindings={[{ name: 'return', action: 'submit' }]}
                placeholder={runtimeInputMode() ? 'Press / to enter command mode' : 'Type a command'}
                textColor={palette.text}
                focusedTextColor={palette.text}
                cursorColor={palette.primary}
                onContentChange={() => {
                  const next = textarea.plainText;
                  setValue(next);
                  setSelected(0);
                }}
                onKeyDown={(event) => {
                  if (paletteOpen() || stopOpen() || newOpen() || listOpen()) {
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
