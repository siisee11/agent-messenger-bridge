/**
 * Download Discord file attachments and save to project directory.
 *
 * Files are stored under `{projectPath}/.discode/files/` with a
 * timestamp-based filename so they can be referenced by agents via
 * the `[file:/path/to/file]` marker convention.
 */

import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, extname } from 'path';
import type { DiscordAttachment } from '../types/index.js';
import { SUPPORTED_FILE_TYPES } from '../types/index.js';

/** Maximum file size to download (25 MB — Discord's limit) */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

/** Maximum number of files to keep in the cache directory */
const MAX_CACHED_FILES = 100;

/**
 * Result of downloading a file attachment.
 */
export interface DownloadedFile {
  /** Absolute path where the file was saved */
  localPath: string;
  /** Original filename from Discord */
  originalName: string;
  /** MIME type */
  contentType: string;
}

/**
 * Return true if the attachment is a supported file type.
 */
export function isSupportedFile(attachment: DiscordAttachment): boolean {
  if (attachment.contentType) {
    return (SUPPORTED_FILE_TYPES as readonly string[]).includes(attachment.contentType);
  }
  // Fallback: check extension
  const ext = extname(attachment.filename).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.json', '.txt'].includes(ext);
}

/**
 * Get the files directory for a project, creating it if needed.
 */
export function getFilesDir(projectPath: string): string {
  const dir = join(projectPath, '.discode', 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Download file attachments from Discord and save them locally.
 *
 * Only supported file types under MAX_FILE_SIZE are downloaded.
 * Returns an array of successfully downloaded files.
 */
export async function downloadFileAttachments(
  attachments: DiscordAttachment[],
  projectPath: string,
): Promise<DownloadedFile[]> {
  const fileAttachments = attachments.filter(isSupportedFile);
  if (fileAttachments.length === 0) return [];

  const filesDir = getFilesDir(projectPath);
  const results: DownloadedFile[] = [];

  for (const attachment of fileAttachments) {
    if (attachment.size > MAX_FILE_SIZE) {
      console.warn(`Skipping oversized file: ${attachment.filename} (${(attachment.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.warn(`Failed to download file ${attachment.filename}: HTTP ${response.status}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Generate unique filename: timestamp-originalname
      const ext = extname(attachment.filename) || '.bin';
      const baseName = attachment.filename.replace(ext, '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const timestamp = Date.now();
      const filename = `${timestamp}-${baseName}${ext}`;
      const localPath = join(filesDir, filename);

      writeFileSync(localPath, buffer);

      results.push({
        localPath,
        originalName: attachment.filename,
        contentType: attachment.contentType || 'application/octet-stream',
      });

      console.log(`📎 Downloaded file: ${attachment.filename} -> ${localPath}`);
    } catch (error) {
      console.warn(`Failed to download file ${attachment.filename}:`, error);
    }
  }

  // Cleanup: prune old files if cache exceeds limit
  pruneFileCache(filesDir);

  return results;
}

/**
 * Build the text to append to the user's message with file markers.
 */
export function buildFileMarkers(files: DownloadedFile[]): string {
  if (files.length === 0) return '';

  const markers = files.map(
    (f) => `[file:${f.localPath}]`
  );

  return '\n' + markers.join('\n');
}

/**
 * Remove oldest files when the cache directory exceeds MAX_CACHED_FILES.
 */
function pruneFileCache(filesDir: string): void {
  try {
    const files = readdirSync(filesDir)
      .map((name) => {
        const fullPath = join(filesDir, name);
        try {
          const stat = statSync(fullPath);
          return { name, fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    if (files.length > MAX_CACHED_FILES) {
      const toRemove = files.slice(0, files.length - MAX_CACHED_FILES);
      for (const file of toRemove) {
        unlinkSync(file.fullPath);
        console.log(`🗑️ Pruned old file: ${file.name}`);
      }
    }
  } catch {
    // Non-critical: silently ignore cleanup errors
  }
}
