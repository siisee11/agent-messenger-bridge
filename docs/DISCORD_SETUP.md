# Discord Bot Setup Guide

한국어 버전: [DISCORD_SETUP.ko.md](DISCORD_SETUP.ko.md)

Complete step-by-step guide to setting up your Discord bot for the Discord Agent Bridge.

---

## 1. Creating a Discord Bot

### Step 1.1: Create a New Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click the **"New Application"** button (top right corner)
3. Enter a name for your bot (e.g., "AI Agent Bridge")
4. Accept the Terms of Service and click **"Create"**

### Step 1.2: Create the Bot User

1. In your application page, click on the **"Bot"** tab in the left sidebar
2. Click **"Add Bot"** button
3. Confirm by clicking **"Yes, do it!"**
4. You should see "A wild bot has appeared!" message

### Step 1.3: Copy the Bot Token

1. In the Bot page, find the **"TOKEN"** section
2. Click **"Reset Token"** (first time) or **"Copy"** (if token already exists)
3. **IMPORTANT**: Save this token securely - you'll need it for setup
4. **WARNING**: Never share this token publicly or commit it to git

### Step 1.4: Enable Privileged Gateway Intents

**CRITICAL**: The bot requires specific intents to read message content.

1. Scroll down to the **"Privileged Gateway Intents"** section
2. Enable the following intents:
   - ✅ **MESSAGE CONTENT INTENT** (Required - read message text)
   - ✅ **SERVER MEMBERS INTENT** (Optional)
3. Click **"Save Changes"** at the bottom

> **Note**: The bot also uses the `GuildMessageReactions` intent (non-privileged, enabled automatically) for interactive approval requests.

---

## 2. Getting Your Server ID

### Step 2.1: Enable Developer Mode

1. Open Discord and click the **gear icon** (User Settings) at the bottom left
2. Go to **"Advanced"** in the left sidebar (under "App Settings")
3. Enable **"Developer Mode"** toggle
4. Close settings

### Step 2.2: Copy Server ID

1. Right-click on your **server name** (or server icon) in the server list
2. Click **"Copy Server ID"** at the bottom of the menu
3. Save this ID - you may need it for manual configuration

**Note:**
- The `agent-discord setup` command will auto-detect your server ID if you run it while Discord is active
- Manual configuration: `agent-discord config --server YOUR_SERVER_ID`

---

## 3. Inviting the Bot to Your Server

### Step 3.1: Generate Invite URL

1. Go back to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Click on **"OAuth2"** in the left sidebar
4. Click on **"URL Generator"**

### Step 3.2: Select Scopes

In the **"SCOPES"** section, check:
- ✅ **bot**

### Step 3.3: Select Bot Permissions

In the **"BOT PERMISSIONS"** section that appears below, check:

**Text Permissions:**
- ✅ **Send Messages** - Required to send agent output
- ✅ **Send Messages in Threads** - For thread support
- ✅ **Embed Links** - Required for interactive question embeds
- ✅ **Read Message History** - Required for context tracking and reactions
- ✅ **Add Reactions** - Required for tool approval requests

**General Permissions:**
- ✅ **View Channels** - Required to see and access channels
- ✅ **Manage Channels** - Required for creating agent-specific channels

### Step 3.4: Invite the Bot

1. Copy the **generated URL** at the bottom of the page
2. Open the URL in your web browser
3. Select the **server** you want to add the bot to from the dropdown
4. Click **"Continue"**
5. Review the permissions and click **"Authorize"**
6. Complete the CAPTCHA verification
7. You should see "Success! [Bot Name] has been added to [Server Name]"

---

## 4. Required Bot Permissions

### Minimum Required Permissions

| Permission | Required? | Purpose |
|------------|-----------|---------|
| View Channels | ✅ Yes | Bot must see channels to operate |
| Send Messages | ✅ Yes | Send agent output to Discord |
| Read Message History | ✅ Yes | Track conversation context and collect reactions |
| Embed Links | ✅ Yes | Format rich embeds for interactive questions |
| Manage Channels | ✅ Yes | Auto-create/delete agent channels on `init`/`go`/`stop` |
| Add Reactions | ✅ Yes | Interactive tool approval requests |

### Permission Issues

If the bot cannot send messages, check:
1. Server-level permissions are granted
2. Channel-specific permissions override (check channel settings)
3. Bot role is not placed below other restrictive roles

---

## 5. Verifying Setup

### Step 5.1: Run Setup Command

```bash
agent-discord setup YOUR_BOT_TOKEN
```

Replace `YOUR_BOT_TOKEN` with the token you copied in Step 1.3.

### Step 5.2: Expected Output

**Successful Setup:**
```
✓ Discord bot token configured
✓ Connected to Discord
✓ Bot is online: AI Agent Bridge#1234
✓ Found server: My Awesome Server (ID: 123456789...)
✓ Configuration saved to ~/.discord-agent-bridge/config.json

Setup complete! Your bot is ready to use.

Next steps:
1. Run: agent-discord go
2. The bot will create a channel named 'agent-claude-XXXXX'
3. All Claude CLI output will stream to that channel
```

### Step 5.3: Verify Bot is Online

1. Open Discord
2. Check your server's member list (right sidebar)
3. Look for your bot name with a "BOT" tag
4. The bot should show as **online** (green status)

### Step 5.4: Test with a Command

```bash
agent-discord go
```

Then in your terminal, type a message and press Enter. You should see:
- A new channel created in Discord (if auto-channel is enabled)
- Your message appear in that channel
- Bot responding with agent output

---

## Troubleshooting

### Bot shows as offline

- Check the token is correct
- Verify the bot is invited to your server
- Check network/firewall settings

### Bot cannot send messages

- Verify "Send Messages" permission is granted
- Check channel-specific permission overrides
- Ensure bot role is above other roles that restrict permissions

### "Missing Access" error

- The bot was not properly invited - regenerate the invite URL and invite again
- Check "View Channels" permission is granted

### "Invalid Token" error

- Token may have been regenerated - get a fresh token from Developer Portal
- Ensure no extra spaces when copying the token
- Run `agent-discord setup` again with the new token

### Cannot read messages or detect commands

- **CRITICAL**: Enable "MESSAGE CONTENT INTENT" in Bot settings (Step 1.4)
- Without this intent, the bot cannot read message content

---

## Security Best Practices

1. **Never commit your bot token to git**
   - Use environment variables or config files with proper `.gitignore`

2. **Regenerate token if exposed**
   - If you accidentally share your token, regenerate it immediately in Developer Portal

3. **Limit bot permissions**
   - Only grant permissions the bot actually needs

4. **Use separate bots for testing and production**
   - Create different bot applications for development and live servers

---

## Additional Resources

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Discord Agent Bridge README](../README.md)

---

## Quick Reference Card

```
1. Create bot at: https://discord.com/developers/applications

2. Enable intents: MESSAGE CONTENT INTENT (required)

3. Copy bot token from Bot tab

4. Generate invite URL from OAuth2 > URL Generator
   - Scope: bot
   - Permissions: View Channels, Send Messages, Read Message History

5. Invite bot to server

6. Run: agent-discord setup YOUR_TOKEN

7. Start using: agent-discord go
```

---

**Last Updated**: 2026-02-09
**Version**: 1.0.0
