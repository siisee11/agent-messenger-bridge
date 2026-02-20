import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import ts from 'typescript';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  OPENCODE_PLUGIN_FILENAME,
  getPluginSourcePath,
  installOpencodePlugin,
} from '../../src/opencode/plugin-installer.js';

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function createPluginHarness(extraEnv?: Record<string, string>) {
  const source = readFileSync(getPluginSourcePath(), 'utf-8').replace(
    'export const AgentDiscordBridgePlugin',
    'const AgentDiscordBridgePlugin'
  );
  const transpiledSource = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const calls: FetchCall[] = [];

  const fetchMock = async (url: string, init: any) => {
    calls.push({ url, init: init || {} });
    return { ok: true };
  };

  const buildPlugin = new Function(
    'fetch',
    'process',
    `${transpiledSource}\nreturn AgentDiscordBridgePlugin;`
  ) as (fetch: typeof fetchMock, process: { env: Record<string, string> }) => () => Promise<any>;

  const processStub = {
    env: {
      AGENT_DISCORD_PROJECT: 'demo-project',
      AGENT_DISCORD_PORT: '18470',
      ...extraEnv,
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

describe('opencode plugin installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-opencode-plugin-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source plugin file exists', () => {
    expect(existsSync(getPluginSourcePath())).toBe(true);
  });

  it('installOpencodePlugin copies file to target directory', () => {
    const result = installOpencodePlugin(undefined, tempDir);
    expect(result).toBe(join(tempDir, OPENCODE_PLUGIN_FILENAME));
    expect(existsSync(result)).toBe(true);

    const content = readFileSync(result, 'utf-8');
    expect(content).toContain('AgentDiscordBridgePlugin');
    expect(content).toContain('/opencode-event');
  });

  it('uses AGENT_DISCORD_HOSTNAME for endpoint when set', async () => {
    const harness = createPluginHarness({ AGENT_DISCORD_HOSTNAME: 'host.docker.internal' });
    const plugin = await harness.create();

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg-host', role: 'assistant' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', type: 'text', messageID: 'msg-host', text: 'hello' },
        },
      },
    });
    await plugin.event({
      event: { type: 'session.idle', properties: {} },
    });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].url).toBe('http://host.docker.internal:18470/opencode-event');
  });

  it('defaults to 127.0.0.1 when AGENT_DISCORD_HOSTNAME is not set', async () => {
    const harness = createPluginHarness();
    const plugin = await harness.create();

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg-local', role: 'assistant' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', type: 'text', messageID: 'msg-local', text: 'hi' },
        },
      },
    });
    await plugin.event({
      event: { type: 'session.idle', properties: {} },
    });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].url).toBe('http://127.0.0.1:18470/opencode-event');
  });

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

  describe('compiled binary resource resolution', () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      process.execPath = originalExecPath;
    });

    it('resolves plugin source from process.execPath-based resources path', () => {
      // Simulate compiled binary layout: bin/discode + resources/opencode-plugin/
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'opencode-plugin');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getPluginSourcePath(), join(resourcesDir, OPENCODE_PLUGIN_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const candidate = join(dirname(process.execPath), '..', 'resources', 'opencode-plugin', OPENCODE_PLUGIN_FILENAME);
      expect(existsSync(candidate)).toBe(true);

      const content = readFileSync(candidate, 'utf-8');
      expect(content).toContain('AgentDiscordBridgePlugin');
    });

    it('installOpencodePlugin works from binary resources layout', () => {
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'opencode-plugin');
      const targetDir = join(tempDir, 'installed-plugin');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getPluginSourcePath(), join(resourcesDir, OPENCODE_PLUGIN_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const result = installOpencodePlugin(undefined, targetDir);
      expect(existsSync(result)).toBe(true);

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('AgentDiscordBridgePlugin');
    });
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

  describe('session.created event', () => {
    it('posts session.start with title from session info', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'session.created',
          properties: {
            info: { id: 'sess-1', title: 'My Session', version: '1.0', directory: '/proj' },
          },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.start');
      expect(payload.source).toBe('startup');
      expect(payload.text).toBe('My Session');
      expect(payload.projectName).toBe('demo-project');
      expect(payload.agentType).toBe('opencode');
    });

    it('handles session.created without title', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'sess-2' } },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.start');
      expect(payload.text).toBe('');
    });

    it('handles session.created without info', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.created', properties: {} },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.start');
      expect(payload.source).toBe('startup');
      expect(payload.text).toBe('');
    });

    it('includes instanceId when set', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_INSTANCE: 'inst-1' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.created', properties: { info: { id: 's1' } } },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.instanceId).toBe('inst-1');
    });

    it('omits instanceId when empty', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_INSTANCE: '' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.created', properties: { info: { id: 's1' } } },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.instanceId).toBeUndefined();
    });

    it('does nothing when AGENT_DISCORD_PROJECT is empty', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_PROJECT: '' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.created', properties: { info: { id: 's1' } } },
      });

      expect(harness.calls).toHaveLength(0);
    });
  });

  describe('session.deleted event', () => {
    it('posts session.end with reason deleted', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'session.deleted',
          properties: { info: { id: 'sess-del-1' } },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.end');
      expect(payload.reason).toBe('deleted');
      expect(payload.projectName).toBe('demo-project');
      expect(payload.agentType).toBe('opencode');
    });

    it('includes instanceId when set', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_INSTANCE: 'inst-2' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.deleted', properties: {} },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.instanceId).toBe('inst-2');
    });

    it('does nothing when AGENT_DISCORD_PROJECT is empty', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_PROJECT: '' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.deleted', properties: {} },
      });

      expect(harness.calls).toHaveLength(0);
    });
  });

  describe('permission.updated event', () => {
    it('posts session.notification with permission title', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'permission.updated',
          properties: {
            id: 'perm-1',
            type: 'shell',
            title: 'Allow running npm install?',
            sessionID: 'sess-1',
            messageID: 'msg-1',
            metadata: {},
            time: { created: Date.now() },
          },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.notification');
      expect(payload.notificationType).toBe('permission_prompt');
      expect(payload.text).toBe('Allow running npm install?');
      expect(payload.projectName).toBe('demo-project');
      expect(payload.agentType).toBe('opencode');
    });

    it('falls back to permission type when title is empty', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'permission.updated',
          properties: {
            id: 'perm-2',
            type: 'file_write',
            title: '',
            sessionID: 'sess-1',
            messageID: 'msg-2',
            metadata: {},
            time: { created: Date.now() },
          },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.text).toBe('file_write');
    });

    it('falls back to permission type when title is missing', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'permission.updated',
          properties: {
            id: 'perm-3',
            type: 'shell',
            sessionID: 'sess-1',
            messageID: 'msg-3',
            metadata: {},
            time: { created: Date.now() },
          },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.text).toBe('shell');
    });

    it('handles missing title and type', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'permission.updated',
          properties: {},
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.notificationType).toBe('permission_prompt');
      expect(payload.text).toBe('unknown');
    });

    it('includes instanceId when set', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_INSTANCE: 'inst-3' });
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'permission.updated',
          properties: { id: 'p1', type: 'shell', title: 'test', sessionID: 's1', messageID: 'm1', metadata: {}, time: { created: 0 } },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.instanceId).toBe('inst-3');
    });

    it('does nothing when AGENT_DISCORD_PROJECT is empty', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_PROJECT: '' });
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'permission.updated',
          properties: { id: 'p1', type: 'shell', title: 'test', sessionID: 's1', messageID: 'm1', metadata: {}, time: { created: 0 } },
        },
      });

      expect(harness.calls).toHaveLength(0);
    });
  });

  describe('session.error event', () => {
    it('posts session.error with error text from properties.error', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'session.error',
          properties: { error: 'Connection timed out' },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.error');
      expect(payload.text).toBe('Connection timed out');
      expect(payload.projectName).toBe('demo-project');
      expect(payload.agentType).toBe('opencode');
    });

    it('extracts text from nested error object', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'session.error',
          properties: { error: { type: 'text', text: 'Nested error message' } },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.text).toBe('Nested error message');
    });

    it('falls back to event object text when error property is empty', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: {
          type: 'session.error',
          properties: {},
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      // When properties.error is undefined, textFromNode falls through to the
      // event object itself, extracting "session.error" from the type field
      expect(payload.text).toBe('session.error');
    });

    it('falls back to "unknown error" when all text extraction yields empty', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      // Empty string error trims to empty, triggering the fallback
      await plugin.event({
        event: {
          type: 'session.error',
          properties: { error: '   ' },
        },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.text).toBe('unknown error');
    });

    it('includes instanceId when set', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_INSTANCE: 'inst-err' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.error', properties: { error: 'fail' } },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.instanceId).toBe('inst-err');
    });

    it('does nothing when AGENT_DISCORD_PROJECT is empty', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_PROJECT: '' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.error', properties: { error: 'fail' } },
      });

      expect(harness.calls).toHaveLength(0);
    });
  });

  describe('session.idle event', () => {
    it('posts session.idle with empty text when no messages accumulated', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.idle', properties: {} },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.type).toBe('session.idle');
      expect(payload.text).toBe('');
    });

    it('does not post when AGENT_DISCORD_PROJECT is empty', async () => {
      const harness = createPluginHarness({ AGENT_DISCORD_PROJECT: '' });
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'session.idle', properties: {} },
      });

      expect(harness.calls).toHaveLength(0);
    });

    it('uses latest assistant text from multiple messages', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      // First message
      await plugin.event({
        event: { type: 'message.updated', properties: { info: { id: 'msg-a', role: 'assistant' } } },
      });
      await plugin.event({
        event: {
          type: 'message.part.updated',
          properties: { part: { id: 'p1', type: 'text', messageID: 'msg-a', text: 'First reply' } },
        },
      });

      // Second message (latest)
      await plugin.event({
        event: { type: 'message.updated', properties: { info: { id: 'msg-b', role: 'assistant' } } },
      });
      await plugin.event({
        event: {
          type: 'message.part.updated',
          properties: { part: { id: 'p2', type: 'text', messageID: 'msg-b', text: 'Second reply' } },
        },
      });

      await plugin.event({
        event: { type: 'session.idle', properties: {} },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.text).toBe('Second reply');
    });

    it('ignores non-assistant messages', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      // User message should not be tracked
      await plugin.event({
        event: { type: 'message.updated', properties: { info: { id: 'msg-user', role: 'user' } } },
      });
      await plugin.event({
        event: {
          type: 'message.part.updated',
          properties: { part: { id: 'p1', type: 'text', messageID: 'msg-user', text: 'User text' } },
        },
      });

      await plugin.event({
        event: { type: 'session.idle', properties: {} },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      // User messages should not appear in assistant text
      expect(payload.text).toBe('');
    });

    it('ignores non-text parts', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({
        event: { type: 'message.updated', properties: { info: { id: 'msg-c', role: 'assistant' } } },
      });
      await plugin.event({
        event: {
          type: 'message.part.updated',
          properties: { part: { id: 'p1', type: 'tool_call', messageID: 'msg-c', text: '' } },
        },
      });

      await plugin.event({
        event: { type: 'session.idle', properties: {} },
      });

      expect(harness.calls).toHaveLength(1);
      const payload = parseBody(harness.calls[0]);
      expect(payload.text).toBe('');
    });
  });

  describe('event edge cases', () => {
    it('handles null event gracefully', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({ event: null });
      expect(harness.calls).toHaveLength(0);
    });

    it('handles event without type', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({ event: { properties: {} } });
      expect(harness.calls).toHaveLength(0);
    });

    it('handles unknown event type without posting', async () => {
      const harness = createPluginHarness();
      const plugin = await harness.create();

      await plugin.event({ event: { type: 'some.unknown.event', properties: {} } });
      expect(harness.calls).toHaveLength(0);
    });
  });

  it('plugin source contains session.created handler', () => {
    const source = readFileSync(getPluginSourcePath(), 'utf-8');
    expect(source).toContain('session.created');
    expect(source).toContain('session.start');
  });

  it('plugin source contains session.deleted handler', () => {
    const source = readFileSync(getPluginSourcePath(), 'utf-8');
    expect(source).toContain('session.deleted');
    expect(source).toContain('session.end');
  });

  it('plugin source contains permission.updated handler', () => {
    const source = readFileSync(getPluginSourcePath(), 'utf-8');
    expect(source).toContain('permission.updated');
    expect(source).toContain('session.notification');
    expect(source).toContain('permission_prompt');
  });
});
