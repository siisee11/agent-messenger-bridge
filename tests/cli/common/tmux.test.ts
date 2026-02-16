import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureProjectTuiPane } from '../../../src/cli/common/tmux.js';

describe('ensureProjectTuiPane', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it('runs extensionless argv runner directly', () => {
    process.argv = [process.argv[0], resolve(process.cwd(), 'bin/discode'), 'new'];
    const ensureTuiPane = vi.fn();

    ensureProjectTuiPane({ ensureTuiPane } as any, 'agent-demo', 'demo-claude', {});

    expect(ensureTuiPane).toHaveBeenCalledWith(
      'agent-demo',
      '0',
      [resolve(process.cwd(), 'bin/discode'), 'tui'],
    );
  });

  it('runs script argv runner through bun', () => {
    process.argv = [process.argv[0], resolve(process.cwd(), 'bin/discode.ts'), 'new'];
    const ensureTuiPane = vi.fn();

    ensureProjectTuiPane({ ensureTuiPane } as any, 'agent-demo', 'demo-claude', {});

    expect(ensureTuiPane).toHaveBeenCalledWith(
      'agent-demo',
      '0',
      ['bun', resolve(process.cwd(), 'bin/discode.ts'), 'tui'],
    );
  });
});
