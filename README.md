# Discode

[English](README.md) | [한국어](docs/README.ko.md)

Bridge AI agent CLIs to Discord for remote monitoring and collaboration.

> Derived from [DoBuDevel/discord-agent-bridge](https://github.com/DoBuDevel/discord-agent-bridge). This project preserves original authorship and builds on top of the upstream work.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-green.svg)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-129%20passing-brightgreen.svg)](./tests)

## Overview

Discode connects AI coding assistants (Claude Code, OpenCode) to Discord, enabling remote monitoring and collaboration. Watch your AI agents work in real-time through Discord channels, share progress with your team, and track multiple projects simultaneously.

The bridge uses a polling-based architecture that captures tmux pane content every 30 seconds, detects state changes, and streams updates to dedicated Discord channels. Each project gets its own channel, and a single global daemon manages all connections efficiently.

## Features

- **Multi-Agent Support**: Works with Claude Code and OpenCode
- **Auto-Discovery**: Automatically detects installed AI agents on your system
- **Real-Time Streaming**: Captures tmux output and streams to Discord every 30 seconds
- **Project Isolation**: Each project gets a dedicated Discord channel
- **Single Daemon**: One Discord bot connection manages all projects
- **Session Management**: Persistent tmux sessions survive disconnections
- **YOLO Mode**: Optional `--yolo` flag runs Claude Code with `--dangerously-skip-permissions`
- **Sandbox Mode**: Optional `--sandbox` flag runs Claude Code in isolated Docker container
- **Rich CLI**: Intuitive commands for setup, control, and monitoring
- **Type-Safe**: Written in TypeScript with dependency injection pattern
- **Well-Tested**: 129 unit tests with Vitest

## Supported Platforms

| Platform | Supported | Notes |
|----------|-----------|-------|
| **macOS** | Yes | Developed and tested |
| **Linux** | Expected | Should work (tmux-based), not yet tested |
| **Windows (WSL)** | Expected | Should work with tmux installed in WSL, not yet tested |
| **Windows (native)** | No | tmux is not available natively |

## Prerequisites

- **Bun**: Version 1.3 or higher
- **tmux**: Version 3.0 or higher
- **Discord Bot**: Create a bot following the [Discord Bot Setup Guide](docs/DISCORD_SETUP.md)
  - Required permissions: Send Messages, Manage Channels, Read Message History, Embed Links, Add Reactions
  - Required intents: Guilds, GuildMessages, MessageContent, GuildMessageReactions
- **AI Agent**: At least one of:
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [OpenCode](https://github.com/OpenCodeAI/opencode)

## Installation

### Global install

```bash
npm install -g @siisee11/discode
```

### Binary install (no Bun/Node runtime required)

```bash
curl -fsSL https://discode.chat/install | bash
```

Fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/siisee11/discode/main/install | bash
```

### From source

```bash
git clone https://github.com/siisee11/discode.git
cd discode
bun install
bun run build
bun link
```

## Quick Start

### 1. Setup Discord Bot

```bash
# One-time setup with your Discord bot token
discode setup YOUR_DISCORD_BOT_TOKEN
```

The `setup` command saves your token and auto-detects the Discord server ID. You can verify or change settings later:

```bash
discode config --show              # View current configuration
discode config --server SERVER_ID  # Change server ID manually
```

> **Note**: `setup` is required for initial configuration — it auto-detects the server ID by connecting to Discord. The `config` command only updates individual values without auto-detection.

### 2. Start Working

```bash
cd ~/projects/my-app

# Just run new — that's it!
discode new
```

`new` handles everything automatically: detects installed agents, starts the daemon, creates a Discord channel, launches the agent in tmux, and attaches you to the session.

```bash
discode new claude        # Specify an agent explicitly
discode new --yolo        # YOLO mode (skip permissions, Claude Code only)
discode new --sandbox     # Sandbox mode (Docker isolation, Claude Code only)
```

Your AI agent is now running in tmux, with output streaming to Discord every 30 seconds.

### Advanced: Step-by-Step Setup

For more control over project configuration, use `init` to set up the project separately:

```bash
cd ~/projects/my-app

# Initialize with a specific agent and custom channel description
discode init claude "My awesome application"

# Then start step-by-step:
discode daemon start    # Start global daemon
discode start          # Start this project
discode attach         # Attach to tmux session
```

## CLI Reference

### Global Commands

#### `setup <token>`

One-time setup: saves bot token, connects to Discord to auto-detect your server, and shows installed agents.

```bash
discode setup YOUR_BOT_TOKEN
```

The setup process will:
1. Save your bot token to `~/.discode/config.json`
2. Connect to Discord and detect which server(s) your bot is in
3. If the bot is in multiple servers, prompt you to select one
4. Save the server ID automatically

#### `daemon <action>`

Control the global daemon process.

```bash
discode daemon start    # Start daemon
discode daemon stop     # Stop daemon
discode daemon status   # Check daemon status
```

#### `list`

List all registered projects.

```bash
discode list
```

#### `agents`

List available AI agents detected on your system.

```bash
discode agents
```

#### `tui`

Open interactive terminal UI. Use `/session_new` (or `/new`) inside the TUI to create a new agent session.

```bash
discode tui
```

#### `config [options]`

View or update global configuration.

```bash
discode config --show              # Show current configuration
discode config --token NEW_TOKEN   # Update bot token
discode config --server SERVER_ID  # Set Discord server ID manually
discode config --port 18470        # Set hook server port
```

### Project Commands

Run these commands from your project directory.

#### `init <agent> <description>`

Initialize current directory as a project.

```bash
discode init claude "Full-stack web application"
discode init opencode "Data pipeline project"
```

#### `start [options]`

Start the bridge server for registered projects.

```bash
discode start                        # Start all projects
discode start -p my-app             # Start a specific project
discode start -p my-app --attach    # Start and attach to tmux
```

#### `stop [project]`

Stop a project: kills tmux session, deletes Discord channel, and removes project state. Defaults to current directory name if project is not specified.

```bash
discode stop                # Stop current directory's project
discode stop my-app         # Stop a specific project
discode stop --keep-channel # Keep Discord channel (only kill tmux)
```

#### `status`

Show project status.

```bash
discode status
```

#### `attach [project]`

Attach to a project's tmux session. Defaults to current directory name if project is not specified.

```bash
discode attach              # Attach to current directory's project
discode attach my-app       # Attach to a specific project
```

Press `Ctrl-b d` to detach from tmux without stopping the agent.

#### `new [agent] [options]`

Quick start: start daemon, setup project if needed, and attach to tmux. Works without `init` — auto-detects installed agents and creates the Discord channel automatically.

```bash
discode new              # Auto-detect agent, setup & attach
discode new claude       # Use a specific agent
discode new --yolo       # YOLO mode (skip permissions, Claude Code only)
discode new --sandbox    # Sandbox mode (Docker isolation, Claude Code only)
discode new --no-attach  # Start without attaching to tmux
```

## How It Works

### Architecture

```
┌─────────────────┐
│  AI Agent CLI   │  (Claude, OpenCode)
│  Running in     │
│  tmux session   │
└────────┬────────┘
         │
         │ tmux capture-pane (every 30s)
         │
    ┌────▼─────────────┐
    │  CapturePoller   │  Detects state changes
    └────┬─────────────┘
         │
         │ Discord.js
         │
    ┌────▼──────────────┐
    │  Discord Channel  │  #project-name
    └───────────────────┘
```

### Components

- **Daemon Manager**: Single global process managing Discord connection
- **Capture Poller**: Polls tmux panes every 30s, detects changes, sends to Discord
- **Agent Registry**: Factory pattern for multi-agent support (Claude, OpenCode)
- **State Manager**: Tracks project state, sessions, and channels
- **Dependency Injection**: Interfaces for storage, execution, environment (testable, mockable)

### Polling Model

The bridge uses a **polling-based** architecture instead of hooks:

1. Every 30 seconds (configurable), the poller runs `tmux capture-pane`
2. Compares captured content with previous snapshot
3. If changes detected, sends new content to Discord
4. Handles multi-line output, ANSI codes, and rate limiting

This approach is simpler and more reliable than hook-based systems, with minimal performance impact.

### Project Lifecycle

1. **Go / Init**: Registers project in `~/.discode/state.json` and creates a Discord channel
2. **Start**: Launches AI agent in a named tmux session
3. **Polling**: Daemon captures tmux output and streams to Discord
4. **Stop**: Terminates tmux session, deletes channel, and cleans up state
5. **Attach**: User can join tmux session to interact directly

## Supported Agents

| Agent | Binary | Auto-Detect | YOLO Support | Sandbox Support | Notes |
|-------|--------|-------------|--------------|-----------------|-------|
| **Claude Code** | `claude` | Yes | Yes | Yes | Official Anthropic CLI |
| **Codex** | `codex` | Yes | No | No | OpenAI Codex CLI |
| **OpenCode** | `opencode` | Yes | No | No | Open-source alternative |

### Agent Detection

The CLI automatically detects installed agents using `command -v <binary>`. Run `discode agents` to see available agents on your system.

### Adding Custom Agents

To add a new agent, extend the `BaseAgentAdapter` class in `src/agents/`:

```typescript
export class MyAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'myagent',
      displayName: 'My Agent',
      command: 'myagent-cli',
      channelSuffix: 'myagent',
    });
  }

  getStartCommand(projectPath: string, yolo = false, sandbox = false): string {
    return `cd "${projectPath}" && ${this.config.command}`;
  }
}
```

Register your adapter in `src/agents/index.ts`.

## Configuration

### Global Config

Stored in `~/.discode/config.json`:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "serverId": "YOUR_SERVER_ID",
  "hookServerPort": 18470
}
```

| Key | Required | Description | Default |
|-----|----------|-------------|---------|
| `token` | **Yes** | Discord bot token. Set via `discode setup <token>` or `config --token` | - |
| `serverId` | **Yes** | Discord server (guild) ID. Auto-detected by `setup`, or set via `config --server` | - |
| `hookServerPort` | No | Port for the hook server | `18470` |

```bash
discode config --show               # View current config
discode config --token NEW_TOKEN     # Update bot token
discode config --server SERVER_ID    # Set server ID manually
discode config --port 18470          # Set hook server port
```

### Project State

Project state is stored in `~/.discode/state.json` and managed automatically.

### Environment Variables

Config values can be overridden with environment variables:

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | **Yes** (if not in config.json) | Discord bot token | - |
| `DISCORD_GUILD_ID` | **Yes** (if not in config.json) | Discord server ID | - |
| `DISCORD_CHANNEL_ID` | No | Override default channel | Auto-created per project |
| `TMUX_SESSION_PREFIX` | No | Prefix for tmux session names | `agent-` |
| `TMUX_SESSION_MODE` | No | tmux session mode: `shared` (default) or `per-project` | `shared` |
| `TMUX_SHARED_SESSION_NAME` | No | Shared tmux session name (without prefix), used when `TMUX_SESSION_MODE=shared` | `bridge` |
| `HOOK_SERVER_PORT` | No | Port for the hook server | `18470` |

```bash
DISCORD_BOT_TOKEN=token discode daemon start
DISCORD_GUILD_ID=server_id discode new
```

### tmux Session Mode (CLI)

You can also override tmux session behavior via CLI flags (no env vars needed):

```bash
discode new --tmux-session-mode shared --tmux-shared-session-name bridge
```

## Development

### Building

```bash
bun install
bun run build          # Compile TypeScript
bun run dev            # Dev mode
```

### Release Packaging (prebuilt binaries)

```bash
npm run build:release              # Build platform binaries + npm meta package
npm run build:release:binaries:single  # Build only current OS/arch binary
npm run pack:release               # Create npm tarballs in dist/release
```

### Testing

```bash
bun test              # Run all tests
bun run test:watch    # Watch mode
bun run test:coverage # Coverage report
```

Test suite includes 129 tests covering:
- Agent adapters
- State management
- Discord client
- Capture polling
- CLI commands
- Storage and execution mocks

### Project Structure

```
discode/
├── bin/                  # CLI entry point (discode)
├── src/
│   ├── agents/           # Agent adapters (Claude, OpenCode)
│   ├── capture/          # tmux capture, polling, state detection
│   ├── config/           # Configuration management
│   ├── discord/          # Discord client and message handlers
│   ├── infra/            # Infrastructure (storage, shell, environment)
│   ├── state/            # Project state management
│   ├── tmux/             # tmux session management
│   └── types/            # TypeScript interfaces
├── tests/                # Vitest test suite
├── package.json
└── tsconfig.json
```

### Dependency Injection

The codebase uses constructor injection with interfaces for testability:

```typescript
// Interfaces
interface IStorage { readFile, writeFile, exists, unlink, mkdirp, chmod }
interface ICommandExecutor { exec, execVoid }
interface IEnvironment { get, homedir, platform }

// Usage
class DaemonManager {
  constructor(
    private storage: IStorage = new FileStorage(),
    private executor: ICommandExecutor = new ShellCommandExecutor()
  ) {}
}

// Testing
const mockStorage = new MockStorage();
const daemon = new DaemonManager(mockStorage);
```

### Code Quality

- TypeScript strict mode enabled
- ESM modules with `.js` extensions in imports
- Vitest with 129 passing tests
- No unused locals/parameters (enforced by `tsconfig.json`)

## Troubleshooting

### Bot not connecting

1. Verify token: `discode config --show`
2. Check bot permissions in Discord Developer Portal
3. Ensure MessageContent intent is enabled
4. Restart daemon: `discode daemon stop && discode daemon start`

### Agent not detected

1. Run `discode agents` to see available agents
2. Verify agent binary is in PATH: `which claude`
3. Install missing agent and retry

### tmux session issues

1. Check session exists: `tmux ls`
2. Kill stale session: `tmux kill-session -t <session-name>`
3. Restart project: `discode stop && discode start`

### No messages in Discord

1. Check daemon status: `discode daemon status`
2. Check daemon logs
3. Check Discord channel permissions (bot needs Send Messages)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Guidelines

- Add tests for new features
- Maintain TypeScript strict mode compliance
- Follow existing code style
- Update documentation as needed

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Discord.js](https://discord.js.org/)
- Powered by [Claude Code](https://code.claude.com/docs/en/overview) and [OpenCode](https://github.com/OpenCodeAI/opencode)
- Inspired by [OpenClaw](https://github.com/nicepkg/openclaw)'s messenger-based command system. The motivation was to remotely control and monitor long-running AI agent tasks from anywhere via Discord.

## Support

- Issues: [GitHub Issues](https://github.com/siisee11/discode/issues)
- Discord Bot Setup: [Setup Guide](docs/DISCORD_SETUP.md)
