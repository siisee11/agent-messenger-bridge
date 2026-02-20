#!/usr/bin/env node
const { openSync, readSync, closeSync, statSync } = require("fs");

function asObject(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  return node;
}

function extractToolUseBlocks(node, depth = 0) {
  if (depth > 10 || node === undefined || node === null) return [];

  if (Array.isArray(node)) {
    return node.flatMap((item) => extractToolUseBlocks(item, depth + 1));
  }

  const obj = asObject(node);
  if (!obj) return [];

  if (obj.type === "tool_use" && typeof obj.name === "string") {
    return [{ name: obj.name, input: obj.input && typeof obj.input === "object" ? obj.input : {} }];
  }

  if (Array.isArray(obj.content)) {
    return extractToolUseBlocks(obj.content, depth + 1);
  }

  return [];
}

function formatPromptText(toolUseBlocks) {
  const parts = [];
  for (const block of toolUseBlocks) {
    if (block.name === "AskUserQuestion") {
      const input = block.input || {};
      const questions = Array.isArray(input.questions) ? input.questions : [];
      for (const q of questions) {
        const qObj = asObject(q);
        if (!qObj) continue;
        const header = typeof qObj.header === "string" ? qObj.header : "";
        const question = typeof qObj.question === "string" ? qObj.question : "";
        if (!question) continue;

        let text = header ? "\u2753 *" + header + "*\n" + question : "\u2753 " + question;
        const options = Array.isArray(qObj.options) ? qObj.options : [];
        for (const opt of options) {
          const optObj = asObject(opt);
          if (!optObj) continue;
          const label = typeof optObj.label === "string" ? optObj.label : "";
          const desc = typeof optObj.description === "string" ? optObj.description : "";
          if (!label) continue;
          text += desc ? "\n\u2022 *" + label + "* \u2014 " + desc : "\n\u2022 *" + label + "*";
        }
        parts.push(text);
      }
    } else if (block.name === "ExitPlanMode") {
      parts.push("\uD83D\uDCCB Plan approval needed");
    }
  }
  return parts.join("\n\n");
}

function parseLineJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readTail(filePath, maxBytes) {
  try {
    const st = statSync(filePath);
    if (st.size === 0) return "";
    const readSize = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, readSize, st.size - readSize);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Extract promptText from the transcript tail.
 * Scans backwards from the end, collecting tool_use blocks from assistant
 * entries until a real user message (with text content) is reached.
 */
function extractPromptFromTranscript(transcriptPath) {
  if (!transcriptPath) return "";

  const tail = readTail(transcriptPath, 65536);
  if (!tail) return "";

  const lines = tail.split("\n");
  const allToolUseBlocks = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLineJson(line);
    if (!entry) continue;

    const obj = asObject(entry);
    if (!obj) continue;

    // Stop at real user messages (with text content, not tool_result)
    if (obj.type === "user") {
      const message = asObject(obj.message) || obj;
      const content = Array.isArray(message.content) ? message.content : [];
      const hasUserText = content.some((c) => {
        const co = asObject(c);
        return co && co.type === "text";
      });
      if (hasUserText) break;
      continue;
    }

    if (obj.type !== "assistant") continue;

    const message = asObject(obj.message) || obj;
    const toolUse = extractToolUseBlocks(message.content);
    if (toolUse.length > 0) {
      allToolUseBlocks.push(...toolUse);
    }
  }

  allToolUseBlocks.reverse();
  return formatPromptText(allToolUseBlocks);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      resolve(raw);
    });
    process.stdin.on("error", () => {
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
  const inputRaw = await readStdin();
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  const projectName = process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  const agentType = process.env.AGENT_DISCORD_AGENT || "claude";
  const instanceId = process.env.AGENT_DISCORD_INSTANCE || "";
  const port = process.env.AGENT_DISCORD_PORT || "18470";

  const message = typeof input.message === "string" ? input.message.trim() : "";
  const notificationType = typeof input.notification_type === "string" ? input.notification_type : "unknown";
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";

  const promptText = extractPromptFromTranscript(transcriptPath);

  console.error(`[discode-notification-hook] project=${projectName} type=${notificationType} message=${message.substring(0, 100)} prompt_len=${promptText.length}`);

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: "session.notification",
      notificationType,
      text: message,
      ...(promptText ? { promptText } : {}),
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {
  // ignore
});
