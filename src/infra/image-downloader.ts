/**
 * Download Discord image attachments and save to project directory.
 *
 * Images are stored under `{projectPath}/.discode/images/` with a
 * timestamp-based filename so they can be referenced by agents via
 * the `[image:/path/to/file]` marker convention.
 */

import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, extname } from 'path';
import type { DiscordAttachment } from '../types/index.js';
import { SUPPORTED_IMAGE_TYPES } from '../types/index.js';

/** Maximum file size to download (10 MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Maximum number of images to keep in the cache directory */
const MAX_CACHED_IMAGES = 50;

/**
 * Result of downloading an image attachment.
 */
export interface DownloadedImage {
  /** Absolute path where the image was saved */
  localPath: string;
  /** Original filename from Discord */
  originalName: string;
  /** MIME type */
  contentType: string;
}

/**
 * Return true if the attachment is a supported image type.
 */
export function isSupportedImage(attachment: DiscordAttachment): boolean {
  if (attachment.contentType) {
    return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(attachment.contentType);
  }
  // Fallback: check extension
  const ext = extname(attachment.filename).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
}

/**
 * Get the images directory for a project, creating it if needed.
 */
export function getImagesDir(projectPath: string): string {
  const dir = join(projectPath, '.discode', 'images');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Download image attachments from Discord and save them locally.
 *
 * Only supported image types under MAX_IMAGE_SIZE are downloaded.
 * Returns an array of successfully downloaded images.
 */
export async function downloadImageAttachments(
  attachments: DiscordAttachment[],
  projectPath: string,
): Promise<DownloadedImage[]> {
  const imageAttachments = attachments.filter(isSupportedImage);
  if (imageAttachments.length === 0) return [];

  const imagesDir = getImagesDir(projectPath);
  const results: DownloadedImage[] = [];

  for (const attachment of imageAttachments) {
    if (attachment.size > MAX_IMAGE_SIZE) {
      console.warn(`Skipping oversized image: ${attachment.filename} (${(attachment.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.warn(`Failed to download image ${attachment.filename}: HTTP ${response.status}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Generate unique filename: timestamp-originalname
      const ext = extname(attachment.filename) || '.png';
      const baseName = attachment.filename.replace(ext, '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const timestamp = Date.now();
      const filename = `${timestamp}-${baseName}${ext}`;
      const localPath = join(imagesDir, filename);

      writeFileSync(localPath, buffer);

      results.push({
        localPath,
        originalName: attachment.filename,
        contentType: attachment.contentType || 'image/png',
      });

      console.log(`📸 Downloaded image: ${attachment.filename} -> ${localPath}`);
    } catch (error) {
      console.warn(`Failed to download image ${attachment.filename}:`, error);
    }
  }

  // Cleanup: prune old images if cache exceeds limit
  pruneImageCache(imagesDir);

  return results;
}

/**
 * Build the text to append to the user's message with image markers.
 */
export function buildImageMarkers(images: DownloadedImage[]): string {
  if (images.length === 0) return '';

  const markers = images.map(
    (img) => `[image:${img.localPath}]`
  );

  return '\n' + markers.join('\n');
}

/**
 * Remove oldest images when the cache directory exceeds MAX_CACHED_IMAGES.
 */
function pruneImageCache(imagesDir: string): void {
  try {
    const files = readdirSync(imagesDir)
      .map((name) => {
        const fullPath = join(imagesDir, name);
        try {
          const stat = statSync(fullPath);
          return { name, fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    if (files.length > MAX_CACHED_IMAGES) {
      const toRemove = files.slice(0, files.length - MAX_CACHED_IMAGES);
      for (const file of toRemove) {
        unlinkSync(file.fullPath);
        console.log(`🗑️ Pruned old image: ${file.name}`);
      }
    }
  } catch {
    // Non-critical: silently ignore cleanup errors
  }
}
