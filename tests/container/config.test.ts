/**
 * Tests for container-related config parsing.
 */

import { describe, expect, it } from 'vitest';
import { ConfigManager, type StoredConfig } from '../../src/config/index.js';
import type { IStorage, IEnvironment } from '../../src/types/interfaces.js';

class MockStorage implements IStorage {
  private files: Map<string, string> = new Map();
  private dirs: Set<string> = new Set();

  readFile(path: string, _encoding: string): string {
    const content = this.files.get(path);
    if (!content) throw new Error(`File not found: ${path}`);
    return content;
  }
  writeFile(path: string, data: string): void { this.files.set(path, data); }
  chmod(): void {}
  exists(path: string): boolean { return this.files.has(path) || this.dirs.has(path); }
  mkdirp(path: string): void { this.dirs.add(path); }
  unlink(path: string): void { this.files.delete(path); }
  openSync(): number { return 0; }
  setFile(path: string, content: string): void { this.files.set(path, content); }
}

class MockEnvironment implements IEnvironment {
  private vars: Map<string, string> = new Map();
  get(key: string): string | undefined { return this.vars.get(key); }
  homedir(): string { return '/mock/home'; }
  platform(): string { return 'linux'; }
  set(key: string, value: string): void { this.vars.set(key, value); }
}

const configDir = '/test/config';
const configFile = '/test/config/config.json';

describe('container config parsing', () => {
  describe('StoredConfig containerEnabled', () => {
    it('enables container from stored config', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const stored: StoredConfig = { containerEnabled: true };
      storage.setFile(configFile, JSON.stringify(stored));

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container).toBeDefined();
      expect(config.container!.enabled).toBe(true);
    });

    it('does not set container when not enabled', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container).toBeUndefined();
    });

    it('reads containerSocketPath from stored config', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const stored: StoredConfig = {
        containerEnabled: true,
        containerSocketPath: '/custom/docker.sock',
      };
      storage.setFile(configFile, JSON.stringify(stored));

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container!.socketPath).toBe('/custom/docker.sock');
    });

    it('reads containerSyncIntervalMs from stored config', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const stored: StoredConfig = {
        containerEnabled: true,
        containerSyncIntervalMs: 60000,
      };
      storage.setFile(configFile, JSON.stringify(stored));

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container!.syncIntervalMs).toBe(60000);
    });
  });

  describe('environment variable overrides', () => {
    it('enables container from DISCODE_CONTAINER=1', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCODE_CONTAINER', '1');

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container).toBeDefined();
      expect(config.container!.enabled).toBe(true);
    });

    it('does not enable container from DISCODE_CONTAINER=0', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCODE_CONTAINER', '0');

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container).toBeUndefined();
    });

    it('reads socket path from DISCODE_CONTAINER_SOCKET_PATH', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCODE_CONTAINER', '1');
      env.set('DISCODE_CONTAINER_SOCKET_PATH', '/env/docker.sock');

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container!.socketPath).toBe('/env/docker.sock');
    });

    it('reads sync interval from DISCODE_CONTAINER_SYNC_INTERVAL_MS', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCODE_CONTAINER', '1');
      env.set('DISCODE_CONTAINER_SYNC_INTERVAL_MS', '15000');

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.container!.syncIntervalMs).toBe(15000);
    });
  });

  describe('saveConfig persistence', () => {
    it('saves containerEnabled', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      manager.saveConfig({ containerEnabled: true });

      const saved = JSON.parse(storage.readFile(configFile, 'utf-8'));
      expect(saved.containerEnabled).toBe(true);
    });

    it('saves containerSocketPath', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      manager.saveConfig({ containerSocketPath: '/my/sock' });

      const saved = JSON.parse(storage.readFile(configFile, 'utf-8'));
      expect(saved.containerSocketPath).toBe('/my/sock');
    });
  });
});
