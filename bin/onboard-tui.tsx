/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */

import { RGBA, TextAttributes, TextareaRenderable } from '@opentui/core';
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/solid';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { copyTextToClipboard } from '../src/cli/common/clipboard.js';

export type OnboardWizardInitialState = {
  platform: 'discord' | 'slack';
  runtimeMode: 'tmux' | 'pty';
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  hasSavedDiscordToken: boolean;
  hasSavedSlackBotToken: boolean;
  hasSavedSlackAppToken: boolean;
  defaultAgentCli?: string;
  telemetryEnabled: boolean;
  opencodePermissionMode: 'allow' | 'default';
  installedAgents: Array<{ name: string; displayName: string }>;
};

export type OnboardWizardResult = {
  platform: 'discord' | 'slack';
  runtimeMode: 'tmux' | 'pty';
  token?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  defaultAgentCli?: string;
  telemetryEnabled: boolean;
  opencodePermissionMode: 'allow' | 'default';
};

type StepKey =
  | 'platform'
  | 'discordToken'
  | 'slackBotToken'
  | 'slackAppToken'
  | 'runtimeMode'
  | 'defaultAgent'
  | 'opencodePermission'
  | 'telemetry'
  | 'review';

type SelectOption<T extends string | boolean = string | boolean> = {
  value: T;
  label: string;
  description?: string;
};

const palette = {
  bg: '#070707',
  panel: '#151515',
  border: '#3d3d3d',
  focus: '#f4a261',
  text: '#efefef',
  muted: '#9a9a9a',
  selectedBg: '#2a2a2a',
  selectedFg: '#ffffff',
  warning: '#f6bd60',
};
const DEBUG_SELECTION = process.env.DISCODE_TUI_DEBUG_SELECTION === '1';

function maskToken(value: string | undefined, hasSaved: boolean): string {
  const trimmed = (value || '').trim();
  if (trimmed.length > 0) {
    return `****${trimmed.slice(-4)}`;
  }
  if (hasSaved) return '(use saved token)';
  return '(not set)';
}

function OnboardWizardApp(props: {
  initial: OnboardWizardInitialState;
  close: (result?: OnboardWizardResult) => void;
}) {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();

  const [platform, setPlatform] = createSignal<'discord' | 'slack'>(props.initial.platform);
  const [runtimeMode, setRuntimeMode] = createSignal<'tmux' | 'pty'>(props.initial.runtimeMode);
  const [discordToken, setDiscordToken] = createSignal(props.initial.discordToken || '');
  const [slackBotToken, setSlackBotToken] = createSignal(props.initial.slackBotToken || '');
  const [slackAppToken, setSlackAppToken] = createSignal(props.initial.slackAppToken || '');
  const [defaultAgentCli, setDefaultAgentCli] = createSignal(props.initial.defaultAgentCli || 'auto');
  const [opencodePermissionMode, setOpencodePermissionMode] = createSignal<'allow' | 'default'>(props.initial.opencodePermissionMode);
  const [telemetryEnabled, setTelemetryEnabled] = createSignal(props.initial.telemetryEnabled);
  const [stepIndex, setStepIndex] = createSignal(0);
  const [optionIndex, setOptionIndex] = createSignal(0);
  const [infoLine, setInfoLine] = createSignal('Enter: next/apply  Esc: back  Ctrl+C: cancel');
  const [selectionDebugLine, setSelectionDebugLine] = createSignal('');
  const [clipboardToast, setClipboardToast] = createSignal<string | undefined>(undefined);
  const [selectionSeedStep, setSelectionSeedStep] = createSignal<StepKey | null>(null);
  const [activeInputStep, setActiveInputStep] = createSignal<StepKey | null>(null);
  let clipboardToastTimer: ReturnType<typeof setTimeout> | undefined;
  let inputArea: TextareaRenderable;

  const cardWidth = createMemo(() => Math.max(56, Math.min(98, dims().width - 4)));
  const cardBodyWidth = createMemo(() => Math.max(40, cardWidth() - 8));

  const defaultAgentOptions = createMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [{
      value: 'auto',
      label: 'Auto detect',
      description: props.initial.installedAgents.length > 0
        ? 'Use the first installed agent automatically'
        : 'No installed AI CLI detected yet',
    }];
    props.initial.installedAgents.forEach((agent) => {
      opts.push({
        value: agent.name,
        label: `${agent.displayName} (${agent.name})`,
      });
    });
    return opts;
  });

  const steps = createMemo<StepKey[]>(() => {
    const flow: StepKey[] = ['platform'];
    if (platform() === 'discord') {
      flow.push('discordToken');
    } else {
      flow.push('slackBotToken', 'slackAppToken');
    }
    flow.push('runtimeMode', 'defaultAgent', 'opencodePermission', 'telemetry', 'review');
    return flow;
  });

  const currentStep = createMemo<StepKey>(() => {
    const flow = steps();
    const safeIdx = Math.max(0, Math.min(stepIndex(), flow.length - 1));
    return flow[safeIdx];
  });

  const isSelectionStep = (step: StepKey): boolean => {
    return step === 'platform'
      || step === 'runtimeMode'
      || step === 'defaultAgent'
      || step === 'opencodePermission'
      || step === 'telemetry';
  };

  const isInputStep = (step: StepKey): boolean => {
    return step === 'discordToken' || step === 'slackBotToken' || step === 'slackAppToken';
  };

  const currentOptions = createMemo<SelectOption<string | boolean>[]>(() => {
    const step = currentStep();
    if (step === 'platform') {
      return [
        { value: 'discord', label: 'Discord', description: 'Use Discord bot + channels' },
        { value: 'slack', label: 'Slack', description: 'Use Slack app + channels' },
      ];
    }
    if (step === 'runtimeMode') {
      return [
        { value: 'pty', label: 'pty (recommended)', description: 'Simple local runtime mode' },
        { value: 'tmux', label: 'tmux', description: 'Advanced tmux-based runtime mode' },
      ];
    }
    if (step === 'defaultAgent') {
      return defaultAgentOptions();
    }
    if (step === 'opencodePermission') {
      return [
        { value: 'allow', label: 'allow (recommended)', description: 'Fewer approval prompts in OpenCode' },
        { value: 'default', label: 'default', description: 'Keep OpenCode default permission behavior' },
      ];
    }
    if (step === 'telemetry') {
      return [
        { value: true, label: 'Enable anonymous telemetry', description: 'Collect command usage metadata only' },
        { value: false, label: 'Disable telemetry', description: 'Do not send telemetry events' },
      ];
    }
    return [];
  });

  const stepTitle = createMemo(() => {
    const step = currentStep();
    if (step === 'platform') return 'Choose Messaging Platform';
    if (step === 'discordToken') return 'Discord Bot Token';
    if (step === 'slackBotToken') return 'Slack Bot Token';
    if (step === 'slackAppToken') return 'Slack App-Level Token';
    if (step === 'runtimeMode') return 'Choose Runtime Mode';
    if (step === 'defaultAgent') return 'Choose Default AI CLI';
    if (step === 'opencodePermission') return 'OpenCode Permission Mode';
    if (step === 'telemetry') return 'Anonymous Telemetry';
    return 'Review Settings';
  });

  const stepDescription = createMemo(() => {
    const step = currentStep();
    if (step === 'platform') return 'Select where discode should relay AI outputs. You can change this later with /config.';
    if (step === 'discordToken') return 'Paste your Discord bot token.';
    if (step === 'slackBotToken') return 'Paste your Slack bot token (xoxb-...).';
    if (step === 'slackAppToken') return 'Paste your Slack app-level token (xapp-...).';
    if (step === 'runtimeMode') return 'Choose runtime backend for agent sessions.';
    if (step === 'defaultAgent') return 'Pick the default AI CLI used by `discode new`.';
    if (step === 'opencodePermission') return 'Set OpenCode permission behavior.';
    if (step === 'telemetry') return 'Telemetry excludes tokens/prompts/paths/content and helps us improve discode.';
    return 'Press Enter to apply these settings.';
  });

  const getSelectionValue = (step: StepKey): string | boolean => {
    if (step === 'platform') return platform();
    if (step === 'runtimeMode') return runtimeMode();
    if (step === 'defaultAgent') return defaultAgentCli();
    if (step === 'opencodePermission') return opencodePermissionMode();
    return telemetryEnabled();
  };

  const getInputValue = (step: StepKey): string => {
    if (step === 'discordToken') return discordToken();
    if (step === 'slackBotToken') return slackBotToken();
    if (step === 'slackAppToken') return slackAppToken();
    return '';
  };

  const setInputValue = (step: StepKey, value: string): void => {
    if (step === 'discordToken') setDiscordToken(value);
    if (step === 'slackBotToken') setSlackBotToken(value);
    if (step === 'slackAppToken') setSlackAppToken(value);
  };

  const goToStep = (nextIdx: number): void => {
    const flow = steps();
    const clamped = Math.max(0, Math.min(nextIdx, flow.length - 1));
    setStepIndex(clamped);
    setInfoLine('Enter: next/apply  Esc: back  Ctrl+C: cancel');
  };

  const validateInputStep = (): string | undefined => {
    const step = currentStep();
    if (step === 'discordToken') {
      if (discordToken().trim().length === 0 && !props.initial.hasSavedDiscordToken) {
        return 'Discord bot token is required. Guide: https://discode.chat/docs/discord-bot';
      }
    }
    if (step === 'slackBotToken') {
      if (slackBotToken().trim().length === 0 && !props.initial.hasSavedSlackBotToken) {
        return 'Slack bot token is required (xoxb-...).';
      }
    }
    if (step === 'slackAppToken') {
      if (slackAppToken().trim().length === 0 && !props.initial.hasSavedSlackAppToken) {
        return 'Slack app-level token is required (xapp-...).';
      }
    }
    return undefined;
  };

  const commitSelectionStep = (): void => {
    const step = currentStep();
    const options = currentOptions();
    const selected = options[optionIndex()];
    if (!selected) return;

    if (step === 'platform' && (selected.value === 'discord' || selected.value === 'slack')) {
      setPlatform(selected.value);
    } else if (step === 'runtimeMode' && (selected.value === 'tmux' || selected.value === 'pty')) {
      setRuntimeMode(selected.value);
    } else if (step === 'defaultAgent' && typeof selected.value === 'string') {
      setDefaultAgentCli(selected.value);
    } else if (step === 'opencodePermission' && (selected.value === 'allow' || selected.value === 'default')) {
      setOpencodePermissionMode(selected.value);
    } else if (step === 'telemetry' && typeof selected.value === 'boolean') {
      setTelemetryEnabled(selected.value);
    }

    goToStep(stepIndex() + 1);
  };

  const commitInputStep = (): void => {
    const error = validateInputStep();
    if (error) {
      setInfoLine(error);
      return;
    }
    goToStep(stepIndex() + 1);
  };

  const finishWizard = (): void => {
    renderer.destroy();
    props.close({
      platform: platform(),
      runtimeMode: runtimeMode(),
      token: discordToken().trim() || undefined,
      slackBotToken: slackBotToken().trim() || undefined,
      slackAppToken: slackAppToken().trim() || undefined,
      defaultAgentCli: defaultAgentCli(),
      telemetryEnabled: telemetryEnabled(),
      opencodePermissionMode: opencodePermissionMode(),
    });
  };

  const setDebugLine = (value: string): void => {
    if (!DEBUG_SELECTION) return;
    setSelectionDebugLine(value);
  };

  const showClipboardToast = (message: string): void => {
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

  const copySelectionToClipboard = async (selectedText?: string): Promise<void> => {
    const selected = selectedText ?? renderer.getSelection()?.getSelectedText();
    if (!selected || selected.length === 0) return;
    try {
      setDebugLine(`[selection] copy start chars=${selected.length}`);
      await copyTextToClipboard(selected, renderer);
      showClipboardToast('Copied to clipboard');
      setDebugLine(`[selection] copy success chars=${selected.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showClipboardToast(`Copy failed: ${message}`);
      setDebugLine(`[selection] copy error: ${message}`);
    } finally {
      renderer.clearSelection();
    }
  };

  createEffect(() => {
    const flow = steps();
    if (stepIndex() >= flow.length) {
      setStepIndex(flow.length - 1);
    }
  });

  useSelectionHandler((selection) => {
    const preview = selection.getSelectedText();
    setDebugLine(`[selection] event dragging=${selection.isDragging ? '1' : '0'} chars=${preview.length}`);
    if (selection.isDragging) return;
    if (!preview || preview.length === 0) return;
    void copySelectionToClipboard(preview);
  });

  createEffect(() => {
    const step = currentStep();
    if (!isSelectionStep(step)) {
      setSelectionSeedStep(null);
      return;
    }
    if (selectionSeedStep() === step) return;
    const options = currentOptions();
    const currentValue = getSelectionValue(step);
    const idx = options.findIndex((option) => option.value === currentValue);
    setOptionIndex(idx >= 0 ? idx : 0);
    setSelectionSeedStep(step);
  });

  createEffect(() => {
    const step = currentStep();
    if (!isInputStep(step)) {
      setActiveInputStep(null);
      if (inputArea && !inputArea.isDestroyed) {
        inputArea.blur();
      }
      return;
    }
    if (activeInputStep() === step) return;
    setActiveInputStep(step);
    setTimeout(() => {
      if (!inputArea || inputArea.isDestroyed) return;
      inputArea.setText(getInputValue(step));
      inputArea.gotoBufferEnd();
      inputArea.focus();
    }, 1);
  });

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === 'c') {
      evt.preventDefault();
      renderer.destroy();
      props.close();
      return;
    }

    if (evt.name === 'escape') {
      evt.preventDefault();
      if (stepIndex() === 0) {
        renderer.destroy();
        props.close();
        return;
      }
      goToStep(stepIndex() - 1);
      return;
    }

    const step = currentStep();

    if (isSelectionStep(step)) {
      if (evt.name === 'up') {
        evt.preventDefault();
        const options = currentOptions();
        if (options.length === 0) return;
        setOptionIndex((optionIndex() - 1 + options.length) % options.length);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        const options = currentOptions();
        if (options.length === 0) return;
        setOptionIndex((optionIndex() + 1) % options.length);
        return;
      }
      if (evt.name === 'return' || evt.name === 'enter') {
        evt.preventDefault();
        commitSelectionStep();
        return;
      }
      return;
    }

    if (step === 'review' && (evt.name === 'return' || evt.name === 'enter')) {
      evt.preventDefault();
      finishWizard();
    }
  });

  onMount(() => {
    setDebugLine('[selection-debug] enabled');
    const step = currentStep();
    if (!isInputStep(step)) return;
    setTimeout(() => {
      if (!inputArea || inputArea.isDestroyed) return;
      inputArea.focus();
    }, 1);
  });

  onCleanup(() => {
    if (clipboardToastTimer) {
      clearTimeout(clipboardToastTimer);
      clipboardToastTimer = undefined;
    }
  });

  return (
    <box
      width={dims().width}
      height={dims().height}
      backgroundColor={palette.bg}
      alignItems="center"
      justifyContent="center"
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={(event) => {
        setDebugLine(`[mouse] down x=${event.x} y=${event.y} btn=${event.button}`);
      }}
      onMouseDrag={(event) => {
        setDebugLine(`[mouse] drag x=${event.x} y=${event.y}`);
      }}
      onMouseUp={(event) => {
        setDebugLine(`[mouse] up x=${event.x} y=${event.y} btn=${event.button}`);
      }}
    >
      <box
        width={cardWidth()}
        backgroundColor={palette.panel}
        border
        borderColor={palette.border}
        flexDirection="column"
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={palette.text} attributes={TextAttributes.BOLD}>Discode Onboarding</text>
          <text fg={palette.muted}>{`Step ${stepIndex() + 1}/${steps().length}`}</text>
        </box>

        <box marginTop={1} flexDirection="column">
          <text fg={palette.focus} attributes={TextAttributes.BOLD}>{stepTitle()}</text>
          <text fg={palette.muted}>{stepDescription()}</text>
        </box>

        <box marginTop={1} flexDirection="column">
          <Show when={isSelectionStep(currentStep())}>
            <For each={currentOptions()}>
              {(option, idx) => (
                <box
                  backgroundColor={optionIndex() === idx() ? palette.selectedBg : palette.panel}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={optionIndex() === idx() ? palette.selectedFg : palette.text}>{option.label}</text>
                  <Show when={option.description}>
                    <text fg={palette.muted}>{`  ${option.description}`}</text>
                  </Show>
                </box>
              )}
            </For>
          </Show>

          <Show when={isInputStep(currentStep())}>
            <Show when={currentStep() === 'discordToken'}>
              <text fg={palette.muted}>Guide: https://discode.chat/docs/discord-bot</text>
              <text fg={palette.muted}>
                {props.initial.hasSavedDiscordToken
                  ? 'Leave empty to keep the saved token.'
                  : 'A token is required to continue.'}
              </text>
            </Show>
            <Show when={currentStep() === 'slackBotToken'}>
              <text fg={palette.muted}>
                {props.initial.hasSavedSlackBotToken
                  ? 'Leave empty to keep the saved bot token.'
                  : 'Enter xoxb-... token.'}
              </text>
            </Show>
            <Show when={currentStep() === 'slackAppToken'}>
              <text fg={palette.muted}>
                {props.initial.hasSavedSlackAppToken
                  ? 'Leave empty to keep the saved app token.'
                  : 'Enter xapp-... token.'}
              </text>
            </Show>
            <box width={cardBodyWidth()} border borderColor={palette.border} marginTop={1} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={(r: TextareaRenderable) => {
                  inputArea = r;
                }}
                minHeight={1}
                maxHeight={1}
                onSubmit={commitInputStep}
                keyBindings={[{ name: 'return', action: 'submit' }]}
                placeholder="Type value and press Enter"
                textColor={palette.text}
                focusedTextColor={palette.text}
                cursorColor={palette.focus}
                onContentChange={() => {
                  const step = currentStep();
                  if (!isInputStep(step)) return;
                  setInputValue(step, inputArea.plainText);
                }}
              />
            </box>
          </Show>

          <Show when={currentStep() === 'review'}>
            <box flexDirection="column">
              <text fg={palette.text}>{`platform: ${platform()}`}</text>
              <text fg={palette.text}>
                {platform() === 'discord'
                  ? `discord token: ${maskToken(discordToken(), props.initial.hasSavedDiscordToken)}`
                  : `slack bot token: ${maskToken(slackBotToken(), props.initial.hasSavedSlackBotToken)}`}
              </text>
              <Show when={platform() === 'slack'}>
                <text fg={palette.text}>{`slack app token: ${maskToken(slackAppToken(), props.initial.hasSavedSlackAppToken)}`}</text>
              </Show>
              <text fg={palette.text}>{`runtime mode: ${runtimeMode()}`}</text>
              <text fg={palette.text}>{`default agent: ${defaultAgentCli() === 'auto' ? '(auto)' : defaultAgentCli()}`}</text>
              <text fg={palette.text}>{`opencode permission: ${opencodePermissionMode()}`}</text>
              <text fg={palette.text}>{`telemetry: ${telemetryEnabled() ? 'enabled' : 'disabled'}`}</text>
            </box>
          </Show>
        </box>

        <box marginTop={1} border borderColor={palette.border} backgroundColor={RGBA.fromInts(255, 255, 255, 8)} paddingLeft={1} paddingRight={1}>
          <text fg={infoLine().startsWith('Discord bot token is required') || infoLine().startsWith('Slack') ? palette.warning : palette.muted}>
            {infoLine()}
          </text>
        </box>
        <Show when={DEBUG_SELECTION}>
          <box marginTop={1} border borderColor={palette.border} backgroundColor={RGBA.fromInts(255, 255, 255, 8)} paddingLeft={1} paddingRight={1}>
            <text fg={palette.muted}>{selectionDebugLine() || '[selection-debug] enabled'}</text>
          </box>
        </Show>
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
    </box>
  );
}

export function runOnboardTui(initial: OnboardWizardInitialState): Promise<OnboardWizardResult | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const close = (result?: OnboardWizardResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    void render(() => <OnboardWizardApp initial={initial} close={close} />, {
      targetFps: 60,
      exitOnCtrlC: false,
      autoFocus: true,
    });
  });
}
