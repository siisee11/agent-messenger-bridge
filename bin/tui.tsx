/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */

import { TextAttributes, TextareaRenderable } from '@opentui/core';
import { render, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';

type TuiInput = {
  onCommand: (command: string, append: (line: string) => void) => Promise<boolean | void>;
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
  { command: '/session_new', description: 'create new session' },
  { command: '/new', description: 'alias for /session_new' },
  { command: '/projects', description: 'list configured projects' },
  { command: '/help', description: 'show available commands' },
  { command: '/exit', description: 'close the TUI' },
  { command: '/quit', description: 'close the TUI' },
];

function TuiApp(props: { input: TuiInput; close: () => void }) {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();
  const [value, setValue] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  let textarea: TextareaRenderable;

  const query = createMemo(() => {
    const next = value();
    if (!next.startsWith('/')) return null;
    if (next.includes(' ')) return null;
    return next.slice(1).toLowerCase();
  });

  const matches = createMemo(() => {
    const next = query();
    if (next === null) return [];
    if (next.length === 0) return slashCommands;
    return slashCommands.filter((item) => item.command.slice(1).startsWith(next));
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

  const submit = async () => {
    const raw = textarea?.plainText ?? '';
    const command = raw.trim();
    textarea?.setText('');
    setValue('');
    if (!command) return;

    const shouldClose = await props.input.onCommand(command, () => {});
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === 'c') {
      evt.preventDefault();
      renderer.destroy();
      props.close();
    }
  });

  onMount(() => {
    setTimeout(() => textarea?.focus(), 1);
  });

  return (
    <box width={dims().width} height={dims().height} backgroundColor={palette.bg} flexDirection="column">
      <box flexGrow={1} backgroundColor={palette.bg}></box>

      <Show when={matches().length > 0}>
        <box backgroundColor={palette.bg} paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <box border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column">
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
        </box>
      </Show>

      <box backgroundColor={palette.bg} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <box border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column">
          <box paddingLeft={1} paddingRight={1}>
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>{'agent-bridge> '}</text>
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
              placeholder="Type a command"
              textColor={palette.text}
              focusedTextColor={palette.text}
              cursorColor={palette.primary}
              onContentChange={() => {
                const next = textarea.plainText;
                setValue(next);
                setSelected(0);
              }}
              onKeyDown={(event) => {
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
