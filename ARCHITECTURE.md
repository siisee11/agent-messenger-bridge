# Discode Architecture (Current)

Last updated: 2026-02-20  
Target version: 0.7.5

## 1. Overview

discode is a global daemon bridge that connects:

- Messaging platforms: Discord and Slack
- Agent CLIs: Claude, Gemini, OpenCode
- Local runtime backends: `tmux` or `pty`

Current architecture principles:

- One global daemon owns routing, integrations, runtime control, and stream transport
- CLI commands mutate config/state and orchestrate project lifecycle
- TUI is a client of daemon runtime APIs and the runtime stream socket

## 2. Process Model

Main processes:

- `discode daemon` starts a detached singleton (`~/.discode/daemon.pid`, `~/.discode/daemon.log`)
- Daemon entrypoint is `src/daemon-entry.ts` -> `src/index.ts` (`AgentBridge`)
- Daemon listens on loopback HTTP (`127.0.0.1:${HOOK_SERVER_PORT}`)
- Daemon also serves runtime stream over UDS/named pipe

Runtime notes:

- Built JS daemon entrypoints run with Node (for `node-pty` compatibility)
- TS source fallback runs with Bun
- On macOS, daemon uses `caffeinate -ims` wrapper to avoid sleep suspension

## 3. Runtime Abstraction

`AgentRuntime` interface: `src/runtime/interface.ts`

Implementations:

- `TmuxRuntime` (`src/runtime/tmux-runtime.ts`) via `TmuxManager`
- `PtyRuntime` (`src/runtime/pty-runtime.ts`) process-backed windows (+ optional `node-pty`)

Runtime selection:

- Config key: `runtimeMode: 'tmux' | 'pty'`
- Sources: `~/.discode/config.json`, `DISCODE_RUNTIME_MODE`
- Loader default: `tmux`

## 4. Core Components

- `AgentBridge` (`src/index.ts`): wiring for messaging, routing, hook server, stream server, bootstrap
- `BridgeProjectBootstrap` (`src/bridge/project-bootstrap.ts`): rebuild channel mappings and reinstall agent integrations
- `BridgeMessageRouter` (`src/bridge/message-router.ts`): inbound message routing, attachment handling, submit timing, pending tracking
- `BridgeHookServer` (`src/bridge/hook-server.ts`): HTTP control plane + hook ingress (`/opencode-event`, `/send-files`)
- `RuntimeControlPlane` (`src/runtime/control-plane.ts`): runtime window listing/focus/input/buffer/stop
- `RuntimeStreamServer` (`src/runtime/stream-server.ts`): low-latency frame stream for TUI
- `PendingMessageTracker` (`src/bridge/pending-message-tracker.ts`): reaction lifecycle (`hourglass` -> `check`/`x`)
- `StateManager` (`src/state/index.ts`): persisted projects/instances

## 5. Data Flows

### 5.1 Messaging -> Agent

1. Discord/Slack message arrives in mapped channel
2. Router resolves project instance by `instanceId` or `channelId`
3. Attachments are downloaded into project (`.discode/files`), then `[file:/abs/path]` markers are appended
4. If instance is containerized, downloaded files are injected into container workspace
5. Input is sanitized (non-empty, <= 10000 chars, null-byte stripped)
6. Runtime submission uses type-then-enter with per-agent delay

Submission timing:

- OpenCode: `AGENT_DISCORD_OPENCODE_SUBMIT_DELAY_MS` (default 75ms)
- Others: `DISCODE_SUBMIT_DELAY_MS` (default 300ms)

### 5.2 Agent -> Messaging

1. Agent integrations post events to daemon `POST /opencode-event` (name kept for compatibility)
2. `session.idle` sends assistant text to mapped channel (chunked by platform)
3. File paths are extracted from full turn text, validated inside project root, path strings stripped from text output, then files uploaded
4. `session.error` posts warning and marks pending message as failed

### 5.3 Pending and Fallback Delivery

- Incoming user messages get pending reaction updates
- When stop hooks do not resolve (for interactive terminal states), router runs stable-buffer fallback checks and may post captured terminal block

### 5.4 TUI Runtime I/O

1. TUI connects to runtime stream socket
2. TUI subscribes/focuses windows and receives pushed frames (`frame-styled` or `patch-styled`)
3. TUI sends raw key bytes and resize events over stream
4. Stream transport is required for runtime I/O (HTTP fallback for frame transport is removed)

## 6. Daemon HTTP Control Plane

Implemented in `BridgeHookServer`:

- `POST /reload` - rebuild channel mappings from state
- `POST /send-files` - send validated files to mapped channel
- `POST /opencode-event` - hook ingress from agents

Runtime control endpoints:

- `GET /runtime/windows`
- `POST /runtime/focus`
- `POST /runtime/input`
- `GET /runtime/buffer?windowId=...&since=...`
- `POST /runtime/stop`
- `POST /runtime/ensure`

Body limit:

- 256 KiB max request payload (`413 Payload too large`)

## 7. Runtime Stream Plane

Transport:

- Unix: `~/.discode/runtime.sock`
- Windows: `\\.\pipe\discode-runtime`

Client -> daemon messages:

- `hello`, `subscribe`, `focus`, `input(bytesBase64)`, `resize`

Daemon -> client messages:

- `frame`, `patch`
- `frame-styled`, `patch-styled`
- `window-exit`, `error`

Optional optimization:

- `DISCODE_STREAM_PATCH_DIFF=1` enables patch-diff emission preference

## 8. Runtime-Mode CLI Behavior

- `new`
  - Ensures daemon
  - Creates/resumes instance state and channel mapping
  - `tmux`: starts/attaches tmux window and can bootstrap TUI pane
  - `pty`: ensures runtime window in daemon via `/runtime/ensure`; attach opens TUI
- `attach`
  - `tmux`: attaches/switches tmux target
  - `pty`: focuses runtime window then launches TUI
- `stop`
  - `tmux`: kills tmux window/session + state/channel cleanup
  - `pty`: stops runtime window via `/runtime/stop` + state/channel cleanup
- `status` / `list`
  - Runtime-aware active window detection (`tmux` session/window checks vs `/runtime/windows`)
- `daemon`
  - `start | restart | stop | status`

## 9. Container Isolation Mode

Enabled by config (`containerEnabled`) or `discode new --container`.

Per-instance behavior:

- Creates Docker container from managed image
- Injects credentials and optional plugin/config assets
- Starts agent via `docker start -ai <containerId>` in runtime window
- Runs periodic host sync (`ContainerSync`) for changed files
- On stop: final sync + container stop/remove

Chrome MCP bridge support:

- Daemon may start `ChromeMcpProxy` on `hookServerPort + 1`
- Container config is patched to reach host bridge via `host.docker.internal`

## 10. TUI Status (OpenTUI)

Current TUI (`bin/tui.tsx`) supports:

- Stream-based terminal rendering with styled segments and cursor updates
- Prefix-key workflow (`Ctrl+b`), quick switch (`prefix + 1..9`)
- Runtime input mode vs command mode
- Slash commands (`/new`, `/onboard`, `/list`, `/projects`, `/config`, `/stop`, `/help`)
- Command palette, config dialog, and project/session sidebars
- Clipboard copy for text selection

## 11. State and Config

### 11.1 Config (`~/.discode/config.json`)

Important keys:

- Messaging: `token`, `serverId`, `messagingPlatform`, `slackBotToken`, `slackAppToken`
- Runtime: `runtimeMode`, `hookServerPort`
- Agent defaults/policy: `defaultAgentCli`, `opencodePermissionMode`
- Stop behavior: `keepChannelOnStop`
- Container: `containerEnabled`, `containerSocketPath`, `containerSyncIntervalMs`
- Telemetry: `telemetryEnabled`, `telemetryEndpoint`, `telemetryInstallId`

### 11.2 State (`~/.discode/state.json`)

- Global: `guildId`, `slackWorkspaceId`
- Projects keyed by `projectName`
- Per project: `projectPath`, `tmuxSession`, timestamps
- Per instance: `instanceId`, `agentType`, `tmuxWindow`, `channelId`, `eventHook`, optional container metadata

Compatibility:

- Legacy `tmux*`/`discordChannels` maps are still normalized for backward compatibility

## 12. Operational Notes

- Daemon is global singleton; restart after runtime/config/integration changes
- In `pty` mode, daemon restores missing runtime windows from persisted state at startup
- Agent integrations are reinstalled during bootstrap to keep hooks/plugins consistent
- CLI includes optional telemetry (opt-in) and interactive update prompt for npm releases
