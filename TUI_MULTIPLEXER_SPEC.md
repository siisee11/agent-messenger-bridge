# TUI Multiplexer Spec

## 1) Objective

Implement a built-in multiplexer inside `discode tui` so tmux is no longer required for multi-agent window management.

Primary UX requirement:

- Switch windows with `Ctrl+1`, `Ctrl+2`, `Ctrl+3`, ... (up to at least 9)
- One agent per window
- Daemon owns agent processes so sessions survive TUI restart


## 2) Scope

### In scope

- Runtime abstraction to decouple bridge logic from tmux
- New PTY-based runtime implementation
- Daemon control API for TUI multiplexer operations
- TUI window list + active window switching via `Ctrl+1..9`
- Input routing to active window
- Output streaming (or polling) from daemon-owned window buffers

### Out of scope (phase 1)

- Removing tmux code immediately
- Full terminal emulation parity with tmux split panes
- Rich pane layout management (horizontal/vertical resizing)


## 3) Current State (As-Is)

- Core bridge and message routing are tightly coupled to `TmuxManager`
- CLI commands (`new`, `attach`, `stop`, `list`, `status`) assume tmux session/window model
- TUI currently acts as control UI and uses tmux attach semantics
- Daemon has HTTP endpoints for hooks/reload, but no runtime window control plane


## 4) Target State (To-Be)

### 4.1 Runtime model

- Introduce `AgentRuntime` as the runtime contract used by bridge services
- Provide two implementations during migration:
  - `TmuxRuntime` (compatibility)
  - `PtyRuntime` (new default target)

### 4.2 Ownership model

- Daemon process owns all agent processes and window buffers
- TUI becomes a client of daemon control API
- Restarting TUI must not terminate agent windows

### 4.3 Window model

- `windowId = <projectName>#<instanceId>` (stable logical key)
- Each window stores:
  - projectName
  - instanceId
  - agentType
  - status (starting/running/exited/error)
  - output ring buffer
  - cursor/focus metadata


## 5) Architecture Changes

## 5.1 Runtime interface

Create/expand runtime contract in `src/runtime/interface.ts`:

- lifecycle
  - `startAgentInWindow(...)`
  - `stopWindow(...)`
  - `windowExists(...)`
  - `listWindows(...)`
- I/O
  - `sendKeysToWindow(...)`
  - `typeKeysToWindow(...)`
  - `sendEnterToWindow(...)`
  - `getWindowBuffer(...)`
- metadata
  - `getWindowState(...)`

Design rule: bridge modules should only depend on this interface, never directly on tmux.


## 5.2 PTY runtime

Add `src/runtime/pty-runtime.ts` using a PTY library (recommended: `node-pty`).

Responsibilities:

- Spawn agent process in PTY per window
- Maintain in-memory window registry
- Maintain ring buffers per window (configurable max lines/bytes)
- Convert inbound text input to PTY writes
- Track process exit and restart policy (manual restart in phase 1)

Implementation notes:

- Use `cwd = projectPath`
- Inject existing env contract (`AGENT_DISCORD_PROJECT`, `AGENT_DISCORD_PORT`, `AGENT_DISCORD_AGENT`, `AGENT_DISCORD_INSTANCE`)
- Keep shell command generation from adapters as-is for compatibility


## 5.3 Daemon control API

Extend daemon HTTP server (`src/bridge/hook-server.ts` or separate control server module) with local-only endpoints:

- `GET /runtime/windows`
  - returns window list + state + active window
- `POST /runtime/focus`
  - body: `{ windowId }`
- `POST /runtime/input`
  - body: `{ windowId, text, submit }`
- `GET /runtime/buffer?windowId=...&since=...`
  - incremental buffer fetch for TUI polling

Security constraints:

- bind `127.0.0.1` only
- reject requests larger than safe threshold
- validate window ownership/project mapping


## 5.4 TUI multiplexer UI

Update `bin/tui.tsx` + `src/cli/commands/tui.ts`:

- Maintain `activeWindowIndex` and `activeWindowId`
- Render top window bar (up to 9 quick slots)
- Handle `Ctrl+1..9` to focus slots directly
- Input box routes to active window by default
- Poll daemon for window list and buffer updates

Keyboard behavior:

- `Ctrl+1..9`: focus quick window slot
- fallback (optional): `Ctrl+Tab` next, `Ctrl+Shift+Tab` previous
- when modal/dialog open, quick-switch keys are ignored


## 5.5 CLI behavior updates

Files: `src/cli/commands/new.ts`, `attach.ts`, `stop.ts`, `list.ts`, `status.ts`, common tmux helpers.

Target behavior:

- `new`: create project+instance and ensure runtime window starts
- `attach`: in PTY mode, open `discode tui` focused on selected window (no tmux attach)
- `stop`: stop selected runtime window/process and clean state
- `list/status`: show runtime windows and process status instead of tmux session status


## 5.6 Config and compatibility strategy

Add runtime mode in config (`StoredConfig` + `BridgeConfig`):

- `runtimeMode: 'tmux' | 'pty'`
- default for migration phase: `'tmux'`
- enable `'pty'` via config/flag for incremental rollout

Compatibility policy:

- Do not remove tmux code until PTY mode passes all acceptance tests
- Keep tmux as fallback for one release cycle


## 6) Data Model Changes

`ProjectState` and instance metadata updates:

- Keep existing fields (`tmuxSession`, `tmuxWindow`) for backward compatibility
- Add runtime-neutral fields:
  - `runtimeSession?: string`
  - `runtimeWindow?: string`
  - `runtimeKind?: 'tmux' | 'pty'`

Migration rule:

- On load, if new fields missing, derive from legacy tmux fields
- On save, write both during transition window


## 7) Implementation Plan (Phased)

## Phase 0 - Freeze spec and interfaces

- Finalize this document
- Finalize `AgentRuntime` method set
- Add/update tests for interface usage boundaries

Exit criteria:

- No bridge module imports `TmuxManager` directly except runtime adapters


## Phase 1 - Runtime abstraction extraction

- Refactor `AgentBridge`, `BridgeMessageRouter`, project service to use `AgentRuntime`
- Keep tmux behavior unchanged via `TmuxRuntime` adapter

Exit criteria:

- Existing tests pass with tmux-backed runtime


## Phase 2 - PTY runtime core

- Implement `PtyRuntime` process/window registry + ring buffers
- Add unit tests for spawn, input, output, exit transitions

Exit criteria:

- Can launch agents and send input without tmux in isolated tests


## Phase 3 - Daemon control API

- Add window list/focus/input/buffer endpoints
- Add validation and error handling

Exit criteria:

- TUI can query windows and submit input via daemon API


## Phase 4 - TUI multiplexer behavior

- Implement window bar, active focus state, output panel binding
- Implement `Ctrl+1..9` switching
- Keep existing slash command workflow

Exit criteria:

- User can create multiple agent windows and switch with `Ctrl+1..9`


## Phase 5 - CLI semantic updates

- Remove hard tmux requirement paths for PTY mode
- `attach/list/status/stop` reflect runtime mode

Exit criteria:

- Core CLI works in PTY mode end-to-end


## Phase 6 - Stabilization

- Soak tests, cleanup stale process handling, memory guardrails
- Documentation updates

Exit criteria:

- PTY mode can be promoted to default


## 8) Testing Strategy

### Unit tests

- `runtime/pty-runtime` process lifecycle
- ring buffer truncation correctness
- runtime API validation and error paths

### Integration tests

- daemon + runtime + message router input delivery
- multi-window focus switch with `Ctrl+1..9`
- stop/restart/recover behavior

### Manual E2E checklist

1. `discode new claude`
2. `discode new gemini --instance gemini-2`
3. open TUI and verify two windows appear
4. press `Ctrl+1` and `Ctrl+2` and confirm focus changes
5. send messages from Discord/Slack and confirm correct window routing
6. stop one instance and confirm state/UI sync


## 9) Risks and Mitigations

- PTY behavior differences across macOS/Linux
  - Mitigation: CI matrix + explicit spawn options
- Keybinding inconsistencies in terminal emulators
  - Mitigation: support `Ctrl+1..9` as primary and add fallback shortcuts
- Process leaks/zombies
  - Mitigation: structured teardown and periodic orphan cleanup
- Large output memory growth
  - Mitigation: bounded ring buffers per window


## 10) Acceptance Criteria

- No tmux required in PTY mode for `new`, `attach`, `list`, `status`, `stop`, and message routing
- TUI window switching with `Ctrl+1..9` works reliably
- One agent process per window, tracked by daemon
- Existing tmux mode remains functional during migration


## 11) Rollout Strategy

- Release N: ship PTY mode behind `runtimeMode=pty`
- Release N+1: make PTY default, keep tmux fallback
- Release N+2: remove tmux-only assumptions from user-facing flows
