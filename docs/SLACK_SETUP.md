# Slack Setup Guide

This guide walks you through connecting Discode to Slack instead of Discord.

## Prerequisites

- Node.js 18+ or Bun 1.3+
- Discode installed (`npm install -g @siisee11/discode`)
- A Slack workspace where you have permission to install apps

## 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Name it (e.g. `Discode Bot`) and select your workspace
4. Click **Create App**

## 2. Enable Socket Mode

1. In your app settings, go to **Socket Mode** (left sidebar)
2. Toggle **Enable Socket Mode** to On
3. You'll be prompted to create an **App-Level Token**:
   - Name: `discode-socket`
   - Scope: `connections:write`
   - Click **Generate**
4. **Copy the `xapp-...` token** — you'll need this later

## 3. Configure Bot Token Scopes

1. Go to **OAuth & Permissions** (left sidebar)
2. Under **Scopes → Bot Token Scopes**, add these scopes:

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages in public channels |
| `channels:manage` | Create and archive channels |
| `channels:read` | List channels |
| `groups:read` | List private channels |
| `chat:write` | Send messages |
| `files:read` | Access shared files |
| `files:write` | Upload files |
| `reactions:read` | Read emoji reactions |
| `reactions:write` | Add/remove reactions |

## 4. Enable Event Subscriptions

1. Go to **Event Subscriptions** (left sidebar)
2. Toggle **Enable Events** to On
3. Under **Subscribe to bot events**, add:
   - `message.channels` — messages in public channels

> Socket Mode handles event delivery, so no Request URL is needed.

## 5. Install App to Workspace

1. Go to **Install App** (left sidebar)
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. **Copy the `xoxb-...` Bot User OAuth Token**

## 6. Configure Discode

Run the onboarding command:

```bash
discode onboard --platform slack
```

This will prompt you for:
- **Slack Bot Token** (`xoxb-...`) — from step 5
- **Slack App-Level Token** (`xapp-...`) — from step 2

Or set tokens directly:

```bash
discode config --platform slack \
  --slack-bot-token xoxb-your-bot-token \
  --slack-app-token xapp-your-app-token
```

## 7. Start Using Discode

```bash
cd your-project
discode new claude
```

Discode will:
1. Create a Slack channel (e.g. `#your-project-claude`)
2. Launch the AI agent in a tmux session
3. Bridge messages between Slack and the agent

## Differences from Discord

| Feature | Discord | Slack |
|---------|---------|-------|
| Message limit | 2,000 chars | 40,000 chars |
| Channel delete | Hard delete | Archive (soft delete) |
| File downloads | Public CDN URLs | Requires `Authorization` header |
| Reactions | Unicode emoji | Slack emoji names |
| Server/Workspace | Guild | Workspace |
| Message ID | Snowflake ID | Timestamp (`ts`) |

## Environment Variables

You can also configure via environment variables:

```bash
export MESSAGING_PLATFORM=slack
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
```

## Troubleshooting

### Bot doesn't respond to messages
- Ensure the bot is invited to the channel (mention `@Discode Bot` or use `/invite`)
- Check that `message.channels` event subscription is enabled
- Verify Socket Mode is enabled

### Cannot create channels
- Ensure the bot has `channels:manage` scope
- Workspace admins may need to allow bots to create channels

### File uploads fail
- Ensure the bot has `files:write` scope
- Check file size limits (Slack allows up to 1GB depending on plan)
