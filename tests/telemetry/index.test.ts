import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getConfigValue = vi.fn();
  const saveConfig = vi.fn();
  const randomUUID = vi.fn().mockReturnValue('generated-install-id');
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  return {
    getConfigValue,
    saveConfig,
    randomUUID,
    fetch,
  };
});

vi.mock('../../src/config/index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  saveConfig: mocks.saveConfig,
}));

vi.mock('crypto', () => ({
  randomUUID: mocks.randomUUID,
}));

describe('telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    delete process.env.DISCODE_TELEMETRY_ENABLED;
    delete process.env.DISCODE_TELEMETRY_ENDPOINT;
    delete process.env.DISCODE_TELEMETRY_INSTALL_ID;
  });

  it('does not send events when telemetry is disabled', async () => {
    mocks.getConfigValue.mockImplementation((key: string) => {
      if (key === 'telemetryEnabled') return false;
      return undefined;
    });

    const mod = await import('../../src/telemetry/index.js');
    await mod.recordCliCommandTelemetry({
      command: 'new',
      success: true,
      durationMs: 42,
      cliVersion: '0.7.4',
    });

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('sends event payload when enabled with endpoint and install id', async () => {
    mocks.getConfigValue.mockImplementation((key: string) => {
      if (key === 'telemetryEnabled') return true;
      if (key === 'telemetryEndpoint') return 'https://telemetry.example/v1/events';
      if (key === 'telemetryInstallId') return 'install-1234';
      return undefined;
    });

    const mod = await import('../../src/telemetry/index.js');
    await mod.recordCliCommandTelemetry({
      command: 'start',
      success: false,
      durationMs: 173,
      cliVersion: '0.7.4',
    });

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://telemetry.example/v1/events');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.source).toBe('discode-cli');
    expect(body.installId).toBe('install-1234');
    expect(body.version).toBe('0.7.4');
    expect(body.events[0].name).toBe('cli_command_run');
    expect(body.events[0].params.command).toBe('start');
    expect(body.events[0].params.success).toBe(0);
    expect(body.events[0].params.duration_ms).toBe(173);
  });

  it('generates and persists install id when missing', async () => {
    mocks.getConfigValue.mockImplementation((key: string) => {
      if (key === 'telemetryEnabled') return true;
      if (key === 'telemetryEndpoint') return 'https://telemetry.example/v1/events';
      if (key === 'telemetryInstallId') return undefined;
      return undefined;
    });

    const mod = await import('../../src/telemetry/index.js');
    await mod.recordCliCommandTelemetry({
      command: 'config',
      success: true,
      durationMs: 99,
      cliVersion: '0.7.4',
    });

    expect(mocks.randomUUID).toHaveBeenCalledOnce();
    expect(mocks.saveConfig).toHaveBeenCalledWith({ telemetryInstallId: 'generated-install-id' });
  });
});
