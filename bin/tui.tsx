/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */

import { TextAttributes, TextareaRenderable } from '@opentui/core';
import { render, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { For, createMemo, createSignal, onMount } from 'solid-js';

type TuiInput = {
  onCommand: (command: string, append: (line: string) => void) => Promise<boolean | void>;
};

const palette = {
  bg: '#0a0a0a',
  panel: '#141414',
  element: '#1e1e1e',
  border: '#484848',
  text: '#eeeeee',
  muted: '#808080',
  primary: '#fab283',
  secondary: '#5c9cf5',
  success: '#7fd88f',
  warning: '#f5a742',
};

function TuiApp(props: { input: TuiInput; close: () => void }) {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();
  const [logs, setLogs] = createSignal<string[]>([
    'Welcome to agent-bridge TUI',
    'Use /session_new to create a new session.',
  ]);
  let textarea: TextareaRenderable;

  const append = (line: string) => {
    setLogs((prev) => {
      const next = [...prev, ...line.split(/\r?\n/)];
      if (next.length <= 400) return next;
      return next.slice(next.length - 400);
    });
  };

  const submit = async () => {
    const raw = textarea?.plainText ?? '';
    const command = raw.trim();
    textarea?.setText('');
    if (!command) return;

    append(`> ${command}`);
    const shouldClose = await props.input.onCommand(command, append);
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  const sessions = createMemo(() => {
    const values = logs().filter((line) => line.startsWith('[project] '));
    if (values.length > 0) return values.map((line) => line.slice('[project] '.length));
    return ['no projects'];
  });

  const bodyRows = createMemo(() => Math.max(8, dims().height - 9));
  const visibleLogs = createMemo(() => logs().slice(-bodyRows()));

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
      <box backgroundColor={palette.panel} paddingLeft={1} paddingRight={1}>
        <text fg={palette.text} attributes={TextAttributes.BOLD}>agent-bridge</text>
      </box>

      <box backgroundColor={palette.bg} paddingLeft={1} paddingRight={1}>
        <text fg={palette.primary}>/session_new  /projects  /help  /exit</text>
      </box>

      <box>
        <text fg={palette.border}>{''.padEnd(Math.max(1, dims().width), '-')}</text>
      </box>

      <box flexGrow={1}>
        <box width={Math.max(28, Math.floor(dims().width * 0.3))} backgroundColor={palette.panel} flexDirection="column">
          <box paddingLeft={1} paddingRight={1}>
            <text fg={palette.secondary} attributes={TextAttributes.BOLD}>SESSIONS</text>
          </box>
          <For each={sessions().slice(0, Math.max(3, bodyRows() - 8))}>
            {(item) => (
              <box paddingLeft={1} paddingRight={1}>
                <text fg={palette.text}>* {item}</text>
              </box>
            )}
          </For>
          <box paddingLeft={1} paddingTop={1}>
            <text fg={palette.secondary} attributes={TextAttributes.BOLD}>COMMANDS</text>
          </box>
          <box paddingLeft={1}><text fg={palette.text}>/session_new create session</text></box>
          <box paddingLeft={1}><text fg={palette.text}>/projects list projects</text></box>
          <box paddingLeft={1}><text fg={palette.text}>/help show help</text></box>
          <box paddingLeft={1}><text fg={palette.text}>/exit quit</text></box>
        </box>

        <box width={1} backgroundColor={palette.bg}>
          <text fg={palette.border}>|</text>
        </box>

        <box flexGrow={1} backgroundColor={palette.element} flexDirection="column">
          <box paddingLeft={1} paddingRight={1}>
            <text fg={palette.secondary} attributes={TextAttributes.BOLD}>ACTIVITY</text>
          </box>
          <For each={visibleLogs()}>
            {(line) => (
              <box paddingLeft={1} paddingRight={1}>
                <text fg={line.startsWith('✅') ? palette.success : line.startsWith('⚠️') ? palette.warning : palette.text}>{line}</text>
              </box>
            )}
          </For>
        </box>
      </box>

      <box>
        <text fg={palette.border}>{''.padEnd(Math.max(1, dims().width), '-')}</text>
      </box>

      <box backgroundColor={palette.bg} paddingLeft={1} paddingRight={1}>
        <text fg={palette.primary} attributes={TextAttributes.BOLD}>{'agent-bridge> '}</text>
      </box>

      <box backgroundColor={palette.bg} paddingLeft={1} paddingRight={1}>
        <textarea
          ref={(value: TextareaRenderable) => {
            textarea = value;
          }}
          height={2}
          onSubmit={submit}
          keyBindings={[{ name: 'return', action: 'submit' }]}
          placeholder="Type a command"
          textColor={palette.text}
          focusedTextColor={palette.text}
          cursorColor={palette.primary}
        />
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
