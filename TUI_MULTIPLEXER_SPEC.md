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

Add `src/runtime/pty-runtime.ts` as the non-tmux process runtime.

Implementation strategy:

- Phase 2a (current): shell-backed process runtime with window/session registry and ring buffers
- Phase 2b: swap process backend to true PTY (`node-pty`) when dependency rollout is ready

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


## 5.2.1 Progress snapshot

- Completed:
  - `TmuxRuntime` adapter introduced (`src/runtime/tmux-runtime.ts`)
  - Bridge and resume flow now depend on `AgentRuntime` instead of direct `TmuxManager` usage
  - `PtyRuntime` core scaffold implemented (`src/runtime/pty-runtime.ts`)
  - Runtime unit tests added for tmux adapter and PTY runtime core
  - Daemon runtime control API endpoints added (`/runtime/windows`, `/runtime/focus`, `/runtime/input`, `/runtime/buffer`)
  - TUI command now attempts runtime-first window focus and project-open detection via daemon runtime API
  - TUI now polls active runtime buffer and supports direct text send to focused runtime window
  - Runtime mode config (`tmux|pty`) added and wired into bridge runtime selection
  - CLI commands (`new`, `attach`, `start`, `list`, `status`, `stop`) now branch by runtime mode
  - Stabilization: runtime dispose on bridge stop + request-size guard coverage tests
  - Stream-first PTY path implemented (UDS server/client, frame push, resize/input over stream)
  - Daemon start now restores missing PTY runtime windows from state
- Remaining:
  - Low-latency optimization final pass (safe patch/diff reintroduction behind feature flag)


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


## 5.7 Low-latency Runtime Streaming

Goal:

- Make PTY mode feel tmux-like (low input latency + native terminal updates)
- Remove polling bottlenecks from TUI rendering path

Design direction:

- Keep daemon as process owner for all runtime windows
- Add a local bidirectional stream channel (Unix domain socket) for TUI <-> daemon
- Move from periodic `/runtime/buffer` polling to push-based frame updates

### 5.7.1 Transport

- Add daemon stream server (e.g., `src/runtime/stream-server.ts`)
- Socket path: `~/.discode/runtime.sock`
- Keep existing HTTP runtime endpoints for backward compatibility and fallback

### 5.7.2 Protocol (draft)

- Client -> daemon:
  - `hello { clientId, version }`
  - `subscribe { windowId, cols, rows }`
  - `focus { windowId }`
  - `input { windowId, bytesBase64 }`
  - `resize { windowId, cols, rows }`
- Daemon -> client:
  - `frame { windowId, seq, cursor, lines[] }` (initial)
  - `patch { windowId, seq, ops[] }` (optimized)
  - `window-exit { windowId, code, signal }`
  - `error { code, message }`

### 5.7.3 Rendering model

- Runtime keeps per-window VT state (screen buffer + cursor + attributes)
- TUI applies pushed frame/patch updates directly to terminal panel
- Input path uses raw key bytes, not command-style JSON text handling

### 5.7.4 Phased implementation plan

1. Streaming transport
   - Implement UDS server/client and subscribe/focus/input flow
2. VT state engine
   - Keep persistent terminal state per runtime window and emit frames
3. TUI migration
   - Replace polling with stream subscription for active window
4. Input/resize low-latency path
   - Send raw keys and terminal size events immediately
5. Performance optimization
   - Add frame coalescing and patch/diff updates
6. Stabilization
   - Reconnect handling, daemon restart recovery, backpressure guardrails

### 5.7.5 Acceptance targets

- Input-to-visible latency is consistently low (target: < 50ms perceived)
- `Ctrl+1..9` window switch updates terminal view immediately
- No dependence on `/runtime/buffer` polling in normal PTY mode
- Existing tmux mode behavior remains unchanged

### 5.7.6 Progress snapshot

- Done:
  - UDS transport (`~/.discode/runtime.sock`) added and integrated into daemon/TUI
  - Stream protocol supports `hello`, `subscribe`, `focus`, `input`, `resize`, `frame`, `window-exit`, `error`
  - TUI runtime path is stream-first for input/output; HTTP path is fallback-only
  - Stream reconnect/disconnect handling and runtime transport status visualization added
  - Tests added for stream client/server recovery scenarios
  - Feature-flagged patch/diff reintroduced (`DISCODE_STREAM_PATCH_DIFF=1`)
- Remaining:
  - Further tuning of patch/diff thresholds and jitter controls

## 5.8 tmux-style VT Fidelity Migration

Goal:

- Render agent terminal output closer to tmux fidelity (colors, inline style, cursor-driven full-screen updates)

Plan:

1. Runtime VT screen state
   - Keep per-window incremental VT state (not full-buffer reparsing)
   - Track SGR style and cursor state
2. Styled frame protocol
   - Add `frame-styled` payload with line segments (`text`, `fg`, `bg`, attributes)
3. TUI renderer upgrade
   - Render styled segments directly in terminal panel
   - Keep plain text fallback for compatibility
4. Recovery + fallback
   - Preserve stream-first flow and HTTP fallback safety

Current status:

- Implemented:
  - `VtScreen` incremental terminal state engine (`src/runtime/vt-screen.ts`)
  - `PtyRuntime.getWindowFrame` exposing styled frames
  - Stream protocol + client handling for `frame-styled` and `patch-styled`
  - TUI styled segment rendering path
- Remaining:
  - Higher-fidelity VT coverage parity (additional escape-sequence handling)
  - Feature-flagged patch/diff reintroduction for final CPU/latency optimization


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

Status:

- Phase 0: done
- Phase 1: done
- Phase 2: in progress
- Phase 3: in progress
- Phase 4: done
- Phase 5: done
- Phase 6: done

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
