export const AgentDiscordBridgePlugin = async () => {
  let lastAssistantText = '';
  let latestAssistantMessageId = '';
  const assistantMessageIds = new Set<string>();
  const assistantTextByMessage = new Map<string, { order: string[]; parts: Record<string, string> }>();

  const projectName = process.env.AGENT_DISCORD_PROJECT || '';
  const port = process.env.AGENT_DISCORD_PORT || '18470';
  const agentType = process.env.AGENT_DISCORD_AGENT || 'opencode';
  const endpoint = `http://127.0.0.1:${port}/opencode-event`;

  const asObject = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    return node as Record<string, unknown>;
  };

  const textFromNode = (node: unknown, depth = 0): string => {
    if (depth > 10 || node === undefined || node === null) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (Array.isArray(node)) {
      return node.map((item) => textFromNode(item, depth + 1)).filter(Boolean).join('\n');
    }

    const obj = asObject(node);
    if (!obj) return '';
    if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;

    return Object.values(obj)
      .map((value) => textFromNode(value, depth + 1))
      .filter(Boolean)
      .join('\n');
  };

  const post = async (payload: Record<string, unknown>) => {
    if (!projectName) return;
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectName,
          agentType,
          ...payload,
        }),
      });
    } catch {
      return;
    }
  };

  const getProperties = (event: unknown): Record<string, unknown> => {
    const obj = asObject(event);
    if (!obj) return {};
    return asObject(obj.properties) || {};
  };

  const rememberAssistantMessage = (info: unknown) => {
    const obj = asObject(info);
    if (!obj) return;
    if (obj.role !== 'assistant') return;
    if (typeof obj.id !== 'string' || obj.id.length === 0) return;

    assistantMessageIds.add(obj.id);
    latestAssistantMessageId = obj.id;
  };

  const updateAssistantTextPart = (part: unknown, delta: unknown) => {
    const obj = asObject(part);
    if (!obj) return;
    if (obj.type !== 'text') return;

    const messageID = typeof obj.messageID === 'string' ? obj.messageID : '';
    if (!messageID || !assistantMessageIds.has(messageID)) return;

    const partID = typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : '__default__';
    const current = assistantTextByMessage.get(messageID) || { order: [], parts: {} };

    if (!current.parts[partID]) {
      current.order.push(partID);
    }

    const nextText = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (nextText.length > 0) {
      current.parts[partID] = nextText;
    } else if (typeof delta === 'string' && delta.length > 0) {
      current.parts[partID] = (current.parts[partID] || '') + delta;
    } else {
      return;
    }

    assistantTextByMessage.set(messageID, current);
    latestAssistantMessageId = messageID;

    const joined = current.order
      .map((id) => current.parts[id])
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (joined) {
      lastAssistantText = joined;
    }
  };

  const getLatestAssistantText = (): string => {
    if (!latestAssistantMessageId) return lastAssistantText;
    const current = assistantTextByMessage.get(latestAssistantMessageId);
    if (!current) return lastAssistantText;

    const joined = current.order
      .map((id) => current.parts[id])
      .filter(Boolean)
      .join('\n\n')
      .trim();

    return joined || lastAssistantText;
  };

  return {
    event: async ({ event }: { event: Record<string, unknown> }) => {
      if (!event || typeof event !== 'object') return;
      const properties = getProperties(event);

      if (event.type === 'message.updated') {
        rememberAssistantMessage(properties.info || event.info || event.message);
      }

      if (event.type === 'message.part.updated') {
        updateAssistantTextPart(properties.part || event.part, properties.delta || event.delta);
      }

      if (event.type === 'session.error') {
        const errorText = textFromNode(properties.error || event.error || event).trim();
        await post({ type: 'session.error', text: errorText || 'unknown error' });
        return;
      }

      if (event.type === 'session.idle') {
        const latestText = getLatestAssistantText().trim();
        await post({ type: 'session.idle', text: latestText });
      }
    },
  };
};
