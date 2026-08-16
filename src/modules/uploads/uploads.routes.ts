import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireUser } from '../../middleware/auth';
import { denyReadOnlyWrites } from '../../middleware/rbac';
import { uploadLimiter } from '../../middleware/rateLimit';
import { assertRealImage, uploadImage } from '../../middleware/upload';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { getStorage, memoryStorage } from '../../services/storage/storage.adapter';
import { env } from '../../config/env';

const router = Router();

const ALLOWED_FOLDERS = ['proof-signature', 'proof-photo', 'failure-photo', 'return-photo', 'pharmacy-logo'];

/**
 * Uploads a single image and returns its URL + metadata.
 * The caller then references that URL when completing/failing an order —
 * image bytes never enter the order document.
 */
const uploadSingle = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const file = req.file;
  if (!file) throw ApiError.badRequest('No file was uploaded', 'NO_FILE');

  const folder = String((req.body as { folder?: string }).folder ?? 'proof-photo');
  if (!ALLOWED_FOLDERS.includes(folder)) {
    throw ApiError.badRequest(`Unknown upload folder. Allowed: ${ALLOWED_FOLDERS.join(', ')}`);
  }

  // Guards against a renamed executable claiming to be an image.
  assertRealImage(file.buffer, file.mimetype);

  const stored = await getStorage().save(
    { buffer: file.buffer, mimeType: file.mimetype, originalName: file.originalname },
    folder,
  );

  sendSuccess(
    res,
    {
      url: stored.url,
      key: stored.key,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      storedAt: stored.storedAt,
      driver: getStorage().name,
      uploadedBy: String(actor._id),
    },
    { status: 201, message: 'File uploaded' },
  );
});

/** Serves files held by the in-memory adapter (serverless demo mode). */
const serveMemoryFile = asyncHandler(async (req: Request, res: Response) => {
  if (env.uploads.driver !== 'memory') throw ApiError.notFound('Not found');
  const key = decodeURIComponent(String(req.params.key));
  const entry = memoryStorage.get(key);
  if (!entry) throw ApiError.notFound('File not found or no longer cached');

  res.setHeader('Content-Type', entry.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.status(200).send(entry.buffer);
});

router.post(
  '/',
  authenticate,
  denyReadOnlyWrites,
  uploadLimiter,
  uploadImage.single('file'),
  uploadSingle,
);
router.get('/memory/:key', authenticate, serveMemoryFile);

export default router;
