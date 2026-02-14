/**
 * Tests for file-downloader module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isSupportedFile,
  getFilesDir,
  buildFileMarkers,
  downloadFileAttachments,
} from '../../src/infra/file-downloader.js';
import type { DiscordAttachment } from '../../src/types/index.js';

function makeAttachment(overrides: Partial<DiscordAttachment> = {}): DiscordAttachment {
  return {
    url: 'https://cdn.discordapp.com/attachments/123/456/test.png',
    filename: 'test.png',
    contentType: 'image/png',
    size: 1024,
    ...overrides,
  };
}

describe('isSupportedFile', () => {
  it('returns true for image/png', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'image/png' }))).toBe(true);
  });

  it('returns true for image/jpeg', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'image/jpeg' }))).toBe(true);
  });

  it('returns true for image/gif', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'image/gif' }))).toBe(true);
  });

  it('returns true for image/webp', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'image/webp' }))).toBe(true);
  });

  it('returns true for application/pdf', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'application/pdf', filename: 'doc.pdf' }))).toBe(true);
  });

  it('returns true for text/plain', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'text/plain', filename: 'readme.txt' }))).toBe(true);
  });

  it('returns true for text/csv', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'text/csv', filename: 'data.csv' }))).toBe(true);
  });

  it('returns true for application/json', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'application/json', filename: 'config.json' }))).toBe(true);
  });

  it('returns true for docx MIME type', () => {
    expect(isSupportedFile(makeAttachment({
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'doc.docx',
    }))).toBe(true);
  });

  it('returns true for pptx MIME type', () => {
    expect(isSupportedFile(makeAttachment({
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: 'slides.pptx',
    }))).toBe(true);
  });

  it('returns true for xlsx MIME type', () => {
    expect(isSupportedFile(makeAttachment({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'data.xlsx',
    }))).toBe(true);
  });

  it('returns false for unsupported MIME type', () => {
    expect(isSupportedFile(makeAttachment({ contentType: 'application/zip', filename: 'archive.zip' }))).toBe(false);
  });

  it('falls back to extension when contentType is null', () => {
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'photo.jpg' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'photo.jpeg' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'anim.gif' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'modern.webp' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'doc.pdf' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'doc.docx' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'data.csv' }))).toBe(true);
    expect(isSupportedFile(makeAttachment({ contentType: null, filename: 'archive.zip' }))).toBe(false);
  });
});

describe('getFilesDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .discode/files/ directory under projectPath', () => {
    const dir = getFilesDir(tempDir);
    expect(dir).toBe(join(tempDir, '.discode', 'files'));
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent', () => {
    const dir1 = getFilesDir(tempDir);
    const dir2 = getFilesDir(tempDir);
    expect(dir1).toBe(dir2);
    expect(existsSync(dir1)).toBe(true);
  });
});

describe('buildFileMarkers', () => {
  it('returns empty string for no files', () => {
    expect(buildFileMarkers([])).toBe('');
  });

  it('returns marker for single file', () => {
    const result = buildFileMarkers([
      { localPath: '/tmp/test/img.png', originalName: 'img.png', contentType: 'image/png' },
    ]);
    expect(result).toBe('\n[file:/tmp/test/img.png]');
  });

  it('returns markers for multiple files', () => {
    const result = buildFileMarkers([
      { localPath: '/tmp/a.png', originalName: 'a.png', contentType: 'image/png' },
      { localPath: '/tmp/b.pdf', originalName: 'b.pdf', contentType: 'application/pdf' },
    ]);
    expect(result).toBe('\n[file:/tmp/a.png]\n[file:/tmp/b.pdf]');
  });
});

describe('downloadFileAttachments', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-dl-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns empty array when no supported attachments', async () => {
    const result = await downloadFileAttachments(
      [makeAttachment({ contentType: 'application/zip', filename: 'archive.zip' })],
      tempDir,
    );
    expect(result).toEqual([]);
  });

  it('skips oversized files (>25MB)', async () => {
    const result = await downloadFileAttachments(
      [makeAttachment({ size: 26 * 1024 * 1024 })],
      tempDir,
    );
    expect(result).toEqual([]);
  });

  it('downloads and saves a valid image attachment', async () => {
    const fakeImageData = Buffer.from('fake-png-data');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeImageData.buffer.slice(
        fakeImageData.byteOffset,
        fakeImageData.byteOffset + fakeImageData.byteLength
      )),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadFileAttachments(
      [makeAttachment({ filename: 'screenshot.png', contentType: 'image/png', size: 1024 })],
      tempDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].originalName).toBe('screenshot.png');
    expect(result[0].contentType).toBe('image/png');
    expect(result[0].localPath).toContain('.discode/files/');
    expect(result[0].localPath).toContain('screenshot.png');
    expect(existsSync(result[0].localPath)).toBe(true);
  });

  it('downloads and saves a PDF attachment', async () => {
    const fakePdfData = Buffer.from('fake-pdf-data');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakePdfData.buffer.slice(
        fakePdfData.byteOffset,
        fakePdfData.byteOffset + fakePdfData.byteLength
      )),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadFileAttachments(
      [makeAttachment({ filename: 'report.pdf', contentType: 'application/pdf', size: 2048 })],
      tempDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].originalName).toBe('report.pdf');
    expect(result[0].contentType).toBe('application/pdf');
    expect(result[0].localPath).toContain('.discode/files/');
    expect(result[0].localPath).toContain('report.pdf');
    expect(existsSync(result[0].localPath)).toBe(true);
  });

  it('handles fetch errors gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadFileAttachments(
      [makeAttachment({ size: 1024 })],
      tempDir,
    );

    expect(result).toEqual([]);
  });

  it('handles network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadFileAttachments(
      [makeAttachment({ size: 1024 })],
      tempDir,
    );

    expect(result).toEqual([]);
  });

  it('downloads multiple files including documents', async () => {
    const fakeData = Buffer.from('data');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeData.buffer.slice(
        fakeData.byteOffset,
        fakeData.byteOffset + fakeData.byteLength
      )),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadFileAttachments(
      [
        makeAttachment({ filename: 'a.png', contentType: 'image/png', size: 512 }),
        makeAttachment({ filename: 'b.pdf', contentType: 'application/pdf', size: 512 }),
        makeAttachment({ filename: 'archive.zip', contentType: 'application/zip', size: 100 }),
      ],
      tempDir,
    );

    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
