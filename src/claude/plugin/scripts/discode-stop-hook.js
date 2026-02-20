#!/usr/bin/env node
const { readFileSync, openSync, readSync, closeSync, statSync } = require("fs");

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

function extractThinkingBlocks(node, depth = 0) {
  if (depth > 10 || node === undefined || node === null) return [];

  if (Array.isArray(node)) {
    return node.flatMap((item) => extractThinkingBlocks(item, depth + 1));
  }

  const obj = asObject(node);
  if (!obj) return [];

  if (obj.type === "thinking" && typeof obj.thinking === "string" && obj.thinking.trim().length > 0) {
    return [obj.thinking];
  }

  if (Array.isArray(obj.content)) {
    return extractThinkingBlocks(obj.content, depth + 1);
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
  const thinkingParts = extractThinkingBlocks(message.content);
  const thinking = thinkingParts.join("\n").trim();
  const toolUse = extractToolUseBlocks(message.content);
  return { messageId, text, thinking, toolUse };
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
 * Parse the transcript tail and return:
 * - displayText: text from the latest assistant messageId (for the response message)
 * - turnText: all assistant text from the current turn (for file path extraction)
 *
 * The turn boundary is the last real user message (with text content, not tool_result).
 * This handles the race condition where the Stop hook fires before the final assistant
 * entry is flushed to disk — earlier entries in the turn may still contain file paths.
 */
function parseTurnTexts(tail) {
  if (!tail) return { displayText: "", intermediateText: "", turnText: "", thinking: "", promptText: "" };

  const lines = tail.split("\n");
  let latestMessageId = "";
  const latestTextParts = [];
  const intermediateTextParts = [];
  const allTextParts = [];
  const allThinkingParts = [];
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
      // tool_result entries — skip and continue scanning
      continue;
    }

    // Skip non-assistant entries (progress, system, etc.)
    if (obj.type !== "assistant") continue;

    const assistant = readAssistantEntry(entry);
    if (!assistant) continue;

    // Track latest messageId for display text
    if (!latestMessageId && assistant.messageId) {
      latestMessageId = assistant.messageId;
    }

    if (assistant.text.length > 0) {
      // Collect ALL assistant text in the turn
      allTextParts.push(assistant.text);

      // Collect text from the latest messageId for display
      if (!latestMessageId || assistant.messageId === latestMessageId) {
        latestTextParts.push(assistant.text);
      } else {
        // Text from earlier messageIds (intermediate text before tool calls)
        intermediateTextParts.push(assistant.text);
      }
    }

    // Collect ALL thinking from the turn (thinking appears in earlier messageIds
    // before tool calls, not in the final messageId that has the response text)
    if (assistant.thinking.length > 0) {
      allThinkingParts.push(assistant.thinking);
    }

    // Collect tool_use blocks from the turn
    if (assistant.toolUse.length > 0) {
      allToolUseBlocks.push(...assistant.toolUse);
    }
  }

  latestTextParts.reverse();
  intermediateTextParts.reverse();
  allTextParts.reverse();
  allThinkingParts.reverse();
  allToolUseBlocks.reverse();

  return {
    displayText: latestTextParts.join("\n").trim(),
    intermediateText: intermediateTextParts.join("\n").trim(),
    turnText: allTextParts.join("\n").trim(),
    thinking: allThinkingParts.join("\n").trim(),
    promptText: formatPromptText(allToolUseBlocks),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read assistant text from the transcript with retry to handle the race condition
 * where the Stop hook fires before the final assistant entry is flushed to disk.
 */
async function readTurnTexts(transcriptPath) {
  if (!transcriptPath) return { displayText: "", intermediateText: "", turnText: "", thinking: "", promptText: "" };

  // Retry up to 3 times with 150ms delay to let the transcript writer flush
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(150);

    const tail = readTail(transcriptPath, 65536);
    const result = parseTurnTexts(tail);

    // If we found display text, check if the last real entry is an assistant text.
    // If the tail ends with a non-assistant entry (tool_result, progress, system),
    // the final response may not have been written yet — retry.
    if (result.displayText) {
      const lines = tail.split("\n");
      let lastRealType = "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i].trim();
        if (!l) continue;
        const e = parseLineJson(l);
        if (!e) continue;
        const o = asObject(e);
        if (!o) continue;
        // Skip progress/system entries — they appear after the final response
        if (o.type === "progress" || o.type === "system") continue;
        lastRealType = o.type;
        break;
      }
      // If the last real entry is an assistant entry, the transcript is likely complete
      if (lastRealType === "assistant") return result;
      // Otherwise, the final assistant entry hasn't been written yet — retry
      continue;
    }
  }

  // Final attempt without retry check
  const tail = readTail(transcriptPath, 65536);
  return parseTurnTexts(tail);
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
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";

  const { displayText, intermediateText, turnText, thinking, promptText } = await readTurnTexts(transcriptPath);
  let text = displayText;
  if (!text && typeof input.message === "string" && input.message.trim().length > 0) {
    text = input.message;
  }
  console.error(`[discode-stop-hook] project=${projectName} text_len=${text.length} intermediate_len=${intermediateText.length} turn_text_len=${turnText.length} thinking_len=${thinking.length} prompt_len=${promptText.length}`);

  if (!text && !turnText && !promptText) return;

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: "session.idle",
      text: text || "",
      turnText: turnText || "",
      ...(intermediateText ? { intermediateText } : {}),
      ...(thinking ? { thinking } : {}),
      ...(promptText ? { promptText } : {}),
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {
  // ignore
});
