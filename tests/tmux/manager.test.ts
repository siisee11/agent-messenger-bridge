import { describe, it, expect, beforeEach } from 'vitest';
import { TmuxManager } from '../../src/tmux/manager.js';
import type { ICommandExecutor } from '../../src/types/interfaces.js';

class MockExecutor implements ICommandExecutor {
  calls: { method: string; command: string }[] = [];
  nextResult: string = '';
  shouldThrow: Error | null = null;
  throwOnce: Error | null = null;

  exec(command: string): string {
    this.calls.push({ method: 'exec', command });

    if (this.throwOnce) {
      const error = this.throwOnce;
      this.throwOnce = null;
      throw error;
    }

    if (this.shouldThrow) {
      throw this.shouldThrow;
    }

    return this.nextResult;
  }

  execVoid(command: string, _options?: { stdio?: any }): void {
    this.calls.push({ method: 'execVoid', command });

    if (this.throwOnce) {
      const error = this.throwOnce;
      this.throwOnce = null;
      throw error;
    }

    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
  }

  reset(): void {
    this.calls = [];
    this.nextResult = '';
    this.shouldThrow = null;
    this.throwOnce = null;
  }

  getLastCommand(): string {
    return this.calls[this.calls.length - 1]?.command || '';
  }
}

describe('TmuxManager', () => {
  let executor: MockExecutor;
  let tmux: TmuxManager;

  beforeEach(() => {
    executor = new MockExecutor();
    tmux = new TmuxManager('agent-', executor);
  });

  describe('listSessions', () => {
    it('parses session output correctly', () => {
      executor.nextResult = 'agent-session1|1|3|1704067200\nagent-session2|0|1|1704070800';

      const sessions = tmux.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toEqual({
        name: 'agent-session1',
        attached: true,
        windows: 3,
        created: new Date(1704067200 * 1000),
      });
      expect(sessions[1]).toEqual({
        name: 'agent-session2',
        attached: false,
        windows: 1,
        created: new Date(1704070800 * 1000),
      });
    });

    it('returns empty array when executor throws', () => {
      executor.shouldThrow = new Error('tmux not running');

      const sessions = tmux.listSessions();

      expect(sessions).toEqual([]);
    });

    it('filters by session prefix', () => {
      executor.nextResult = 'agent-session1|1|3|1704067200\nother-session|0|1|1704070800\nagent-session2|0|2|1704074400';

      const sessions = tmux.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0].name).toBe('agent-session1');
      expect(sessions[1].name).toBe('agent-session2');
    });
  });

  describe('createSession', () => {
    it('executes correct tmux command with prefix', () => {
      tmux.createSession('test-session');

      const lastCommand = executor.getLastCommand();
      expect(lastCommand).toContain('tmux new-session -d -s');
      expect(lastCommand).toContain('agent-test-session');
    });

    it('escapes session name with single quotes', () => {
      tmux.createSession("test'session");

      const lastCommand = executor.getLastCommand();
      expect(lastCommand).toContain("'agent-test'\\''session'");
    });

    it('sets first window name when provided', () => {
      tmux.createSession('test-session', 'opencode');

      const lastCommand = executor.getLastCommand();
      expect(lastCommand).toContain('tmux new-session -d -s');
      expect(lastCommand).toContain("-n 'opencode'");
    });
  });

  describe('sessionExists', () => {
    it('returns true when execVoid succeeds', () => {
      const exists = tmux.sessionExists('test');

      expect(exists).toBe(true);
      expect(executor.calls[0].method).toBe('execVoid');
      expect(executor.getLastCommand()).toContain('tmux has-session -t');
    });

    it('returns false when execVoid throws', () => {
      executor.shouldThrow = new Error('session not found');

      const exists = tmux.sessionExists('test');

      expect(exists).toBe(false);
    });
  });

  describe('getOrCreateSession', () => {
    it('returns existing session name when exists', () => {
      // sessionExists will succeed (no throw)
      const sessionName = tmux.getOrCreateSession('existing');

      expect(sessionName).toBe('agent-existing');
      // Should only check existence, not create
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0].method).toBe('execVoid');
    });

    it('creates session when doesn\'t exist', () => {
      // First call (sessionExists) throws, second call (createSession) succeeds
      executor.throwOnce = new Error('session not found');

      const sessionName = tmux.getOrCreateSession('new');

      expect(sessionName).toBe('agent-new');
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0].method).toBe('execVoid'); // sessionExists check
      expect(executor.calls[1].method).toBe('exec'); // createSession
      expect(executor.calls[1].command).toContain('tmux new-session');
    });

    it('uses first window name when creating a new session', () => {
      executor.throwOnce = new Error('session not found');

      const sessionName = tmux.getOrCreateSession('new', 'opencode');

      expect(sessionName).toBe('agent-new');
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[1].command).toContain("-n 'opencode'");
    });
  });

  describe('createWindow', () => {
    it('executes correct command with session and window name', () => {
      tmux.createWindow('agent-session', 'my-window');

      const lastCommand = executor.getLastCommand();
      expect(lastCommand).toContain("tmux new-window -t 'agent-session' -n");
      expect(lastCommand).toContain("'my-window'");
    });

    it('passes initial command when provided', () => {
      tmux.createWindow('agent-session', 'my-window', 'node agent.js');

      const lastCommand = executor.getLastCommand();
      expect(lastCommand).toContain("tmux new-window -t 'agent-session' -n 'my-window'");
      expect(lastCommand).toContain("'node agent.js'");
    });
  });

  describe('ensureWindowAtIndex', () => {
    it('does nothing when target index already exists', () => {
      tmux.ensureWindowAtIndex('agent-session', 0);

      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0].method).toBe('execVoid');
      expect(executor.calls[0].command).toContain("tmux list-panes -t 'agent-session:0'");
      expect(executor.calls.some((call) => call.command.includes('tmux new-window'))).toBe(false);
    });

    it('creates target index when missing', () => {
      executor.throwOnce = new Error('window not found');
      tmux.ensureWindowAtIndex('agent-session', 0);

      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0].method).toBe('execVoid');
      expect(executor.calls[1].method).toBe('exec');
      expect(executor.calls[1].command).toContain("tmux new-window -d -t 'agent-session:0' -n 'discode-control'");
    });

    it('throws when window creation fails and index still missing', () => {
      executor.execVoid = (command: string) => {
        executor.calls.push({ method: 'execVoid', command });
        throw new Error('window not found');
      };
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        throw new Error('create failed');
      };

      expect(() => tmux.ensureWindowAtIndex('agent-session', 0)).toThrow(
        "Failed to create window index '0' in session 'agent-session': create failed",
      );
    });
  });

  describe('listWindows', () => {
    it('returns parsed window names', () => {
      executor.nextResult = 'window1\nwindow2\nwindow3\n';

      const windows = tmux.listWindows('agent-session');

      expect(windows).toEqual(['window1', 'window2', 'window3']);
      expect(executor.getLastCommand()).toContain("tmux list-windows -t 'agent-session'");
    });
  });

  describe('sendKeysToWindow', () => {
    it('sends keys then Enter to lowest pane index by default', () => {
      executor.nextResult = '1\n2\n';
      tmux.sendKeysToWindow('agent-session', 'window1', 'echo hello');

      expect(executor.calls).toHaveLength(3);
      expect(executor.calls[0].command).toContain("tmux list-panes -t 'agent-session:window1'");
      expect(executor.calls[1].command).toContain("tmux send-keys -t 'agent-session:window1.1'");
      expect(executor.calls[1].command).toContain('echo hello');
      expect(executor.calls[2].command).toContain("tmux send-keys -t 'agent-session:window1.1' Enter");
    });

    it('escapes keys with single quotes', () => {
      executor.nextResult = '0\n';
      tmux.sendKeysToWindow('agent-session', 'window1', "echo 'test'");

      const sendKeysCommand = executor.calls[1].command;
      expect(sendKeysCommand).toContain("'echo '\\''test'\\'''");
    });

    it('keeps explicit pane target when provided', () => {
      tmux.sendKeysToWindow('agent-session', 'window1.2', 'echo hello');

      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0].command).toContain("tmux send-keys -t 'agent-session:window1.2'");
    });

    it('avoids sending keys to the discode tui pane', () => {
      executor.nextResult = '0\tdiscode-tui\tbun /repo/dist/bin/discode.js tui\n1\tcodex\tcodex';
      tmux.sendKeysToWindow('agent-session', 'window1', 'echo hello');

      expect(executor.calls[1].command).toContain("tmux send-keys -t 'agent-session:window1.1'");
    });

    it('routes to pane matching agent hint in target name', () => {
      executor.nextResult =
        '0\topencode\topencode\n1\tclaude\tclaude\n2\tcodex\tcodex\n3\tdiscode-tui\tbun /repo/dist/bin/discode.js tui';
      tmux.sendKeysToWindow('agent-session', 'myproj-codex', 'echo hello');

      expect(executor.calls[1].command).toContain("tmux send-keys -t 'agent-session:myproj-codex.2'");
      expect(executor.calls[2].command).toContain("tmux send-keys -t 'agent-session:myproj-codex.2' Enter");
    });

  });

  describe('typeKeysToWindow', () => {
    it('types keys without sending Enter', () => {
      executor.nextResult = '1\n';
      tmux.typeKeysToWindow('agent-session', 'codex', 'hello');
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[1].command).toContain("tmux send-keys -t 'agent-session:codex.1'");
      expect(executor.calls[1].command).toContain('hello');
      expect(executor.calls[1].command).not.toContain(' Enter');
    });
  });

  describe('sendEnterToWindow', () => {
    it('sends Enter to the specified window', () => {
      executor.nextResult = '1\n';
      tmux.sendEnterToWindow('agent-session', 'codex');
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[1].command).toContain("tmux send-keys -t 'agent-session:codex.1' Enter");
    });
  });

  describe('capturePaneFromWindow', () => {
    it('returns captured pane content', () => {
      executor.nextResult = '0\n';

      const output = tmux.capturePaneFromWindow('agent-session', 'window1');

      expect(executor.getLastCommand()).toContain("tmux capture-pane -t 'agent-session:window1.0' -p");
      executor.nextResult = 'pane output line 1\npane output line 2';
      const captured = tmux.capturePaneFromWindow('agent-session', 'window1.0');
      expect(captured).toBe('pane output line 1\npane output line 2');
    });
  });

  describe('setSessionEnv', () => {
    it('executes set-environment command with escaped key/value', () => {
      tmux.setSessionEnv('agent-session', 'MY_VAR', 'my value');

      const lastCommand = executor.getLastCommand();
      expect(lastCommand).toContain("tmux set-environment -t 'agent-session'");
      expect(lastCommand).toContain("'MY_VAR'");
      expect(lastCommand).toContain("'my value'");
    });
  });

  describe('startAgentInWindow', () => {
    it('sends command to existing window when present', () => {
      executor.nextResult = '0\n';
      tmux.startAgentInWindow('agent-session', 'agent-window', 'node agent.js');

      expect(executor.calls[0].method).toBe('execVoid');
      expect(executor.calls[0].command).toContain("tmux list-panes -t 'agent-session:agent-window'");
      expect(executor.calls.some(call => call.command.includes('tmux send-keys'))).toBe(true);
      expect(executor.calls.some(call => call.command.includes('tmux new-window'))).toBe(false);
    });

    it('creates window with shell then sends command when window is missing', () => {
      executor.throwOnce = new Error('window not found');
      tmux.startAgentInWindow('agent-session', 'agent-window', 'node agent.js');

      expect(executor.calls[0].method).toBe('execVoid');
      const newWindowCall = executor.calls.find(c => c.command.includes('tmux new-window'));
      expect(newWindowCall).toBeDefined();
      // Window created without initial command (shell only)
      expect(newWindowCall!.command).not.toContain('node agent.js');
      // Command sent via send-keys instead
      expect(executor.calls.some(c => c.command.includes('tmux send-keys') && c.command.includes('node agent.js'))).toBe(true);
    });

    it('ignores duplicate window error', () => {
      const originalExec = executor.exec.bind(executor);
      executor.execVoid = (command: string) => {
        executor.calls.push({ method: 'execVoid', command });
        throw new Error('window not found');
      };
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        if (command.includes('tmux new-window')) {
          throw new Error('duplicate window: agent-window');
        }
        return '';
      };

      // Should not throw
      expect(() => {
        tmux.startAgentInWindow('agent-session', 'agent-window', 'node agent.js');
      }).not.toThrow();

      // Should still send keys after ignoring the duplicate error
      expect(executor.calls.length).toBeGreaterThanOrEqual(2);
      expect(executor.calls.some(call => call.command.includes('tmux send-keys'))).toBe(true);
      executor.exec = originalExec;
    });

    it('recreates window when duplicate path cannot find target window', () => {
      const originalExec = executor.exec.bind(executor);
      executor.execVoid = (command: string) => {
        executor.calls.push({ method: 'execVoid', command });
        throw new Error('window not found');
      };
      let newWindowCalls = 0;
      let sendCalls = 0;
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        if (command.includes('tmux new-window') && newWindowCalls === 0) {
          newWindowCalls += 1;
          throw new Error('duplicate window: agent-window');
        }
        if (command.includes('send-keys') && sendCalls === 0) {
          sendCalls += 1;
          throw new Error("can't find window: agent-window");
        }
        return '';
      };

      expect(() => {
        tmux.startAgentInWindow('agent-session', 'agent-window', 'node agent.js');
      }).not.toThrow();

      expect(executor.calls.some(call => call.command.includes('tmux new-window'))).toBe(true);
      executor.exec = originalExec;
    });
  });

  describe('ensureTuiPane', () => {
    it('creates a right-side split and titles it', () => {
      const originalExec = executor.exec.bind(executor);
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        if (command.includes('list-panes')) {
          return '0\tcodex\tcodex';
        }
        if (command.includes('display-message')) {
          return '220';
        }
        if (command.includes('split-window')) {
          return '1';
        }
        return '';
      };

      tmux.ensureTuiPane('agent-session', 'codex', "'bun' '/repo/dist/bin/discode.js' 'tui'");

      expect(executor.calls.some(call => call.command.includes('tmux split-window') && call.command.includes(' -h ') && call.command.includes(' -l 80 '))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux select-pane -t 'agent-session:codex.1' -T 'discode-tui'"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux set-window-option -t 'agent-session:codex' window-size latest"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux resize-pane -t 'agent-session:codex.1' -x 80"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes('tmux run-shell -b') && call.command.includes('sleep 0.35') && call.command.includes('resize-pane') && call.command.includes(' -x 80'))).toBe(true);
      executor.exec = originalExec;
    });

    it('keeps tui pane narrower than ai pane on narrow windows', () => {
      const originalExec = executor.exec.bind(executor);
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        if (command.includes('list-panes')) {
          return '0\tcodex\tcodex';
        }
        if (command.includes('display-message')) {
          return '70';
        }
        if (command.includes('split-window')) {
          return '1';
        }
        return '';
      };

      tmux.ensureTuiPane('agent-session', 'codex', "'bun' '/repo/dist/bin/discode.js' 'tui'");

      expect(executor.calls.some(call => call.command.includes('tmux split-window') && call.command.includes(' -l 34 '))).toBe(true);
      executor.exec = originalExec;
    });

    it('reuses existing tui pane and removes duplicates', () => {
      const originalExec = executor.exec.bind(executor);
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        if (command.includes('list-panes')) {
          return '2\tdiscode-tui\tbun /repo/dist/bin/discode.js tui\n1\tdiscode-tui\tbun /repo/dist/bin/discode.js tui\n0\tcodex\tcodex';
        }
        return '';
      };

      tmux.ensureTuiPane('agent-session', 'codex', "'bun' '/repo/dist/bin/discode.js' 'tui'");

      expect(executor.calls.some(call => call.command.includes("tmux kill-pane -t 'agent-session:codex.2'"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux resize-pane -t 'agent-session:codex.1' -x 80"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes('tmux split-window'))).toBe(false);
      executor.exec = originalExec;
    });

    it('forces main-vertical layout to keep tui pane narrow', () => {
      const originalExec = executor.exec.bind(executor);
      executor.exec = (command: string) => {
        executor.calls.push({ method: 'exec', command });
        if (command.includes('display-message')) {
          return '120';
        }
        if (command.includes('list-panes')) {
          return '1\tdiscode-tui\tbun /repo/dist/bin/discode.js tui\n0\tcodex\tcodex';
        }
        return '';
      };

      tmux.ensureTuiPane('agent-session', 'codex', "'bun' '/repo/dist/bin/discode.js' 'tui'");

      expect(executor.calls.some(call => call.command.includes("tmux set-window-option -t 'agent-session:codex' window-size latest"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux select-layout -t 'agent-session:codex' main-vertical"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux set-window-option -t 'agent-session:codex' main-pane-width 60"))).toBe(true);
      expect(executor.calls.some(call => call.command.includes("tmux resize-pane -t 'agent-session:codex.1' -x 59"))).toBe(true);
      executor.exec = originalExec;
    });

  });
});
