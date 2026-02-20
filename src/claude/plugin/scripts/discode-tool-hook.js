#!/usr/bin/env node

/**
 * PostToolUse hook — fires after each tool call.
 * Sends a per-tool thread reply to Slack/Discord so the user
 * can see progress in real time instead of a single batch summary.
 */

function shortenPath(fp, maxSegments) {
  var parts = fp.split("/").filter(function (p) { return p.length > 0; });
  if (parts.length <= maxSegments) return parts.join("/");
  return parts.slice(parts.length - maxSegments).join("/");
}

function firstLinePreview(str, maxLen) {
  if (!str) return "";
  var first = str.split("\n")[0].trim();
  if (first.length > maxLen) return first.substring(0, maxLen) + "...";
  return first;
}

function formatToolLine(toolName, toolInput) {
  var input = toolInput && typeof toolInput === "object" ? toolInput : {};

  if (toolName === "Read") {
    var fp = typeof input.file_path === "string" ? input.file_path : "";
    if (!fp) return "";
    return "\uD83D\uDCD6 Read(`" + shortenPath(fp, 4) + "`)";
  }

  if (toolName === "Edit") {
    var fp = typeof input.file_path === "string" ? input.file_path : "";
    if (!fp) return "";
    var short = shortenPath(fp, 4);
    var detail = "";
    var oldStr = typeof input.old_string === "string" ? input.old_string : "";
    var newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (oldStr || newStr) {
      var oldLines = oldStr ? oldStr.split("\n").length : 0;
      var newLines = newStr ? newStr.split("\n").length : 0;
      var delta = newLines - oldLines;
      if (delta > 0) detail = " +" + delta + " lines";
      else if (delta < 0) detail = " " + delta + " lines";
    }
    var preview = firstLinePreview(newStr, 40);
    var previewSuffix = preview ? ' \u2014 "' + preview + '"' : "";
    return "\u270F\uFE0F Edit(`" + short + "`)" + detail + previewSuffix;
  }

  if (toolName === "Write") {
    var fp = typeof input.file_path === "string" ? input.file_path : "";
    if (!fp) return "";
    var short = shortenPath(fp, 4);
    var content = typeof input.content === "string" ? input.content : "";
    var lineCount = content ? content.split("\n").length : 0;
    var countSuffix = lineCount > 0 ? " " + lineCount + " lines" : "";
    return "\uD83D\uDCDD Write(`" + short + "`)" + countSuffix;
  }

  if (toolName === "Bash") {
    var cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd) return "";
    var truncated = cmd.length > 100 ? cmd.substring(0, 100) + "..." : cmd;
    return "\uD83D\uDCBB `" + truncated + "`";
  }

  // Skip all other tools (Grep, Glob, Task, AskUserQuestion, etc.)
  return "";
}

function readStdin() {
  return new Promise(function (resolve) {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    var raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (chunk) {
      raw += chunk;
    });
    process.stdin.on("end", function () {
      resolve(raw);
    });
    process.stdin.on("error", function () {
      resolve("");
    });
  });
}

async function postToBridge(port, payload) {
  var hostname = process.env.AGENT_DISCORD_HOSTNAME || "127.0.0.1";
  await fetch("http://" + hostname + ":" + port + "/opencode-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  var inputRaw = await readStdin();
  var input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch (_) {
    input = {};
  }

  var projectName = process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  var agentType = process.env.AGENT_DISCORD_AGENT || "claude";
  var instanceId = process.env.AGENT_DISCORD_INSTANCE || "";
  var port = process.env.AGENT_DISCORD_PORT || "18470";

  var toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  var toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

  var line = formatToolLine(toolName, toolInput);
  if (!line) return;

  try {
    await postToBridge(port, {
      projectName: projectName,
      agentType: agentType,
      ...(instanceId ? { instanceId: instanceId } : {}),
      type: "tool.activity",
      text: line,
    });
  } catch (_) {
    // ignore bridge delivery failures
  }
}

main().catch(function () {
  // ignore
});
