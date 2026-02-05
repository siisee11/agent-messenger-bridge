#!/usr/bin/env bash
# Claude Code PreToolUse hook
# - AskUserQuestion: forwards question to Discord as notification (user responds via Discord message)
# - Other tools: sends approval request to Discord (user reacts with checkmark/X)
# Exit 0 = allow, Exit 2 = deny

set -euo pipefail

# Configuration
BRIDGE_PORT="${AGENT_DISCORD_PORT:-3847}"
PROJECT_NAME="${AGENT_DISCORD_PROJECT:-}"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Skip if project not configured (allow by default)
if [[ -z "$PROJECT_NAME" ]]; then
  exit 0
fi

# Extract tool name
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // .toolName // "unknown"' 2>/dev/null || echo "unknown")

# Handle AskUserQuestion: forward as notification, don't block
if [[ "$TOOL_NAME" == "AskUserQuestion" ]]; then
  # Extract question data from tool input
  TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_input // .input // ""' 2>/dev/null || echo "")

  # Build a readable message from the questions
  MESSAGE=$(echo "$TOOL_INPUT" | jq -r '
    if .questions then
      .questions | to_entries | map(
        "**Q\(.key + 1): \(.value.question)**\n" +
        (.value.options | to_entries | map(
          "  `\(.key + 1)` \(.value.label) — \(.value.description // "")"
        ) | join("\n"))
      ) | join("\n\n")
    else
      "Question from Claude (check terminal)"
    end
  ' 2>/dev/null || echo "Question from Claude (check terminal)")

  NOTIFY_MESSAGE="❓ **Claude is asking a question**\n\n${MESSAGE}\n\n💬 Reply here to answer (your message will be sent to the terminal)"

  # Send notification (fire-and-forget)
  PAYLOAD=$(jq -n --arg msg "$NOTIFY_MESSAGE" '{message: $msg}')
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "http://127.0.0.1:${BRIDGE_PORT}/notify/${PROJECT_NAME}/claude" \
    --max-time 5 >/dev/null 2>&1 || true

  # Always allow AskUserQuestion
  exit 0
fi

# For all other tools: send approval request (blocking, waits for Discord reaction)
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT" \
  "http://127.0.0.1:${BRIDGE_PORT}/approve/${PROJECT_NAME}/claude" \
  --max-time 120 2>/dev/null || echo '{"approved": true}')

# Parse response
APPROVED=$(echo "$RESPONSE" | jq -r '.approved // true' 2>/dev/null || echo "true")

if [[ "$APPROVED" == "true" ]]; then
  exit 0
else
  # Exit 2 = deny the tool use
  exit 2
fi
