import { afterEach, describe, expect, it } from 'vitest';
import { PtyRuntime } from '../../src/runtime/pty-runtime.js';

const runtimes: PtyRuntime[] = [];

function track(runtime: PtyRuntime): PtyRuntime {
  runtimes.push(runtime);
  return runtime;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose('SIGKILL');
  }
});

describe('PtyRuntime', () => {
  it('starts a process with session env and captures output', async () => {
    const runtime = track(new PtyRuntime());

    runtime.getOrCreateSession('bridge', 'claude');
    runtime.setSessionEnv('bridge', 'AGENT_DISCORD_PORT', '18470');
    runtime.startAgentInWindow('bridge', 'claude', 'printf "%s\\n" "$AGENT_DISCORD_PORT"');

    await waitFor(() => {
      const window = runtime.listWindows('bridge').find((item) => item.windowName === 'claude');
      return !!window && window.status !== 'starting' && window.status !== 'running';
    });

    const buffer = runtime.getWindowBuffer('bridge', 'claude');
    expect(buffer).toContain('18470');
  });

  it('routes input to running window and stops process', async () => {
    const runtime = track(new PtyRuntime());

    runtime.getOrCreateSession('bridge', 'opencode');
    runtime.startAgentInWindow('bridge', 'opencode', 'cat');

    await waitFor(() => {
      const window = runtime.listWindows('bridge').find((item) => item.windowName === 'opencode');
      return window?.status === 'running';
    });

    runtime.sendKeysToWindow('bridge', 'opencode', 'hello-runtime');

    await waitFor(() => runtime.getWindowBuffer('bridge', 'opencode').includes('hello-runtime'));

    expect(runtime.stopWindow('bridge', 'opencode')).toBe(true);
    await waitFor(() => {
      const window = runtime.listWindows('bridge').find((item) => item.windowName === 'opencode');
      return !!window && window.status !== 'running' && window.status !== 'starting';
    });
  });
});
