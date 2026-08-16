import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

export interface StoredFile {
  url: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  storedAt: Date;
}

export interface StorageAdapter {
  readonly name: string;
  save(file: { buffer: Buffer; mimeType: string; originalName?: string }, folder: string): Promise<StoredFile>;
  remove(key: string): Promise<void>;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function buildKey(folder: string, mimeType: string): string {
  const ext = EXTENSIONS[mimeType] ?? 'bin';
  const day = new Date().toISOString().slice(0, 10);
  return `${folder}/${day}/${crypto.randomUUID()}.${ext}`;
}

/**
 * Local disk adapter — development default.
 *
 * Files land in `backend/uploads/` and are served read-only from
 * `GET /uploads/*`. Swap for S3/Cloudinary in production (see below) because
 * serverless filesystems are ephemeral and not shared between instances.
 */
class LocalDiskStorage implements StorageAdapter {
  readonly name = 'local-disk';
  private readonly root = path.resolve(__dirname, '../../../uploads');

  async save(
    file: { buffer: Buffer; mimeType: string },
    folder: string,
  ): Promise<StoredFile> {
    const key = buildKey(folder, file.mimeType);
    const destination = path.join(this.root, key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.buffer);
    return {
      url: `${env.uploads.baseUrl}/uploads/${key}`,
      key,
      mimeType: file.mimeType,
      sizeBytes: file.buffer.byteLength,
      storedAt: new Date(),
    };
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.root, key));
    } catch {
      // Deleting a file that is already gone is not an error worth surfacing.
    }
  }
}

/**
 * In-memory adapter for serverless/read-only filesystems. Files survive only for
 * the lifetime of the running instance — acceptable for demos, NOT for
 * production proof-of-delivery retention.
 */
class MemoryStorage implements StorageAdapter {
  readonly name = 'memory';
  private readonly store = new Map<string, { buffer: Buffer; mimeType: string }>();

  async save(file: { buffer: Buffer; mimeType: string }, folder: string): Promise<StoredFile> {
    const key = buildKey(folder, file.mimeType);
    this.store.set(key, { buffer: file.buffer, mimeType: file.mimeType });
    return {
      url: `${env.uploads.baseUrl}/api/v1/uploads/memory/${encodeURIComponent(key)}`,
      key,
      mimeType: file.mimeType,
      sizeBytes: file.buffer.byteLength,
      storedAt: new Date(),
    };
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  get(key: string) {
    return this.store.get(key);
  }
}

export const memoryStorage = new MemoryStorage();

/*
 * ---------------------------------------------------------------------------
 * Replacing this adapter in production
 * ---------------------------------------------------------------------------
 * Implement the StorageAdapter interface and return it from `getStorage()`:
 *
 *   class S3Storage implements StorageAdapter {
 *     readonly name = 's3';
 *     async save(file, folder) {
 *       const key = `${folder}/${crypto.randomUUID()}.jpg`;
 *       await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: file.buffer,
 *                                            ContentType: file.mimeType }));
 *       return { url: `${CDN_BASE}/${key}`, key, mimeType: file.mimeType,
 *                sizeBytes: file.buffer.byteLength, storedAt: new Date() };
 *     }
 *     async remove(key) { await s3.send(new DeleteObjectCommand({ Bucket, Key: key })); }
 *   }
 *
 * Nothing else in the codebase changes: order documents only ever store the
 * returned `url` + metadata, never image bytes.
 */
export function getStorage(): StorageAdapter {
  if (env.uploads.driver === 'memory') return memoryStorage;
  return localDiskStorage;
}

const localDiskStorage = new LocalDiskStorage();

export async function ensureUploadRoot(): Promise<void> {
  if (env.uploads.driver !== 'local') return;
  try {
    await fs.mkdir(path.resolve(__dirname, '../../../uploads'), { recursive: true });
  } catch (error) {
    logger.warn('Could not create local upload directory; falling back at write time', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
