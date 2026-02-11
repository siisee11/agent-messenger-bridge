import { getOpencodePluginSource } from '../../src/opencode/plugin-installer.js';
import { describe, it, expect } from 'vitest';

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function createPluginHarness() {
  const source = getOpencodePluginSource().replace('export const AgentDiscordBridgePlugin', 'const AgentDiscordBridgePlugin');
  const calls: FetchCall[] = [];

  const fetchMock = async (url: string, init: any) => {
    calls.push({ url, init: init || {} });
    return { ok: true };
  };

  const buildPlugin = new Function(
    'fetch',
    'process',
    `${source}\nreturn AgentDiscordBridgePlugin;`
  ) as (fetch: typeof fetchMock, process: { env: Record<string, string> }) => () => Promise<any>;

  const processStub = {
    env: {
      AGENT_DISCORD_PROJECT: 'demo-project',
      AGENT_DISCORD_PORT: '18470',
    },
  };

  return {
    calls,
    create: async () => {
      const pluginFactory = buildPlugin(fetchMock, processStub);
      return pluginFactory();
    },
  };
}

function parseBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body || '{}') as Record<string, unknown>;
}

describe('getOpencodePluginSource', () => {
  it('posts final assistant text on session.idle from message parts', async () => {
    const harness = createPluginHarness();
    const plugin = await harness.create();

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'assistant-msg-1', role: 'assistant' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            type: 'text',
            messageID: 'assistant-msg-1',
            text: '결과 본문',
          },
        },
      },
    });

    await plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    });

    expect(harness.calls).toHaveLength(1);
    const payload = parseBody(harness.calls[0]);
    expect(payload.type).toBe('session.idle');
    expect(payload.text).toBe('결과 본문');
    expect(payload.projectName).toBe('demo-project');
    expect(payload.agentType).toBe('opencode');
  });

  it('builds assistant text from delta updates when part text is empty', async () => {
    const harness = createPluginHarness();
    const plugin = await harness.create();

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'assistant-msg-2', role: 'assistant' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            type: 'text',
            messageID: 'assistant-msg-2',
            text: '',
          },
          delta: 'hello ',
        },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            type: 'text',
            messageID: 'assistant-msg-2',
            text: '',
          },
          delta: 'world',
        },
      },
    });

    await plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'session-2' },
      },
    });

    expect(harness.calls).toHaveLength(1);
    const payload = parseBody(harness.calls[0]);
    expect(payload.type).toBe('session.idle');
    expect(payload.text).toBe('hello world');
  });
});
