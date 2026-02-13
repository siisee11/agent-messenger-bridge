import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const OPENCODE_PLUGIN_FILENAME = 'agent-opencode-bridge-plugin.ts';

export function getOpencodePluginDir(): string {
  return join(homedir(), '.opencode', 'plugins');
}

export function getOpencodePluginSource(): string {
  return `export const AgentDiscordBridgePlugin = async () => {
  let lastAssistantText = "";
  let latestAssistantMessageId = "";
  const assistantMessageIds = new Set();
  const assistantTextByMessage = new Map();

  const projectName = process.env.AGENT_DISCORD_PROJECT || "";
  const agentType = process.env.AGENT_DISCORD_AGENT || "opencode";
  const port = process.env.AGENT_DISCORD_PORT || "18470";
  const endpoint = "http://127.0.0.1:" + port + "/opencode-event";

  const post = async (payload) => {
    if (!projectName) return;
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectName,
          agentType: "opencode",
          ...payload,
        }),
      });
    } catch {
      // ignore bridge delivery failures
    }
  };

  const toObject = (node) => {
    if (!node || typeof node !== "object") return null;
    return node;
  };

  const textFromNode = (node, depth = 0) => {
    if (depth > 10 || node === undefined || node === null) return "";
    if (typeof node === "string") return node;
    if (typeof node === "number" || typeof node === "boolean") return String(node);
    if (Array.isArray(node)) {
      return node.map((item) => textFromNode(item, depth + 1)).filter(Boolean).join("\\n");
    }

    const obj = toObject(node);
    if (!obj) return "";
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;

    return Object.values(obj)
      .map((value) => textFromNode(value, depth + 1))
      .filter(Boolean)
      .join("\\n");
  };

  const getProperties = (event) => {
    const obj = toObject(event);
    if (!obj) return {};
    return toObject(obj.properties) || {};
  };

  const rememberAssistantMessage = (info) => {
    const obj = toObject(info);
    if (!obj) return;
    if (obj.role !== "assistant") return;
    if (typeof obj.id !== "string" || obj.id.length === 0) return;

    assistantMessageIds.add(obj.id);
    latestAssistantMessageId = obj.id;
  };

  const updateAssistantTextPart = (part, delta) => {
    const obj = toObject(part);
    if (!obj) return;
    if (obj.type !== "text") return;

    const messageID = typeof obj.messageID === "string" ? obj.messageID : "";
    if (!messageID || !assistantMessageIds.has(messageID)) return;

    const partID = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : "__default__";
    const current = assistantTextByMessage.get(messageID) || { order: [], parts: {} };
    if (!current.parts[partID]) {
      current.order.push(partID);
    }

    const nextText = typeof obj.text === "string" ? obj.text.trim() : "";
    if (nextText.length > 0) {
      current.parts[partID] = nextText;
    } else if (typeof delta === "string" && delta.length > 0) {
      current.parts[partID] = (current.parts[partID] || "") + delta;
    } else {
      return;
    }

    assistantTextByMessage.set(messageID, current);
    latestAssistantMessageId = messageID;

    const joined = current.order
      .map((id) => current.parts[id])
      .filter(Boolean)
      .join("\\n\\n")
      .trim();
    if (joined) {
      lastAssistantText = joined;
    }
  };

  const getLatestAssistantText = () => {
    if (!latestAssistantMessageId) return lastAssistantText;
    const current = assistantTextByMessage.get(latestAssistantMessageId);
    if (!current) return lastAssistantText;
    const joined = current.order
      .map((id) => current.parts[id])
      .filter(Boolean)
      .join("\\n\\n")
      .trim();
    return joined || lastAssistantText;
  };

  return {
    event: async ({ event }) => {
      if (!event || typeof event !== "object") return;
      const properties = getProperties(event);

      if (event.type === "message.updated") {
        rememberAssistantMessage(properties.info || event.info || event.message);
      }

      if (event.type === "message.part.updated") {
        updateAssistantTextPart(properties.part || event.part, properties.delta || event.delta);
      }

      if (event.type === "session.error") {
        const errorText = textFromNode(properties.error || event.error || event).trim();
        await post({ type: "session.error", text: errorText || "unknown error" });
        return;
      }

      if (event.type === "session.idle") {
        const latestText = getLatestAssistantText().trim();
        await post({ type: "session.idle", text: latestText });
      }
    },
  };
};
`;
}

export function installOpencodePlugin(_projectPath?: string): string {
  const pluginDir = getOpencodePluginDir();
  const pluginPath = join(pluginDir, OPENCODE_PLUGIN_FILENAME);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(pluginPath, getOpencodePluginSource(), 'utf-8');
  return pluginPath;
}
