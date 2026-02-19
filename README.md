# Discode

<p align="center">
  <img src="./discode.png" alt="Discode" width="220" />
</p>

[English](README.md) | [한국어](docs/README.ko.md)

Bridge AI agent CLIs to Discord for remote monitoring and control.

> Derived from [DoBuDevel/discord-agent-bridge](https://github.com/DoBuDevel/discord-agent-bridge). This project preserves original authorship and builds on top of the upstream work.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-green.svg)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-129%20passing-brightgreen.svg)](./tests)

## Overview

Discoding - run AI coding CLIs locally and relay them to Discord.

I built this after experimenting with OpenClaw.
Even with full system permissions, I realized I preferred conversational control over full autonomy.

Instead of building another dashboard, I wired my AI CLI to Discord.

Discode runs your AI agent in tmux and simply relays output to Discord - no wrappers, no hidden execution layers, no cloud dependency.
- Local-first
- Relay-only architecture
- Persistent tmux sessions
- Single daemon managing multiple projects

![Discode Demo](./discode-demo.gif)

## Features

- **Multi-Agent Support**: Works with Claude Code, Gemini CLI, and OpenCode
- **Auto-Discovery**: Automatically detects installed AI agents on your system
- **Real-Time Streaming**: Sends agent outputs to Discord/Slack through event hooks
- **Project Isolation**: Each project gets a dedicated Discord channel
- **Single Daemon**: One Discord bot connection manages all projects
- **Session Management**: Persistent tmux sessions survive disconnections
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
  - Basic tmux proficiency (session/window/pane navigation, attach/detach) is recommended
- **Discord Bot**: Create a bot following the [Discord Bot Setup Guide](docs/DISCORD_SETUP.md)
  - Required permissions: Send Messages, Manage Channels, Read Message History, Embed Links, Add Reactions
  - Required intents: Guilds, GuildMessages, MessageContent, GuildMessageReactions
- **Slack (optional)**: Use Slack instead of Discord by following the [Slack Setup Guide](docs/SLACK_SETUP.md)
- **AI Agent**: At least one of:
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [OpenCode](https://github.com/OpenCodeAI/opencode)

## Installation

### Global install (npm or Bun)

```bash
npm install -g @siisee11/discode
bun add -g @siisee11/discode
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
```

For local runtime switching and development workflows, see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Uninstall

```bash
discode uninstall
```

Full cleanup (remove config/state/logs and installed bridge plugins too):

```bash
discode uninstall --purge --yes
```

## Quick Start

### 1. Setup Discord Bot

```bash
# One-time onboarding
discode onboard
```

The `onboard` command prompts for your bot token, auto-detects the Discord server ID, lets you choose a default AI CLI, asks whether to enable OpenCode `allow` permission mode, and asks for telemetry opt-in. You can verify or change settings later:

```bash
discode config --show              # View current configuration
discode config --server SERVER_ID  # Change server ID manually
```

> **Note**: `onboard` is required for initial configuration — it auto-detects the server ID by connecting to Discord. The `config` command only updates individual values without auto-detection.

### 2. Start Working

```bash
cd ~/projects/my-app

# Just run new — that's it!
discode new
```

`new` handles everything automatically: detects installed agents, starts the daemon, creates a Discord channel, launches the agent in tmux, and attaches you to the session.

```bash
discode new claude        # Specify an agent explicitly
```

Your AI agent is now running in tmux, with output delivered to Discord/Slack in real time through hooks.

## CLI Reference

### Global Commands

#### `onboard`

One-time onboarding: prompts for bot token, connects to Discord to auto-detect your server, lets you choose your default AI CLI, configures OpenCode permission mode, and asks telemetry opt-in.

```bash
discode onboard
# Optional for non-interactive shells
discode onboard --token YOUR_BOT_TOKEN
```

The onboarding flow will:
1. Save your bot token to `~/.discode/config.json`
2. Connect to Discord and detect which server(s) your bot is in
3. If the bot is in multiple servers, prompt you to select one
4. Let you choose a default AI CLI for `discode new`
5. Ask whether to set OpenCode permission mode to `allow`
6. Warn that non-`allow` mode may cause inconvenient approval prompts in Discord
7. Ask whether to enable anonymous CLI telemetry (opt-in)

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

Open interactive terminal UI. Use `/new` inside the TUI to create a new agent session.

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
discode config --telemetry on      # Enable anonymous CLI telemetry (opt-in)
discode config --telemetry-endpoint https://your-worker.example/v1/events
```

### Project Commands

Run these commands from your project directory.

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

Quick start: start daemon, set up project if needed, and attach to tmux. Auto-detects installed agents and creates the Discord channel automatically.

```bash
discode new              # Auto-detect agent, setup & attach
discode new claude       # Use a specific agent
discode new --no-attach  # Start without attaching to tmux
```

## Supported Agents

| Agent | Binary | Auto-Detect | Notes |
|-------|--------|-------------|-------|
| **Claude Code** | `claude` | Yes | Official Anthropic CLI |
| **Gemini CLI** | `gemini` | Yes | Google Gemini CLI |
| **OpenCode** | `opencode` | Yes | Open-source alternative |

> Note: Codex support is temporarily removed and will be restored once Codex provides hook support. Tracking discussion: https://github.com/openai/codex/discussions/2150

### Agent Detection

The CLI automatically detects installed agents using `command -v <binary>`. Run `discode agents` to see available agents on your system.

## Configuration

### Global Config

Stored in `~/.discode/config.json`:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "serverId": "YOUR_SERVER_ID",
  "hookServerPort": 18470,
  "telemetryEnabled": false
}
```

| Key | Required | Description | Default |
|-----|----------|-------------|---------|
| `token` | **Yes** | Discord bot token. Set via `discode onboard` or `config --token` | - |
| `serverId` | **Yes** | Discord server (guild) ID. Auto-detected by `onboard`, or set via `config --server` | - |
| `hookServerPort` | No | Port for the hook server | `18470` |
| `defaultAgentCli` | No | Default AI CLI used by `discode new` when agent is omitted | First installed CLI |
| `telemetryEnabled` | No | Opt-in flag for anonymous CLI telemetry | `false` |
| `telemetryEndpoint` | No | HTTP endpoint for telemetry proxy (recommended: Cloudflare Worker) | - |
| `telemetryInstallId` | No | Anonymous per-install random ID used as GA client ID | Auto-generated on opt-in |

```bash
discode config --show               # View current config
discode config --token NEW_TOKEN     # Update bot token
discode config --server SERVER_ID    # Set server ID manually
discode config --port 18470          # Set hook server port
discode config --telemetry on        # Enable anonymous telemetry
discode config --telemetry-endpoint https://your-worker.example/v1/events
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
| `TMUX_SESSION_PREFIX` | No | Prefix for tmux session names | `` |
| `TMUX_SHARED_SESSION_NAME` | No | Shared tmux session name (without prefix) | `bridge` |
| `DISCODE_DEFAULT_AGENT_CLI` | No | Default AI CLI used by `discode new` when agent is omitted | First installed CLI |
| `HOOK_SERVER_PORT` | No | Port for the hook server | `18470` |
| `DISCODE_TELEMETRY_ENABLED` | No | Enable telemetry without writing config (`true/false`) | `false` |
| `DISCODE_TELEMETRY_ENDPOINT` | No | Telemetry proxy endpoint URL | - |
| `DISCODE_TELEMETRY_INSTALL_ID` | No | Override anonymous install ID | - |

```bash
DISCORD_BOT_TOKEN=token discode daemon start
DISCORD_GUILD_ID=server_id discode new
```

### Telemetry Proxy (GA4)

Deploy Cloudflare Worker proxy:

```bash
npm run telemetry:deploy
npm run telemetry:secret
```

Then point CLI telemetry to your deployed Worker URL:

```bash
discode config --telemetry-endpoint https://discode-telemetry-proxy.<your-subdomain>.workers.dev
discode config --telemetry on
```

Worker source: `workers/telemetry-proxy`

## Development

Architecture overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
Module boundaries: [docs/MODULE_BOUNDARIES.md](docs/MODULE_BOUNDARIES.md)

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
- Hook-based event delivery
- CLI commands
- Storage and execution mocks

### Project Structure

```
discode/
├── bin/                  # CLI entry point (discode)
├── src/
│   ├── agents/           # Agent adapters (Claude, Gemini, OpenCode)
│   ├── capture/          # shared message parsing utilities
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

### Tip: Keep running with lid closed (macOS)

If you want Discode to keep working when the laptop lid is closed on battery power, run:

```bash
sudo pmset -b disablesleep 1
```

To revert to normal sleep behavior:

```bash
sudo pmset -b disablesleep 0
```

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
- Powered by [Claude Code](https://code.claude.com/docs/en/overview), [Gemini CLI](https://github.com/google-gemini/gemini-cli), and [OpenCode](https://github.com/OpenCodeAI/opencode)
- Inspired by [OpenClaw](https://github.com/nicepkg/openclaw)'s messenger-based command system. The motivation was to remotely control and monitor long-running AI agent tasks from anywhere via Discord.

## Support

- Issues: [GitHub Issues](https://github.com/siisee11/discode/issues)
- Discord Bot Setup: [Setup Guide](docs/DISCORD_SETUP.md)
- Slack Setup: [Setup Guide](docs/SLACK_SETUP.md)
