/**
 * Tests for image-downloader module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isSupportedImage,
  getImagesDir,
  buildImageMarkers,
  downloadImageAttachments,
} from '../../src/infra/image-downloader.js';
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

describe('isSupportedImage', () => {
  it('returns true for image/png', () => {
    expect(isSupportedImage(makeAttachment({ contentType: 'image/png' }))).toBe(true);
  });

  it('returns true for image/jpeg', () => {
    expect(isSupportedImage(makeAttachment({ contentType: 'image/jpeg' }))).toBe(true);
  });

  it('returns true for image/gif', () => {
    expect(isSupportedImage(makeAttachment({ contentType: 'image/gif' }))).toBe(true);
  });

  it('returns true for image/webp', () => {
    expect(isSupportedImage(makeAttachment({ contentType: 'image/webp' }))).toBe(true);
  });

  it('returns false for text/plain', () => {
    expect(isSupportedImage(makeAttachment({ contentType: 'text/plain', filename: 'readme.txt' }))).toBe(false);
  });

  it('returns false for application/pdf', () => {
    expect(isSupportedImage(makeAttachment({ contentType: 'application/pdf', filename: 'doc.pdf' }))).toBe(false);
  });

  it('falls back to extension when contentType is null', () => {
    expect(isSupportedImage(makeAttachment({ contentType: null, filename: 'photo.jpg' }))).toBe(true);
    expect(isSupportedImage(makeAttachment({ contentType: null, filename: 'photo.jpeg' }))).toBe(true);
    expect(isSupportedImage(makeAttachment({ contentType: null, filename: 'anim.gif' }))).toBe(true);
    expect(isSupportedImage(makeAttachment({ contentType: null, filename: 'modern.webp' }))).toBe(true);
    expect(isSupportedImage(makeAttachment({ contentType: null, filename: 'data.csv' }))).toBe(false);
  });
});

describe('getImagesDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .discode/images/ directory under projectPath', () => {
    const dir = getImagesDir(tempDir);
    expect(dir).toBe(join(tempDir, '.discode', 'images'));
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent', () => {
    const dir1 = getImagesDir(tempDir);
    const dir2 = getImagesDir(tempDir);
    expect(dir1).toBe(dir2);
    expect(existsSync(dir1)).toBe(true);
  });
});

describe('buildImageMarkers', () => {
  it('returns empty string for no images', () => {
    expect(buildImageMarkers([])).toBe('');
  });

  it('returns marker for single image', () => {
    const result = buildImageMarkers([
      { localPath: '/tmp/test/img.png', originalName: 'img.png', contentType: 'image/png' },
    ]);
    expect(result).toBe('\n[image:/tmp/test/img.png]');
  });

  it('returns markers for multiple images', () => {
    const result = buildImageMarkers([
      { localPath: '/tmp/a.png', originalName: 'a.png', contentType: 'image/png' },
      { localPath: '/tmp/b.jpg', originalName: 'b.jpg', contentType: 'image/jpeg' },
    ]);
    expect(result).toBe('\n[image:/tmp/a.png]\n[image:/tmp/b.jpg]');
  });
});

describe('downloadImageAttachments', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `discode-dl-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns empty array when no image attachments', async () => {
    const result = await downloadImageAttachments(
      [makeAttachment({ contentType: 'text/plain', filename: 'readme.txt' })],
      tempDir,
    );
    expect(result).toEqual([]);
  });

  it('skips oversized images (>10MB)', async () => {
    const result = await downloadImageAttachments(
      [makeAttachment({ size: 11 * 1024 * 1024 })],
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

    const result = await downloadImageAttachments(
      [makeAttachment({ filename: 'screenshot.png', contentType: 'image/png', size: 1024 })],
      tempDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].originalName).toBe('screenshot.png');
    expect(result[0].contentType).toBe('image/png');
    expect(result[0].localPath).toContain('.discode/images/');
    expect(result[0].localPath).toContain('screenshot.png');
    expect(existsSync(result[0].localPath)).toBe(true);
  });

  it('handles fetch errors gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadImageAttachments(
      [makeAttachment({ size: 1024 })],
      tempDir,
    );

    expect(result).toEqual([]);
  });

  it('handles network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadImageAttachments(
      [makeAttachment({ size: 1024 })],
      tempDir,
    );

    expect(result).toEqual([]);
  });

  it('downloads multiple images', async () => {
    const fakeData = Buffer.from('data');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeData.buffer.slice(
        fakeData.byteOffset,
        fakeData.byteOffset + fakeData.byteLength
      )),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await downloadImageAttachments(
      [
        makeAttachment({ filename: 'a.png', contentType: 'image/png', size: 512 }),
        makeAttachment({ filename: 'b.jpg', contentType: 'image/jpeg', size: 512 }),
        makeAttachment({ filename: 'readme.txt', contentType: 'text/plain', size: 100 }),
      ],
      tempDir,
    );

    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
