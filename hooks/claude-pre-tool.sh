#!/usr/bin/env bash
# Claude Code PreToolUse hook
# - YOLO mode (AGENT_DISCORD_YOLO=1): auto-approve everything
# - AskUserQuestion: forwards question to Discord as notification
# - Other tools: sends approval request to Discord (user reacts with checkmark/X)
# Exit 0 = allow, Exit 2 = deny

set -euo pipefail

# Configuration
BRIDGE_PORT="${AGENT_DISCORD_PORT:-18470}"
PROJECT_NAME="${AGENT_DISCORD_PROJECT:-}"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Skip if project not configured (allow by default)
if [[ -z "$PROJECT_NAME" ]]; then
  exit 0
fi

# Extract tool name
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // .toolName // "unknown"' 2>/dev/null || echo "unknown")

# ── AskUserQuestion: always forward to Discord (even in YOLO mode) ──
if [[ "$TOOL_NAME" == "AskUserQuestion" ]]; then
  TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_input // .input // ""' 2>/dev/null || echo "")

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

  PAYLOAD=$(jq -n --arg msg "$NOTIFY_MESSAGE" '{message: $msg}')
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "http://127.0.0.1:${BRIDGE_PORT}/notify/${PROJECT_NAME}/claude" \
    --max-time 5 >/dev/null 2>&1 || true

  exit 0
fi

# YOLO mode: auto-approve everything else (Claude is running with --dangerously-skip-permissions)
if [[ "${AGENT_DISCORD_YOLO:-}" == "1" ]]; then
  exit 0
fi

# ── All other tools (Bash, Write, Edit, MCP write tools, etc.): require Discord approval ──
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT" \
  "http://127.0.0.1:${BRIDGE_PORT}/approve/${PROJECT_NAME}/claude" \
  --max-time 120 2>/dev/null || echo '{"approved": true}')

APPROVED=$(echo "$RESPONSE" | jq -r '.approved // true' 2>/dev/null || echo "true")

if [[ "$APPROVED" == "true" ]]; then
  exit 0
else
  exit 2
fi
