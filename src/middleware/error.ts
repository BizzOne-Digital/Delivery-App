import type { NextFunction, Request, Response } from 'express';
import { Error as MongooseError } from 'mongoose';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { ApiError } from '../utils/ApiError';
import type { ApiErrorBody } from '../utils/response';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`, 'ROUTE_NOT_FOUND'));
}

interface MongoDuplicateKeyError {
  code: number;
  keyValue?: Record<string, unknown>;
}

function isDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * Centralised error handler. Unknown errors are logged in full server-side but
 * reported to clients as a generic message — no stack traces, no driver text,
 * no customer data in public error payloads.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again.';
  let details: unknown;

  if (error instanceof ApiError) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (error instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (error instanceof MongooseError.ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (error instanceof MongooseError.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid value for '${error.path}'`;
  } else if (error instanceof MongooseError.VersionError) {
    status = 409;
    code = 'STALE_DOCUMENT';
    message = 'This record changed while you were editing it. Refresh and try again.';
  } else if (error instanceof MulterError) {
    status = 400;
    code = `UPLOAD_${error.code}`;
    message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'The file is too large.'
        : 'The upload could not be processed.';
  } else if (isDuplicateKeyError(error)) {
    status = 409;
    code = 'DUPLICATE_KEY';
    const field = Object.keys(error.keyValue ?? {})[0] ?? 'value';
    message = `A record with that ${field} already exists.`;
  }

  if (status >= 500) {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } else if (!env.isTest) {
    logger.warn(`${status} ${code} on ${req.method} ${req.originalUrl}`, { message });
  }

  const body: ApiErrorBody = { success: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;

  res.status(status).json(body);
}
