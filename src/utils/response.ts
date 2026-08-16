import type { Response } from 'express';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
  message?: string;
  /** Pagination info, aggregate totals, capability flags — anything non-payload. */
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/** Every successful response in the API has this exact shape. */
export function sendSuccess<T>(
  res: Response,
  data: T,
  options: { status?: number; message?: string; meta?: object } = {},
): Response {
  const body: ApiSuccessBody<T> = { success: true, data };
  if (options.message) body.message = options.message;
  if (options.meta) body.meta = options.meta as Record<string, unknown>;
  return res.status(options.status ?? 200).json(body);
}

export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return { page, limit, total, totalPages, hasNextPage: page < totalPages };
}
