import { randomUUID } from 'crypto';
import { getConfigValue, saveConfig } from '../config/index.js';

const TELEMETRY_TIMEOUT_MS = 250;

export interface CliCommandTelemetryEvent {
  command: string;
  success: boolean;
  durationMs: number;
  cliVersion: string;
}

export interface TelemetrySettings {
  enabled: boolean;
  endpoint?: string;
  installId?: string;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

function sanitizeCommand(command: string): string {
  const normalized = command.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!normalized) return 'unknown';
  return normalized.slice(0, 40);
}

function sanitizeDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  const rounded = Math.max(0, Math.round(durationMs));
  return Math.min(rounded, 60_000_000);
}

function detectRuntime(): 'bun' | 'node' | 'unknown' {
  if (typeof globalThis !== 'undefined' && 'Bun' in globalThis) return 'bun';
  if (typeof process !== 'undefined' && process.release?.name === 'node') return 'node';
  return 'unknown';
}

export function isValidTelemetryEndpoint(urlValue: string): boolean {
  try {
    const parsed = new URL(urlValue);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveTelemetrySettings(): TelemetrySettings {
  const storedEnabled = getConfigValue('telemetryEnabled');
  const envEnabled = parseBooleanEnv(process.env.DISCODE_TELEMETRY_ENABLED);
  const enabled = typeof storedEnabled === 'boolean' ? storedEnabled : envEnabled === true;

  const storedEndpoint = getConfigValue('telemetryEndpoint')?.trim();
  const envEndpoint = process.env.DISCODE_TELEMETRY_ENDPOINT?.trim();
  const endpoint = storedEndpoint || envEndpoint || undefined;

  const storedInstallId = getConfigValue('telemetryInstallId')?.trim();
  const envInstallId = process.env.DISCODE_TELEMETRY_INSTALL_ID?.trim();
  const installId = storedInstallId || envInstallId || undefined;

  return { enabled, endpoint, installId };
}

export function ensureTelemetryInstallId(): string | undefined {
  const settings = resolveTelemetrySettings();
  if (settings.installId) return settings.installId;

  const generated = randomUUID();
  try {
    saveConfig({ telemetryInstallId: generated });
    return generated;
  } catch {
    return undefined;
  }
}

export async function recordCliCommandTelemetry(event: CliCommandTelemetryEvent): Promise<void> {
  const settings = resolveTelemetrySettings();
  if (!settings.enabled || !settings.endpoint) return;
  if (!isValidTelemetryEndpoint(settings.endpoint)) return;

  const installId = settings.installId || ensureTelemetryInstallId();
  if (!installId) return;

  const body = {
    source: 'discode-cli',
    installId,
    version: event.cliVersion,
    platform: process.platform,
    runtime: detectRuntime(),
    events: [
      {
        name: 'cli_command_run',
        params: {
          command: sanitizeCommand(event.command),
          success: event.success ? 1 : 0,
          duration_ms: sanitizeDuration(event.durationMs),
        },
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Never break CLI flow because of telemetry.
  } finally {
    clearTimeout(timeout);
  }
}
