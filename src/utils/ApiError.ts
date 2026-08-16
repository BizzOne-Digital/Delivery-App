/**
 * Operational error with an HTTP status. Anything thrown that is NOT an ApiError
 * is treated as unexpected and reported to clients as a generic 500 so internal
 * details (stack traces, driver messages, customer data) never leak.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isOperational = true;

  constructor(statusCode: number, message: string, code = 'ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST', details?: unknown) {
    return new ApiError(400, message, code, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }
  static forbidden(message = 'You do not have access to this resource', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }
  static conflict(message = 'Conflict', code = 'CONFLICT', details?: unknown) {
    return new ApiError(409, message, code, details);
  }
  static unprocessable(message = 'Unprocessable request', code = 'UNPROCESSABLE', details?: unknown) {
    return new ApiError(422, message, code, details);
  }
  static tooMany(message = 'Too many requests', code = 'RATE_LIMITED') {
    return new ApiError(429, message, code);
  }
  static internal(message = 'Something went wrong', code = 'INTERNAL_ERROR') {
    return new ApiError(500, message, code);
  }
}
