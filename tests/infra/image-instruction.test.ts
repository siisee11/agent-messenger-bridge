/**
 * Tests for image-instruction module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getImageInstructionText,
  installImageInstructionForClaude,
  installImageInstructionForOpencode,
  installImageInstructionForCodex,
  installImageInstructionGeneric,
  installImageInstruction,
} from '../../src/infra/image-instruction.js';

describe('getImageInstructionText', () => {
  it('contains the discode marker', () => {
    const text = getImageInstructionText();
    expect(text).toContain('<!-- discode:image-instructions -->');
  });

  it('documents the [image:...] marker format', () => {
    const text = getImageInstructionText();
    expect(text).toContain('[image:');
  });

  it('mentions supported formats', () => {
    const text = getImageInstructionText();
    expect(text).toContain('PNG');
    expect(text).toContain('JPEG');
    expect(text).toContain('GIF');
    expect(text).toContain('WebP');
  });

  it('includes sending images to Discord instructions', () => {
    const text = getImageInstructionText();
    expect(text).toContain('Sending images to Discord');
    expect(text).toContain('automatically sent as a Discord');
  });

  it('describes the images directory as shared workspace with MUST-check rule', () => {
    const text = getImageInstructionText();
    expect(text).toContain('shared image workspace');
    expect(text).toContain('MUST list the files');
    expect(text).toContain('ALWAYS CHECK HERE FIRST');
  });

  it('uses relative path when projectPath is not provided', () => {
    const text = getImageInstructionText();
    expect(text).toContain('.discode/images/');
    expect(text).not.toContain('/abs/path/.discode/images/');
  });

  it('uses absolute path when projectPath is provided', () => {
    const text = getImageInstructionText('/abs/path');
    expect(text).toContain('/abs/path/.discode/images/');
  });
});

describe('installImageInstructionForClaude', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-claude-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .discode/CLAUDE.md with instruction including absolute images dir', () => {
    installImageInstructionForClaude(tempDir);

    const claudeMd = join(tempDir, '.discode', 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);

    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('<!-- discode:image-instructions -->');
    expect(content).toContain('[image:');
    expect(content).toContain(`${tempDir}/.discode/images/`);
    expect(content).toContain('Sending images to Discord');
  });

  it('is idempotent (does not duplicate instruction)', () => {
    installImageInstructionForClaude(tempDir);
    installImageInstructionForClaude(tempDir);

    const content = readFileSync(join(tempDir, '.discode', 'CLAUDE.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:image-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });

  it('appends to existing CLAUDE.md without overwriting', () => {
    const discodeDir = join(tempDir, '.discode');
    mkdirSync(discodeDir, { recursive: true });
    writeFileSync(join(discodeDir, 'CLAUDE.md'), '# Existing content\n', 'utf-8');

    installImageInstructionForClaude(tempDir);

    const content = readFileSync(join(discodeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# Existing content');
    expect(content).toContain('<!-- discode:image-instructions -->');
  });
});

describe('installImageInstructionForOpencode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-opencode-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .opencode/instructions.md with instruction', () => {
    installImageInstructionForOpencode(tempDir);

    const instructionsPath = join(tempDir, '.opencode', 'instructions.md');
    expect(existsSync(instructionsPath)).toBe(true);

    const content = readFileSync(instructionsPath, 'utf-8');
    expect(content).toContain('<!-- discode:image-instructions -->');
  });

  it('is idempotent', () => {
    installImageInstructionForOpencode(tempDir);
    installImageInstructionForOpencode(tempDir);

    const content = readFileSync(join(tempDir, '.opencode', 'instructions.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:image-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });

  it('appends to existing instructions.md', () => {
    const opencodeDir = join(tempDir, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, 'instructions.md'), '# My rules\n', 'utf-8');

    installImageInstructionForOpencode(tempDir);

    const content = readFileSync(join(opencodeDir, 'instructions.md'), 'utf-8');
    expect(content).toContain('# My rules');
    expect(content).toContain('<!-- discode:image-instructions -->');
  });
});

describe('installImageInstructionForCodex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-codex-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates AGENTS.md at project root with instruction', () => {
    installImageInstructionForCodex(tempDir);

    const agentsMdPath = join(tempDir, 'AGENTS.md');
    expect(existsSync(agentsMdPath)).toBe(true);

    const content = readFileSync(agentsMdPath, 'utf-8');
    expect(content).toContain('<!-- discode:image-instructions -->');
    expect(content).toContain(`${tempDir}/.discode/images/`);
    expect(content).toContain('shared image workspace');
  });

  it('is idempotent', () => {
    installImageInstructionForCodex(tempDir);
    installImageInstructionForCodex(tempDir);

    const content = readFileSync(join(tempDir, 'AGENTS.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:image-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });

  it('appends to existing AGENTS.md', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Project rules\n', 'utf-8');

    installImageInstructionForCodex(tempDir);

    const content = readFileSync(join(tempDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# Project rules');
    expect(content).toContain('<!-- discode:image-instructions -->');
  });
});

describe('installImageInstructionGeneric', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-generic-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .discode/IMAGE_INSTRUCTIONS.md', () => {
    installImageInstructionGeneric(tempDir);

    const path = join(tempDir, '.discode', 'IMAGE_INSTRUCTIONS.md');
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('<!-- discode:image-instructions -->');
  });

  it('is idempotent', () => {
    installImageInstructionGeneric(tempDir);
    installImageInstructionGeneric(tempDir);

    const content = readFileSync(join(tempDir, '.discode', 'IMAGE_INSTRUCTIONS.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:image-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });
});

describe('installImageInstruction', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-dispatch-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('dispatches to claude handler for agent type "claude"', () => {
    installImageInstruction(tempDir, 'claude');
    expect(existsSync(join(tempDir, '.discode', 'CLAUDE.md'))).toBe(true);
  });

  it('dispatches to opencode handler for agent type "opencode"', () => {
    installImageInstruction(tempDir, 'opencode');
    expect(existsSync(join(tempDir, '.opencode', 'instructions.md'))).toBe(true);
  });

  it('dispatches to codex handler for agent type "codex"', () => {
    installImageInstruction(tempDir, 'codex');
    expect(existsSync(join(tempDir, 'AGENTS.md'))).toBe(true);
  });

  it('dispatches to generic handler for unknown agent types', () => {
    installImageInstruction(tempDir, 'some-other-agent');
    expect(existsSync(join(tempDir, '.discode', 'IMAGE_INSTRUCTIONS.md'))).toBe(true);
  });
});
