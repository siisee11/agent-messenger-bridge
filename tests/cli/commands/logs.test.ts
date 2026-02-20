import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const existsSync = vi.fn().mockReturnValue(true);
  const spawnResult = {
    on: vi.fn(),
  };
  const spawn = vi.fn().mockReturnValue(spawnResult);
  const getLogFile = vi.fn().mockReturnValue('/home/user/.discode/daemon.log');

  return { existsSync, spawn, spawnResult, getLogFile };
});

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('../../../src/daemon.js', () => ({
  defaultDaemonManager: {
    getLogFile: mocks.getLogFile,
  },
}));

describe('logsCommand', () => {
  let logsCommand: typeof import('../../../src/cli/commands/logs.js').logsCommand;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../../../src/cli/commands/logs.js');
    logsCommand = mod.logsCommand;
  });

  it('runs tail with default 50 lines when log file exists', () => {
    logsCommand({});

    expect(mocks.spawn).toHaveBeenCalledWith(
      'tail',
      ['-n', '50', '/home/user/.discode/daemon.log'],
      { stdio: 'inherit' }
    );
  });

  it('runs tail -f when --follow is set', () => {
    logsCommand({ follow: true });

    expect(mocks.spawn).toHaveBeenCalledWith(
      'tail',
      ['-f', '-n', '50', '/home/user/.discode/daemon.log'],
      { stdio: 'inherit' }
    );
  });

  it('passes custom --lines value', () => {
    logsCommand({ lines: 100 });

    expect(mocks.spawn).toHaveBeenCalledWith(
      'tail',
      ['-n', '100', '/home/user/.discode/daemon.log'],
      { stdio: 'inherit' }
    );
  });

  it('combines --follow and --lines', () => {
    logsCommand({ follow: true, lines: 200 });

    expect(mocks.spawn).toHaveBeenCalledWith(
      'tail',
      ['-f', '-n', '200', '/home/user/.discode/daemon.log'],
      { stdio: 'inherit' }
    );
  });

  it('shows warning when log file does not exist', () => {
    mocks.existsSync.mockReturnValue(false);

    logsCommand({});

    expect(mocks.spawn).not.toHaveBeenCalled();
    const warning = consoleSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('No daemon log found')
    );
    expect(warning).toBeDefined();
  });

  it('checks the correct log file path from daemon manager', () => {
    mocks.getLogFile.mockReturnValue('/custom/path/daemon.log');
    mocks.existsSync.mockReturnValue(true);

    logsCommand({});

    expect(mocks.existsSync).toHaveBeenCalledWith('/custom/path/daemon.log');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'tail',
      ['-n', '50', '/custom/path/daemon.log'],
      { stdio: 'inherit' }
    );
  });
});
