# Discord Agent Bridge

Bridge AI agent CLIs to Discord for remote monitoring and collaboration.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-129%20passing-brightgreen.svg)](./tests)

## Overview

Discord Agent Bridge connects AI coding assistants (Claude Code, OpenCode) to Discord, enabling remote monitoring and collaboration. Watch your AI agents work in real-time through Discord channels, share progress with your team, and track multiple projects simultaneously.

The bridge uses a polling-based architecture that captures tmux pane content every 30 seconds, detects state changes, and streams updates to dedicated Discord channels. Each project gets its own channel, and a single global daemon manages all connections efficiently.

## Features

- **Multi-Agent Support**: Works with Claude Code and OpenCode
- **Auto-Discovery**: Automatically detects installed AI agents on your system
- **Real-Time Streaming**: Captures tmux output and streams to Discord every 30 seconds
- **Project Isolation**: Each project gets a dedicated Discord channel
- **Single Daemon**: One Discord bot connection manages all projects
- **Session Management**: Persistent tmux sessions survive disconnections
- **YOLO Mode**: Optional `--yolo` flag runs agents with `--dangerously-skip-permissions`
- **Sandbox Mode**: Optional `--sandbox` flag runs Claude Code in isolated Docker container
- **Rich CLI**: Intuitive commands for setup, control, and monitoring
- **Type-Safe**: Written in TypeScript with dependency injection pattern
- **Well-Tested**: 129 unit tests with Vitest

## Prerequisites

- **Node.js**: Version 18 or higher
- **tmux**: Version 3.0 or higher
- **Discord Bot**: Create a bot following the [Discord Bot Setup Guide](docs/DISCORD_SETUP.md)
  - Required permissions: Send Messages, Manage Channels, Read Message History, Embed Links, Add Reactions
  - Required intents: Guilds, GuildMessages, MessageContent, GuildMessageReactions
- **AI Agent**: At least one of:
  - [Claude Code](https://claude.ai/claude-code) (requires API key)
  - [OpenCode](https://github.com/OpenCodeAI/opencode) (requires API key)

## Installation

### From npm

```bash
npm install -g discord-agent-bridge
```

### From source

```bash
git clone https://github.com/DoBuDevel/discord-agent-bridge.git
cd discord-agent-bridge
npm install
npm run build
npm link
```

## Quick Start

### 1. Setup Discord Bot

```bash
# One-time setup with your Discord bot token
agent-discord setup YOUR_DISCORD_BOT_TOKEN
```

### 2. Initialize a Project

```bash
# Navigate to your project directory
cd ~/projects/my-app

# Initialize with Claude Code (or 'opencode')
agent-discord init claude "My awesome application"
```

### 3. Start Working

```bash
# Quick start: daemon + project + attach in one command
agent-discord go

# Or step-by-step:
agent-discord daemon start    # Start global daemon
agent-discord start          # Start this project
agent-discord attach         # Attach to tmux session
```

Your AI agent is now running in tmux, with output streaming to Discord every 30 seconds.

## CLI Reference

### Global Commands

#### `setup <token>`

One-time setup: saves bot token, connects to Discord to auto-detect your server, and shows installed agents.

```bash
agent-discord setup YOUR_BOT_TOKEN
```

The setup process will:
1. Save your bot token to `~/.discord-agent-bridge/config.json`
2. Connect to Discord and detect which server(s) your bot is in
3. If the bot is in multiple servers, prompt you to select one
4. Save the server ID automatically

#### `daemon <action>`

Control the global daemon process.

```bash
agent-discord daemon start    # Start daemon
agent-discord daemon stop     # Stop daemon
agent-discord daemon restart  # Restart daemon
agent-discord daemon status   # Check daemon status
```

#### `list`

List all registered projects.

```bash
agent-discord list
```

#### `agents`

List available AI agents detected on your system.

```bash
agent-discord agents
```

#### `config [options]`

View or update global configuration.

```bash
agent-discord config --show              # Show current configuration
agent-discord config --token NEW_TOKEN   # Update bot token
agent-discord config --server SERVER_ID  # Set Discord server ID manually
agent-discord config --port 18470        # Set hook server port
```

### Project Commands

Run these commands from your project directory after `init`.

#### `init <agent> <description>`

Initialize current directory as a project.

```bash
agent-discord init claude "Full-stack web application"
agent-discord init opencode "Data pipeline project"
```

#### `start [options]`

Start the AI agent for this project.

```bash
agent-discord start                    # Normal mode
agent-discord start --yolo            # YOLO mode (skip permissions)
agent-discord start --sandbox         # Sandbox mode (Docker isolation for Claude Code)
agent-discord start --dangerously-skip-permissions  # Same as --yolo
```

#### `stop`

Stop the AI agent for this project.

```bash
agent-discord stop
```

#### `status`

Show project status.

```bash
agent-discord status
```

#### `attach`

Attach to the tmux session for this project.

```bash
agent-discord attach
```

Press `Ctrl-b d` to detach from tmux without stopping the agent.

#### `go [options]`

Quick start: start daemon, start project, and attach.

```bash
agent-discord go              # Normal mode
agent-discord go --yolo      # YOLO mode (skip permissions)
agent-discord go --sandbox   # Sandbox mode (Docker isolation for Claude Code)
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

1. **Init**: Creates `.agent-discord.json` with project metadata
2. **Start**: Launches AI agent in a named tmux session
3. **Polling**: Daemon captures tmux output and streams to Discord
4. **Stop**: Terminates tmux session and cleans up
5. **Attach**: User can join tmux session to interact directly

## Supported Agents

| Agent | Binary | Auto-Detect | YOLO Support | Sandbox Support | Notes |
|-------|--------|-------------|--------------|-----------------|-------|
| **Claude Code** | `claude-code` | Yes | Yes | Yes | Official Anthropic CLI |
| **OpenCode** | `opencode` | Yes | Yes | No | Open-source alternative |

### Agent Detection

The CLI automatically detects installed agents using `which <binary>`. Run `agent-discord agents` to see available agents on your system.

### Adding Custom Agents

To add a new agent, implement the `AgentAdapter` interface in `src/agents/`:

```typescript
export interface AgentAdapter {
  name: string;
  detect(): Promise<boolean>;
  getCommand(projectPath: string, yolo: boolean, sandbox: boolean): string[];
}
```

Register your adapter in `src/agents/index.ts`.

## Configuration

### Global Config

Stored in `~/.discord-agent-bridge/config.json`:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "serverId": "YOUR_SERVER_ID",
  "hookServerPort": 18470
}
```

Both `token` and `serverId` are required. The `setup` command auto-detects the server ID, or you can set it manually:

```bash
agent-discord config --show               # View current config
agent-discord config --server SERVER_ID    # Set server ID manually
```

### Project State

Project state is stored in `~/.discord-agent-bridge/state.json` and managed automatically.

### Environment Variables

Override config with environment variables:

```bash
DISCORD_BOT_TOKEN=token agent-discord daemon start
DISCORD_GUILD_ID=server_id agent-discord go
HOOK_SERVER_PORT=18470 agent-discord go
```

## Development

### Building

```bash
npm install
npm run build          # Compile TypeScript
npm run build:watch    # Watch mode
```

### Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
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
discord-agent-bridge/
├── src/
│   ├── agents/           # Agent adapters (Claude, OpenCode, Codex)
│   ├── core/             # Core logic (daemon, poller, state)
│   ├── infra/            # Infrastructure (storage, shell, env)
│   ├── types/            # TypeScript interfaces
│   ├── cli/              # CLI commands
│   └── bin/              # Entry points
├── tests/                # Vitest test suite
├── package.json
└── tsconfig.json
```

### Dependency Injection

The codebase uses constructor injection with interfaces for testability:

```typescript
// Interfaces
interface IStorage { readFile, writeFile, exists, unlink }
interface ICommandExecutor { execute }
interface IEnvironment { getEnv, getCwd, getHomeDir }

// Usage
class DaemonManager {
  constructor(
    private storage: IStorage = new FileStorage(),
    private executor: ICommandExecutor = new ShellExecutor()
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

1. Verify token: `agent-discord config --show`
2. Check bot permissions in Discord Developer Portal
3. Ensure MessageContent intent is enabled
4. Restart daemon: `agent-discord daemon stop && agent-discord daemon start`

### Agent not detected

1. Run `agent-discord agents` to see available agents
2. Verify agent binary is in PATH: `which claude-code`
3. Install missing agent and retry

### tmux session issues

1. Check session exists: `tmux ls`
2. Kill stale session: `tmux kill-session -t <session-name>`
3. Restart project: `agent-discord stop && agent-discord start`

### No messages in Discord

1. Check daemon status: `agent-discord daemon status`
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
- Powered by [Claude Code](https://claude.ai/claude-code) and [OpenCode](https://github.com/OpenCodeAI/opencode)
- Inspired by [OpenClaw](https://github.com/nicepkg/openclaw)'s messenger-based command system. The motivation was to remotely control and monitor long-running AI agent tasks from anywhere via Discord.

## Support

- Issues: [GitHub Issues](https://github.com/DoBuDevel/discord-agent-bridge/issues)
- Discord Bot Setup: [Setup Guide](docs/DISCORD_SETUP.md)
