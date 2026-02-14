#!/usr/bin/env node
const { readFileSync } = require("fs");

function asObject(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  return node;
}

function extractTextBlocks(node, depth = 0) {
  if (depth > 10 || node === undefined || node === null) return [];

  if (typeof node === "string") {
    return node.trim().length > 0 ? [node] : [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((item) => extractTextBlocks(item, depth + 1));
  }

  const obj = asObject(node);
  if (!obj) return [];

  if (obj.type === "text" && typeof obj.text === "string" && obj.text.trim().length > 0) {
    return [obj.text];
  }

  if (Array.isArray(obj.content) || typeof obj.content === "string") {
    return extractTextBlocks(obj.content, depth + 1);
  }

  if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string" && obj.text.trim().length > 0) {
    return [obj.text];
  }

  return [];
}

function readAssistantEntry(entry) {
  const obj = asObject(entry);
  if (!obj || obj.type !== "assistant") return null;

  const message = asObject(obj.message) || obj;
  const messageId = typeof message.id === "string" ? message.id : "";
  const textParts = extractTextBlocks(message.content);
  const text = textParts.join("\n").trim();
  return { messageId, text };
}

function parseLineJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";

  let raw = "";
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }

  const lines = raw.split("\n");
  let latestMessageId = "";

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLineJson(line);
    if (!entry) continue;

    const assistant = readAssistantEntry(entry);
    if (!assistant) continue;

    if (!latestMessageId && assistant.messageId) {
      latestMessageId = assistant.messageId;
    }

    if (latestMessageId && assistant.messageId && assistant.messageId !== latestMessageId) {
      break;
    }

    if (assistant.text.length > 0) {
      return assistant.text;
    }
  }

  return "";
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
  await fetch("http://127.0.0.1:" + port + "/opencode-event", {
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

  if (input.stop_hook_active === true) return;

  const projectName = process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  const agentType = process.env.AGENT_DISCORD_AGENT || "claude";
  const instanceId = process.env.AGENT_DISCORD_INSTANCE || "";
  const port = process.env.AGENT_DISCORD_PORT || "18470";
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const text = readLastAssistantText(transcriptPath);
  console.error(`[discode-stop-hook] project=${projectName} transcript=${transcriptPath} text_len=${text.length} text_preview=${JSON.stringify(text.substring(0, 100))}`);

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: "session.idle",
      text,
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {
  // ignore
});
