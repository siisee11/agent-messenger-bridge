# Discode Architecture (Current)

Last updated: 2026-02-18  
Target version: 0.7.x

## 1. Overview

discode is a global daemon-based bridge that connects:

- Messaging platforms (Discord, Slack)
- Agent CLIs (Claude, Gemini, OpenCode)
- Local runtime windows (tmux mode or pty mode)

Core idea:

- Daemon owns routing/state/integration
- CLI commands configure and operate projects
- TUI acts as a multiplexer client (`Ctrl+1..9` quick window focus)


## 2. Runtime Architecture

discode now has a runtime abstraction layer.

- Interface: `src/runtime/interface.ts` (`AgentRuntime`)
- Implementations:
  - `TmuxRuntime` (`src/runtime/tmux-runtime.ts`) -> wraps `TmuxManager`
  - `PtyRuntime` (`src/runtime/pty-runtime.ts`) -> process-backed runtime windows

Runtime selection:

- Config key: `runtimeMode: 'tmux' | 'pty'`
- Source: `~/.discode/config.json` or `DISCODE_RUNTIME_MODE`
- Default: `tmux`


## 3. Main Components

- `AgentBridge` (`src/index.ts`)
  - Bootstraps messaging + hook server + routing
  - Chooses runtime (`TmuxRuntime` or `PtyRuntime`)
- `BridgeMessageRouter` (`src/bridge/message-router.ts`)
  - Routes inbound user messages to runtime windows
  - Handles OpenCode type-then-enter submission behavior
- `BridgeHookServer` (`src/bridge/hook-server.ts`)
  - Receives agent events and runtime control requests
- `BridgeProjectBootstrap` (`src/bridge/project-bootstrap.ts`)
  - Rebuilds channel mappings from persisted state
- `StateManager` (`src/state/index.ts`)
  - Persists projects/instances (`~/.discode/state.json`)


## 4. Data Flow

### 4.1 Messaging -> Agent

1. User sends message in Discord/Slack channel
2. Messaging client resolves channel -> project/instance mapping
3. `BridgeMessageRouter` sends input via `AgentRuntime`

### 4.2 Agent -> Messaging

1. Agent integration hook posts event to daemon (`/opencode-event`)
2. Hook server parses/splits text
3. Messaging client posts updates to the mapped channel

### 4.3 TUI Multiplexer Control

1. TUI polls daemon runtime endpoints
2. TUI quick-switches windows with `Ctrl+1..9`
3. TUI sends direct input to active runtime window when focused


## 5. Runtime Control Plane (Daemon HTTP)

Implemented in `BridgeHookServer` + `RuntimeControlPlane`:

- `POST /reload` - reload channel mappings
- `POST /send-files` - send files to mapped channel
- `POST /opencode-event` - agent event ingress

Runtime endpoints:

- `GET /runtime/windows` - list windows + active window
- `POST /runtime/focus` - focus a window
- `POST /runtime/input` - send text/enter to a window
- `GET /runtime/buffer?windowId=...&since=...` - incremental output buffer
- `POST /runtime/stop` - stop a runtime window
- `POST /runtime/ensure` - ensure project instance window exists (used by `discode new` in pty mode)

Request body size is limited (413 for oversized payload).


## 6. CLI Behavior by Runtime Mode

Relevant commands now branch by runtime mode:

- `new`
  - `tmux`: tmux session/window flow + attach option
  - `pty`: skips tmux pane bootstrap, ensures daemon runtime window, opens TUI on attach
- `attach`
  - `tmux`: attach/switch tmux target
  - `pty`: focus runtime window then launch TUI
- `start` / `stop` / `list` / `status`
  - use runtime-mode-aware logic
- `daemon`
  - actions: `start | restart | stop | status`


## 7. TUI Multiplexer Status

Current TUI (`bin/tui.tsx`) supports:

- Project/window list refresh polling
- `Ctrl+1..9` quick switch
- Active window metadata display
- Active window output snippet via runtime buffer polling
- Command palette/flow with runtime-aware attach behavior


## 8. State and Config

### 8.1 Config (`~/.discode/config.json`)

Important keys:

- `token`, `serverId`
- `messagingPlatform` (`discord` | `slack`)
- `defaultAgentCli`
- `opencodePermissionMode`
- `hookServerPort`
- `runtimeMode` (`tmux` | `pty`)

### 8.2 State (`~/.discode/state.json`)

Project-centric persisted model with instance-level metadata:

- `projectName`, `projectPath`, `tmuxSession`
- `instances[instanceId]`:
  - `instanceId`, `agentType`, `tmuxWindow`, `channelId`, `eventHook`

Note: field names still include `tmux*` for compatibility, even when running pty mode.


## 9. Module Map (High-level)

- `src/index.ts` - `AgentBridge`
- `src/bridge/*` - routing, hook server, bootstrap, pending tracker
- `src/runtime/*` - runtime abstraction + implementations
- `src/tmux/*` - tmux command layer
- `src/agents/*` - adapter registry and agent adapters
- `src/state/*` - persisted state
- `src/config/*` - config loading/merge/validation
- `src/cli/commands/*` - user commands
- `bin/discode.ts` - CLI entry
- `bin/tui.tsx` - OpenTUI UI


## 10. Operational Notes

- Daemon is global singleton (pid/log in `~/.discode`)
- If runtime/config code changes, restart daemon to apply:

```bash
discode daemon restart
```

- For pty mode:

```bash
discode config --runtime-mode pty
discode daemon restart
```
