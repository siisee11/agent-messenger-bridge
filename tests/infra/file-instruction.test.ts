/**
 * Tests for file-instruction module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getFileInstructionText,
  installFileInstructionForClaude,
  installFileInstructionForOpencode,
  installFileInstructionForCodex,
  installFileInstructionGeneric,
  installFileInstruction,
} from '../../src/infra/file-instruction.js';

describe('getFileInstructionText', () => {
  it('contains the start and end markers', () => {
    const text = getFileInstructionText();
    expect(text).toContain('<!-- discode:file-instructions -->');
    expect(text).toContain('<!-- /discode:file-instructions -->');
  });

  it('documents the [file:...] marker format', () => {
    const text = getFileInstructionText();
    expect(text).toContain('[file:');
  });

  it('mentions supported image formats', () => {
    const text = getFileInstructionText();
    expect(text).toContain('PNG');
    expect(text).toContain('JPEG');
    expect(text).toContain('GIF');
    expect(text).toContain('WebP');
  });

  it('mentions supported document formats', () => {
    const text = getFileInstructionText();
    expect(text).toContain('PDF');
    expect(text).toContain('DOCX');
    expect(text).toContain('PPTX');
    expect(text).toContain('XLSX');
    expect(text).toContain('CSV');
    expect(text).toContain('JSON');
    expect(text).toContain('TXT');
  });

  it('includes sending files to Discord instructions', () => {
    const text = getFileInstructionText();
    expect(text).toContain('Sending files to Discord');
    expect(text).toContain('discode-send');
  });

  it('includes discode description header', () => {
    const text = getFileInstructionText();
    expect(text).toContain('Discode');
    expect(text).toContain('Discord/Slack');
  });

  it('instructs not to include file paths in response text', () => {
    const text = getFileInstructionText();
    expect(text).toContain('Do NOT include absolute file paths in your response text');
  });

  it('emphasizes discode-send is pre-configured', () => {
    const text = getFileInstructionText();
    expect(text).toContain('pre-configured and ready to use');
    expect(text).toContain('Do NOT explore the project or check settings');
  });

  it('describes the files directory as shared workspace with MUST-check rule', () => {
    const text = getFileInstructionText();
    expect(text).toContain('shared file workspace');
    expect(text).toContain('MUST list the files');
    expect(text).toContain('ALWAYS CHECK HERE FIRST');
  });

  it('includes venv instruction for Python dependencies', () => {
    const text = getFileInstructionText();
    expect(text).toContain('Python dependencies for document processing');
    expect(text).toContain('python3 -m venv');
    expect(text).toContain('.venv');
    expect(text).toContain('Never install');
  });

  it('uses relative path when projectPath is not provided', () => {
    const text = getFileInstructionText();
    expect(text).toContain('.discode/files/');
    expect(text).not.toContain('/abs/path/.discode/files/');
  });

  it('uses absolute path when projectPath is provided', () => {
    const text = getFileInstructionText('/abs/path');
    expect(text).toContain('/abs/path/.discode/files/');
  });
});

describe('installFileInstructionForClaude', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-claude-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .discode/CLAUDE.md with instruction including absolute files dir', () => {
    installFileInstructionForClaude(tempDir);

    const claudeMd = join(tempDir, '.discode', 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);

    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('<!-- discode:file-instructions -->');
    expect(content).toContain('[file:');
    expect(content).toContain(`${tempDir}/.discode/files/`);
    expect(content).toContain('Sending files to Discord');
  });

  it('always overwrites with latest content (discode-owned file)', () => {
    const discodeDir = join(tempDir, '.discode');
    mkdirSync(discodeDir, { recursive: true });
    writeFileSync(join(discodeDir, 'CLAUDE.md'), '<!-- discode:file-instructions -->\nold content\n', 'utf-8');

    installFileInstructionForClaude(tempDir);

    const content = readFileSync(join(discodeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('discode-send');
    expect(content).not.toContain('old content');
  });

  it('overwrites even when legacy marker is present', () => {
    const discodeDir = join(tempDir, '.discode');
    mkdirSync(discodeDir, { recursive: true });
    writeFileSync(join(discodeDir, 'CLAUDE.md'), '<!-- discode:image-instructions -->\nold content\n', 'utf-8');

    installFileInstructionForClaude(tempDir);

    const content = readFileSync(join(discodeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- discode:file-instructions -->');
    expect(content).toContain('discode-send');
    expect(content).not.toContain('old content');
  });

  it('does not duplicate markers on repeated installs', () => {
    installFileInstructionForClaude(tempDir);
    installFileInstructionForClaude(tempDir);

    const content = readFileSync(join(tempDir, '.discode', 'CLAUDE.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:file-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });
});

describe('installFileInstructionForOpencode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-opencode-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .opencode/instructions.md with instruction', () => {
    installFileInstructionForOpencode(tempDir);

    const instructionsPath = join(tempDir, '.opencode', 'instructions.md');
    expect(existsSync(instructionsPath)).toBe(true);

    const content = readFileSync(instructionsPath, 'utf-8');
    expect(content).toContain('<!-- discode:file-instructions -->');
  });

  it('replaces the discode section on re-install (preserves user content)', () => {
    const opencodeDir = join(tempDir, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'instructions.md'),
      '# My rules\n\n<!-- discode:file-instructions -->\nold discode content\n<!-- /discode:file-instructions -->\n\n# More rules\n',
      'utf-8',
    );

    installFileInstructionForOpencode(tempDir);

    const content = readFileSync(join(opencodeDir, 'instructions.md'), 'utf-8');
    expect(content).toContain('# My rules');
    expect(content).toContain('# More rules');
    expect(content).toContain('discode-send');
    expect(content).not.toContain('old discode content');
  });

  it('replaces old-format section (no end marker) on re-install', () => {
    const opencodeDir = join(tempDir, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'instructions.md'),
      '# My rules\n\n<!-- discode:file-instructions -->\nold stuff no end marker\n',
      'utf-8',
    );

    installFileInstructionForOpencode(tempDir);

    const content = readFileSync(join(opencodeDir, 'instructions.md'), 'utf-8');
    expect(content).toContain('# My rules');
    expect(content).toContain('discode-send');
    expect(content).not.toContain('old stuff no end marker');
  });

  it('appends to existing instructions.md without marker', () => {
    const opencodeDir = join(tempDir, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, 'instructions.md'), '# My rules\n', 'utf-8');

    installFileInstructionForOpencode(tempDir);

    const content = readFileSync(join(opencodeDir, 'instructions.md'), 'utf-8');
    expect(content).toContain('# My rules');
    expect(content).toContain('<!-- discode:file-instructions -->');
  });

  it('does not duplicate markers on repeated installs', () => {
    installFileInstructionForOpencode(tempDir);
    installFileInstructionForOpencode(tempDir);

    const content = readFileSync(join(tempDir, '.opencode', 'instructions.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:file-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });
});

describe('installFileInstructionForCodex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-codex-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates AGENTS.md at project root with instruction', () => {
    installFileInstructionForCodex(tempDir);

    const agentsMdPath = join(tempDir, 'AGENTS.md');
    expect(existsSync(agentsMdPath)).toBe(true);

    const content = readFileSync(agentsMdPath, 'utf-8');
    expect(content).toContain('<!-- discode:file-instructions -->');
    expect(content).toContain(`${tempDir}/.discode/files/`);
    expect(content).toContain('shared file workspace');
  });

  it('replaces the discode section on re-install (preserves user content)', () => {
    writeFileSync(
      join(tempDir, 'AGENTS.md'),
      '# Project rules\n\n<!-- discode:file-instructions -->\nold content\n<!-- /discode:file-instructions -->\n\n# Footer\n',
      'utf-8',
    );

    installFileInstructionForCodex(tempDir);

    const content = readFileSync(join(tempDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# Project rules');
    expect(content).toContain('# Footer');
    expect(content).toContain('discode-send');
    expect(content).not.toContain('old content');
  });

  it('does not duplicate markers on repeated installs', () => {
    installFileInstructionForCodex(tempDir);
    installFileInstructionForCodex(tempDir);

    const content = readFileSync(join(tempDir, 'AGENTS.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:file-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });

  it('appends to existing AGENTS.md without marker', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Project rules\n', 'utf-8');

    installFileInstructionForCodex(tempDir);

    const content = readFileSync(join(tempDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# Project rules');
    expect(content).toContain('<!-- discode:file-instructions -->');
  });
});

describe('installFileInstructionGeneric', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-generic-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .discode/FILE_INSTRUCTIONS.md', () => {
    installFileInstructionGeneric(tempDir);

    const path = join(tempDir, '.discode', 'FILE_INSTRUCTIONS.md');
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('<!-- discode:file-instructions -->');
  });

  it('always overwrites with latest content (discode-owned file)', () => {
    installFileInstructionGeneric(tempDir);
    installFileInstructionGeneric(tempDir);

    const content = readFileSync(join(tempDir, '.discode', 'FILE_INSTRUCTIONS.md'), 'utf-8');
    const markerCount = (content.match(/<!-- discode:file-instructions -->/g) || []).length;
    expect(markerCount).toBe(1);
  });
});

describe('installFileInstruction', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-dispatch-instr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('dispatches to claude handler for agent type "claude"', () => {
    installFileInstruction(tempDir, 'claude');
    expect(existsSync(join(tempDir, '.discode', 'CLAUDE.md'))).toBe(true);
  });

  it('dispatches to opencode handler for agent type "opencode"', () => {
    installFileInstruction(tempDir, 'opencode');
    expect(existsSync(join(tempDir, '.opencode', 'instructions.md'))).toBe(true);
  });

  it('dispatches to codex handler for agent type "codex"', () => {
    installFileInstruction(tempDir, 'codex');
    expect(existsSync(join(tempDir, 'AGENTS.md'))).toBe(true);
  });

  it('dispatches to generic handler for unknown agent types', () => {
    installFileInstruction(tempDir, 'some-other-agent');
    expect(existsSync(join(tempDir, '.discode', 'FILE_INSTRUCTIONS.md'))).toBe(true);
  });
});
