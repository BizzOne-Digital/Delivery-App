import multer from 'multer';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Uploads are buffered in memory and handed to the storage adapter, so the same
 * code path works on disk-backed and serverless deployments.
 *
 * Validation: MIME allow-list + hard size cap + single-file-per-field.
 * Filenames from the client are discarded entirely — the adapter generates a
 * random key, which removes path-traversal and overwrite risks.
 */
export const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.uploads.maxFileSizeBytes,
    files: 4,
    fields: 20,
  },
  fileFilter: (_req, file, cb) => {
    if (!(env.uploads.allowedMimeTypes as readonly string[]).includes(file.mimetype)) {
      cb(
        ApiError.badRequest(
          `Unsupported file type. Allowed: ${env.uploads.allowedMimeTypes.join(', ')}`,
          'UPLOAD_TYPE_NOT_ALLOWED',
        ),
      );
      return;
    }
    cb(null, true);
  },
});

/** PNG magic bytes / JPEG SOI / WEBP RIFF — guards against a spoofed MIME header. */
export function assertRealImage(buffer: Buffer, mimeType: string): void {
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp =
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';

  const matches =
    (mimeType === 'image/png' && isPng) ||
    (mimeType === 'image/jpeg' && isJpeg) ||
    (mimeType === 'image/webp' && isWebp);

  if (!matches) {
    throw ApiError.badRequest('The uploaded file is not a valid image', 'UPLOAD_CONTENT_INVALID');
  }
}
