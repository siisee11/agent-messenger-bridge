#!/usr/bin/env node
const { readFileSync } = require("fs");

function asObject(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  return node;
}

function textFromNode(node, depth = 0) {
  if (depth > 12 || node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);

  if (Array.isArray(node)) {
    return node
      .map((item) => textFromNode(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }

  const obj = asObject(node);
  if (!obj) return "";

  if (obj.type === "text" && typeof obj.text === "string") {
    return obj.text;
  }

  return Object.values(obj)
    .map((value) => textFromNode(value, depth + 1))
    .filter(Boolean)
    .join("\n");
}

function findAssistantText(node, depth = 0) {
  if (depth > 12 || node === undefined || node === null) return "";

  if (Array.isArray(node)) {
    for (const item of node) {
      const text = findAssistantText(item, depth + 1);
      if (text) return text;
    }
    return "";
  }

  const obj = asObject(node);
  if (!obj) return "";

  const role = typeof obj.role === "string" ? obj.role : "";
  const type = typeof obj.type === "string" ? obj.type : "";
  if (role === "assistant" || type === "assistant") {
    // Extract only text content blocks – skip tool_use-only messages
    if (Array.isArray(obj.content)) {
      const texts = obj.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text);
      if (texts.length > 0) return texts.join("\n").trim();
      // content is an array but has no text blocks (e.g. tool_use only) –
      // return "" so the caller keeps searching earlier messages
      return "";
    }
    const source = obj.content ?? obj.message;
    if (source !== undefined && source !== null) {
      const text = textFromNode(source);
      if (text.trim().length > 0) return text.trim();
    }
  }

  const priorityKeys = ["message", "messages", "content", "response", "result", "output", "event", "data"];
  for (const key of priorityKeys) {
    if (!(key in obj)) continue;
    const text = findAssistantText(obj[key], depth + 1);
    if (text) return text;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (priorityKeys.includes(key)) continue;
    // Only recurse into objects/arrays — skip scalar fields (model, id, etc.)
    if (typeof value !== "object" || value === null) continue;
    const text = findAssistantText(value, depth + 1);
    if (text) return text;
  }

  return "";
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
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLineJson(line);
    if (!entry) continue;

    const text = findAssistantText(entry).trim();
    if (text.length > 0) {
      return text;
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

  const port = process.env.AGENT_DISCORD_PORT || "18470";
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const text = readLastAssistantText(transcriptPath);

  try {
    await postToBridge(port, {
      projectName,
      agentType: "claude",
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
