/**
 * Tests for send-script module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getDiscodeSendScriptSource,
  installDiscodeSendScript,
} from '../../src/infra/send-script.js';

const defaultConfig = { projectName: 'my-project', port: 18470 };

describe('getDiscodeSendScriptSource', () => {
  it('returns a string starting with a shebang', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('hardcodes the project name', () => {
    const source = getDiscodeSendScriptSource({ projectName: 'test-proj', port: 9999 });
    expect(source).toContain('"test-proj"');
  });

  it('hardcodes the port number', () => {
    const source = getDiscodeSendScriptSource({ projectName: 'p', port: 12345 });
    expect(source).toContain('var port     = 12345;');
  });

  it('reads AGENT_DISCORD_AGENT and AGENT_DISCORD_INSTANCE from env vars', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).toContain('AGENT_DISCORD_AGENT');
    expect(source).toContain('AGENT_DISCORD_INSTANCE');
  });

  it('does NOT read AGENT_DISCORD_PROJECT from env vars', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).not.toContain('process.env.AGENT_DISCORD_PROJECT');
  });

  it('does NOT read AGENT_DISCORD_PORT from env vars', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).not.toContain('process.env.AGENT_DISCORD_PORT');
  });

  it('POSTs to /send-files endpoint', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).toContain('/send-files');
    expect(source).toContain('"POST"');
  });

  it('resolves file paths using path.resolve', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).toContain('path.resolve');
  });

  it('sends projectName, agentType, instanceId, and files in payload', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).toContain('projectName');
    expect(source).toContain('agentType');
    expect(source).toContain('instanceId');
    expect(source).toContain('files');
  });

  it('includes a "pre-configured" comment', () => {
    const source = getDiscodeSendScriptSource(defaultConfig);
    expect(source).toContain('Pre-configured by discode');
  });
});

describe('installDiscodeSendScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-send-script-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the script at .discode/bin/discode-send', () => {
    const scriptPath = installDiscodeSendScript(tempDir, defaultConfig);

    expect(scriptPath).toBe(join(tempDir, '.discode', 'bin', 'discode-send'));
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('makes the script executable', () => {
    const scriptPath = installDiscodeSendScript(tempDir, defaultConfig);

    const mode = statSync(scriptPath).mode;
    // Check owner-execute bit is set (0o100)
    expect(mode & 0o100).toBeTruthy();
  });

  it('writes the correct script content with hardcoded config', () => {
    const config = { projectName: 'demo', port: 9999 };
    const scriptPath = installDiscodeSendScript(tempDir, config);
    const content = readFileSync(scriptPath, 'utf-8');

    expect(content).toBe(getDiscodeSendScriptSource(config));
    expect(content).toContain('"demo"');
    expect(content).toContain('9999');
  });

  it('is idempotent — overwrites with latest version', () => {
    installDiscodeSendScript(tempDir, defaultConfig);
    const scriptPath = installDiscodeSendScript(tempDir, defaultConfig);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toBe(getDiscodeSendScriptSource(defaultConfig));
  });

  it('creates intermediate directories', () => {
    const scriptPath = installDiscodeSendScript(tempDir, defaultConfig);

    expect(existsSync(join(tempDir, '.discode', 'bin'))).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('creates a CommonJS package.json in the bin directory', () => {
    installDiscodeSendScript(tempDir, defaultConfig);

    const pkgJsonPath = join(tempDir, '.discode', 'bin', 'package.json');
    expect(existsSync(pkgJsonPath)).toBe(true);

    const content = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    expect(content.type).toBe('commonjs');
  });
});
