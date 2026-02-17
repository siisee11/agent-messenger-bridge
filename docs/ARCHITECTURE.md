# Discode Architecture

[English](ARCHITECTURE.md) | [한국어](ARCHITECTURE.ko.md)

## Overview

Discode is a **bridge tool** that connects AI agent CLIs (Claude Code, Gemini, OpenCode) running in local tmux sessions to Discord or Slack for **remote monitoring and control**.

- Run AI coding agents locally in tmux sessions
- Stream agent output to dedicated Discord/Slack channels through event hooks
- Send messages from Discord/Slack back into the agent's tmux session
- Manage multiple projects simultaneously through a single background daemon

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              User                                       │
│                                                                         │
│   ┌──────────────┐       ┌──────────────────┐      ┌───────────────┐   │
│   │  Discord /   │◄─────►│  Phone / PC      │      │ Local terminal│   │
│   │  Slack       │       │  (remote control) │      │ (tmux attach) │   │
│   └──────┬───────┘       └──────────────────┘      └───────┬───────┘   │
└──────────┼─────────────────────────────────────────────────┼───────────┘
           │ WebSocket                                        │
           │                                                  │
┌──────────┼──────────────────────────────────────────────────┼──────────┐
│          ▼                 Daemon Process                    │          │
│  ┌───────────────┐       (bun daemon-entry.ts)              │          │
│  │MessagingClient│       ┌───────────────────┐              │          │
│  │ ┌───────────┐ │◄─────►│   AgentBridge     │              │          │
│  │ │ Discord   │ │       │  (src/index.ts)   │              │          │
│  │ │ Client    │ │       │  orchestrator     │              │          │
│  │ ├───────────┤ │       └────────┬──────────┘              │          │
│  │ │ Slack     │ │                │                         │          │
│  │ │ Client    │ │                │ components              │          │
│  │ └───────────┘ │     ┌─────────┼─────────────┐           │          │
│  └───────────────┘     ▼         ▼             ▼           │          │
│  ┌──────────────┐ ┌────────────────┐ ┌────────────────┐     │          │
│  │MessageRouter │ │Hook Events     │ │HookServer      │     │          │
│  │Discord→tmux  │ │(agent plugins) │ │ :18470 (HTTP)  │     │          │
│  │msg routing   │ │                │ │ /reload        │     │          │
│  └──────┬───────┘ └──────┬─────────┘ │ /send-files    │     │          │
│         │                │           │ /opencode-event │     │          │
│         │                │           └───────┬────────┘     │          │
│         │                │                   ▲               │          │
│         │                │                   │ HTTP POST     │          │
│         ▼                ▼                   │               │          │
│  ┌─────────────────────────────────────┴────────────────────┤          │
│  │                   TmuxManager                            │          │
│  │                 (tmux session mgmt)                       │          │
│  └──────┬──────────┬──────────┬──────────┬──────────────────┘          │
└─────────┼──────────┼──────────┼──────────┼─────────────────────────────┘
          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────┐
│                tmux session: "bridge"                        │
│                                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ window:      │ │ window:      │ │ window:      │  ...   │
│  │ myapp-claude │ │ myapp-gemini │ │ proj2-opencode│       │
│  │              │ │              │ │              │        │
│  │ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │        │
│  │ │Claude    │ │ │ │Gemini    │ │ │ │OpenCode  │ │        │
│  │ │Code CLI  │ │ │ │CLI       │ │ │ │CLI       │ │        │
│  │ └──────────┘ │ │ └──────────┘ │ │ └──────────┘ │        │
│  │ ┌──────────┐ │ │              │ │              │        │
│  │ │TUI pane  │ │ │              │ │              │        │
│  │ └──────────┘ │ │              │ │              │        │
│  └──────────────┘ └──────────────┘ └──────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Discord/Slack to Agent (message input)

User sends a message in a Discord/Slack channel, and it gets routed to the correct agent running in tmux.

```
Discord/Slack channel message
       │
       ▼
MessagingClient (messageCreate event)
       │
       ▼
channelMapping lookup → { projectName, agentType, instanceId }
       │
       ▼
BridgeMessageRouter.onMessage()
       │  ├─ Download attachments → .discode/files/
       │  ├─ Append [file:...] markers
       │  └─ Sanitize input (max 10000 chars)
       │
       ▼
PendingMessageTracker → add ⏳ reaction
       │
       ▼
┌──────┴──────────────────────────┐
│ Agent-specific delivery method   │
├──────────────────────────────────┤
│ Claude/Gemini : sendKeys         │
│ OpenCode      : typeKeys + Enter │
└──────┬──────────────────────────┘
       │
       ▼
Agent receives input in tmux window
```

### 2. Agent to Discord/Slack (output capture)

Agent output is delivered to Discord/Slack via event hooks:

```
Agent plugin (Claude/OpenCode/Gemini)
       │
       │ HTTP POST localhost:18470
       ▼
BridgeHookServer
       │  ├─ /opencode-event (session.idle, session.error)
       │  └─ /send-files (file transfer)
       │
       ▼
MessagingClient.sendToChannel()
       │
       ▼
PendingMessageTracker → ✅ or ❌ reaction
```

### 3. Agent Sending Files

```
Agent calls: .discode/bin/discode-send /path/to/file.png
       │
       │ HTTP POST localhost:18470/send-files
       ▼
BridgeHookServer.handleSendFiles()
       │  validate file exists within project directory
       ▼
MessagingClient.sendToChannelWithFiles()
       │
       ▼
Discord/Slack channel receives file
```

## Project Setup Flow (`discode new`)

```
discode new claude
       │
       ▼
Validate config (token, server ID, etc.)
       │
       ▼
ensureDaemonRunning()  ── start daemon if not running
       │                   (caffeinate -ims bun daemon-entry.ts)
       ▼
setupProjectInstance()
       │
       ├─ 1. Create tmux session + window
       ├─ 2. Create Discord/Slack channel (e.g. myapp-claude)
       ├─ 3. Install agent plugin (~/.claude/plugins/...)
       ├─ 4. Install discode-send script
       ├─ 5. Set env vars + start agent
       └─ 6. Save state to ~/.discode/state.json
       │
       ▼
POST /reload → daemon picks up new channel mapping
       │
       ▼
Split TUI pane + tmux attach
```

## Key Components

| Component | Location | Role |
|-----------|----------|------|
| **CLI** | `bin/discode.ts` | User interface, project creation/management |
| **Daemon** | `src/daemon-entry.ts` | Background process, manages all projects |
| **AgentBridge** | `src/index.ts` | Central orchestrator, composes all subsystems |
| **MessagingClient** | `src/discord/`, `src/slack/` | Bidirectional Discord/Slack communication |
| **TmuxManager** | `src/tmux/manager.ts` | tmux session/window creation, I/O control |
| **BridgeHookServer** | `src/bridge/hook-server.ts` | HTTP server, receives agent plugin events (hook mode) |
| **BridgeMessageRouter** | `src/bridge/message-router.ts` | Routes Discord messages to correct tmux window |
| **AgentRegistry** | `src/agents/` | Claude/Gemini/OpenCode adapters |
| **StateManager** | `src/state/` | Project state persistence (`state.json`) |
| **ConfigManager** | `src/config/` | Configuration management (`config.json`) |
| **TUI** | `bin/tui.tsx` | Solid.js-based interactive terminal UI |

## Module Details

### `src/agents/` - Agent Adapter Registry

Strategy/Adapter pattern with `BaseAgentAdapter` and concrete implementations for each AI CLI. The `AgentRegistry` manages registration and lookup. Each adapter defines the agent's start command, channel suffix, and installation check.

### `src/capture/` - Message Parsing Utilities

- **parser**: Strips ANSI escape codes, splits messages for Discord (1900 chars) / Slack (3900 chars) limits, extracts/strips file paths.

### `src/discord/` & `src/slack/` - Messaging Clients

Both implement the `MessagingClient` interface (`src/messaging/interface.ts`), enabling platform interchangeability. Maintain a `channelMapping` linking channel IDs to `{projectName, agentType, instanceId}`.

### `src/bridge/` - Bridge Coordination Layer

- **BridgeHookServer**: HTTP server on localhost:18470. Handles `/reload`, `/send-files`, `/opencode-event`.
- **BridgeMessageRouter**: Routes incoming messages to the correct tmux window with agent-specific delivery.
- **PendingMessageTracker**: Emoji reactions as delivery status indicators (⏳ → ✅ / ❌).
- **BridgeProjectBootstrap**: On daemon startup, restores all saved projects and re-registers channel mappings.

### `src/tmux/` - tmux Session Management

Wraps tmux CLI commands. Manages sessions, windows, panes. Handles pane resolution (avoiding TUI panes, matching agent-specific panes). Supports TUI pane splitting alongside agent panes.

### `src/state/` - Project State Management

Persists state to `~/.discode/state.json`. Supports multi-instance projects (e.g., `claude`, `claude-2`, `claude-3`). Handles legacy state format migration.

### `src/config/` - Configuration Management

Loads from `~/.discode/config.json` with env var fallbacks. Config priority: stored config > env vars > defaults. File permissions set to `0o600` for security.

### `src/policy/` - Agent Launch & Integration Policies

- **agent-launch**: Builds environment variables and shell export prefixes for agent processes.
- **agent-integration**: Per-agent plugin/hook installation (Claude plugin dir, OpenCode plugin, Gemini hook).
- **window-naming**: Generates tmux window names like `{projectName}-{agentType}`.

### `src/infra/` - Infrastructure Abstractions

DI-friendly wrappers: `FileStorage`, `ShellCommandExecutor`, `SystemEnvironment`. Also includes `FileDownloader` (Discord/Slack attachment cache), `FileInstruction` (agent-specific instruction docs), and `SendScript` (generates `discode-send` for agents).

## File Structure

```
~/.discode/
  ├── config.json      ← Configuration (token, server ID, default agent)
  ├── state.json       ← Project state (channel mappings, instance info)
  ├── daemon.pid       ← Daemon process ID
  └── daemon.log       ← Daemon logs

{project}/.discode/
  ├── bin/discode-send  ← Script for agents to send files
  ├── files/            ← Attachment cache from Discord/Slack
  └── CLAUDE.md         ← Agent-specific file handling instructions
```

## Architectural Patterns

### Dependency Injection

All core classes accept interface-based dependencies in constructors (`IStorage`, `ICommandExecutor`, `IEnvironment`, `IStateManager`). Production implementations are defaults; mocks are injected in tests.

### Strategy/Adapter

Agent adapters are registered in `AgentRegistry`. New agents are added by implementing `BaseAgentAdapter` and registering.

### Event Hooks (Single Mode)

Output capture uses event hooks (HTTP POST from agent plugins).

### Single Daemon, Multiple Projects

One background daemon manages all projects through a shared tmux session. CLI commands communicate with the daemon via `POST /reload`.

### Platform Abstraction

The `MessagingClient` interface allows Discord and Slack to be used interchangeably. The `messagingPlatform` config value selects which client is instantiated.

### Multi-Instance Support

A single project can have multiple agent instances (e.g., `claude`, `claude-2`). Each instance gets its own tmux window and messaging channel.
