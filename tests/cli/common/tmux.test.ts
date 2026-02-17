import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureProjectTuiPane } from '../../../src/cli/common/tmux.js';

describe('ensureProjectTuiPane', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it('runs extensionless argv runner through bun source entrypoint when available', () => {
    process.argv = [process.argv[0], resolve(process.cwd(), 'bin/discode'), 'new'];
    const ensureTuiPane = vi.fn();
    const windowExists = vi.fn(() => true);
    const ensureWindowAtIndex = vi.fn();

    ensureProjectTuiPane({ ensureTuiPane, windowExists, ensureWindowAtIndex } as any, 'agent-demo', 'demo-claude', {});

    expect(ensureTuiPane).toHaveBeenCalledWith(
      'agent-demo',
      '0',
      [expect.stringMatching(/bun$/), resolve(process.cwd(), 'bin/discode.ts'), 'tui'],
    );
    expect(ensureWindowAtIndex).not.toHaveBeenCalled();
  });

  it('runs script argv runner through bun', () => {
    process.argv = [process.argv[0], resolve(process.cwd(), 'bin/discode.ts'), 'new'];
    const ensureTuiPane = vi.fn();
    const windowExists = vi.fn(() => true);
    const ensureWindowAtIndex = vi.fn();

    ensureProjectTuiPane({ ensureTuiPane, windowExists, ensureWindowAtIndex } as any, 'agent-demo', 'demo-claude', {});

    expect(ensureTuiPane).toHaveBeenCalledWith(
      'agent-demo',
      '0',
      [expect.stringMatching(/bun$/), resolve(process.cwd(), 'bin/discode.ts'), 'tui'],
    );
    expect(ensureWindowAtIndex).not.toHaveBeenCalled();
  });

  it('falls back to project window when window 0 does not exist', () => {
    process.argv = [process.argv[0], resolve(process.cwd(), 'bin/discode.ts'), 'new'];
    const ensureTuiPane = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("can't find window: 0");
      })
      .mockImplementationOnce(() => undefined);
    const windowExists = vi.fn(() => true);
    const ensureWindowAtIndex = vi.fn();

    ensureProjectTuiPane({ ensureTuiPane, windowExists, ensureWindowAtIndex } as any, 'agent-demo', 'demo-claude', {});

    expect(ensureTuiPane).toHaveBeenNthCalledWith(
      1,
      'agent-demo',
      '0',
      [expect.stringMatching(/bun$/), resolve(process.cwd(), 'bin/discode.ts'), 'tui'],
    );
    expect(ensureTuiPane).toHaveBeenNthCalledWith(
      2,
      'agent-demo',
      'demo-claude',
      [expect.stringMatching(/bun$/), resolve(process.cwd(), 'bin/discode.ts'), 'tui'],
    );
    expect(ensureWindowAtIndex).not.toHaveBeenCalled();
  });

  it('creates window 0 when it does not exist', () => {
    process.argv = [process.argv[0], resolve(process.cwd(), 'bin/discode.ts'), 'new'];
    const ensureTuiPane = vi.fn();
    const windowExists = vi.fn(() => false);
    const ensureWindowAtIndex = vi.fn();

    ensureProjectTuiPane({ ensureTuiPane, windowExists, ensureWindowAtIndex } as any, 'agent-demo', 'demo-claude', {});

    expect(windowExists).toHaveBeenCalledWith('agent-demo', '0');
    expect(ensureWindowAtIndex).toHaveBeenCalledWith('agent-demo', 0);
    expect(ensureTuiPane).toHaveBeenCalledTimes(1);
    expect(ensureTuiPane).toHaveBeenCalledWith(
      'agent-demo',
      '0',
      [expect.stringMatching(/bun$/), resolve(process.cwd(), 'bin/discode.ts'), 'tui'],
    );
  });
});
