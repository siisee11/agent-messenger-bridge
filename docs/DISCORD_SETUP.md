# Discord Bot Setup Guide

한국어 버전: [DISCORD_SETUP.ko.md](DISCORD_SETUP.ko.md)

Complete step-by-step guide to setting up your Discord bot for the Discode.

---

## 1. Creating a Discord Bot

### Step 1.1: Create a New Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click the **"New Application"** button (top right corner)
3. Enter a name for your bot (e.g., "Discode")
4. Accept the Terms of Service and click **"Create"**

### Step 1.2: Copy the Bot Token

1. In the Bot page, find the **"TOKEN"** section
2. Click **"Reset Token"** (first time) or **"Copy"** (if token already exists)
3. **IMPORTANT**: Save this token securely - you'll need it for onboarding
4. **WARNING**: Never share this token publicly or commit it to git

### Step 1.3: Enable Privileged Gateway Intents

**CRITICAL**: The bot requires specific intents to read message content.

1. Scroll down to the **"Privileged Gateway Intents"** section
2. Enable the following intents:
   - ✅ **MESSAGE CONTENT INTENT** (Required - read message text)
   - ✅ **SERVER MEMBERS INTENT** (Optional)
3. Click **"Save Changes"** at the bottom

> **Note**: The bot also uses the `GuildMessageReactions` intent (non-privileged, enabled automatically) for interactive approval requests.

---

## 2. Inviting the Bot to Your Server

### Step 2.1: Generate Invite URL

1. Go back to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Click on **"OAuth2"** in the left sidebar
4. Click on **"URL Generator"**

### Step 2.2: Select Scopes

In the **"SCOPES"** section, check:
- ✅ **bot**

### Step 2.3: Select Bot Permissions

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

### Step 2.4: Invite the Bot

1. Copy the **generated URL** at the bottom of the page
2. Open the URL in your web browser
3. Select the **server** you want to add the bot to from the dropdown
4. Click **"Continue"**
5. Review the permissions and click **"Authorize"**
6. Complete the CAPTCHA verification
7. You should see "Success! [Bot Name] has been added to [Server Name]"

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

6. Run: discode onboard

7. Start using: discode new
```

---

**Last Updated**: 2026-02-09
**Version**: 1.0.0
