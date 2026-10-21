export type ErrorCode = 'not_found' | 'forbidden' | 'validation' | 'conflict' | 'guard_failed' | 'unauthorized' | 'internal';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export const notFound = (message = 'not found', details?: unknown) => new ApiError(404, 'not_found', message, details);
export const forbidden = (message = 'forbidden', details?: unknown) => new ApiError(403, 'forbidden', message, details);
export const unauthorized = (message = 'unauthorized') => new ApiError(401, 'unauthorized', message);
export const validation = (message: string, details?: unknown) => new ApiError(400, 'validation', message, details);
export const conflict = (message: string, details?: unknown) => new ApiError(409, 'conflict', message, details);
export const guardFailed = (failures: unknown, message = 'transition guards failed') =>
  new ApiError(409, 'guard_failed', message, { failures });
export const internal = (message = 'internal error') => new ApiError(500, 'internal', message);

/** Map any thrown value to an ApiError (zod, permission errors, postgres constraint errors). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as any;
  if (e && typeof e === 'object') {
    if (e.name === 'ZodError' && Array.isArray(e.issues)) {
      return validation('invalid request', e.issues.map((i: any) => ({ path: i.path.join('.'), message: i.message })));
    }
    if (e.name === 'PermissionError' || e.status === 403) return forbidden(e.message ?? 'forbidden');
    if (e.name === 'FieldValidationError') return validation(e.message, e.details);
    // postgres errors
    if (typeof e.code === 'string') {
      if (e.code === '23514') return conflict(e.message); // check / trigger violations (cycles, field checks)
      if (e.code === '23505') return conflict('already exists: ' + (e.detail ?? e.message));
      if (e.code === '23503') return validation('invalid reference: ' + (e.detail ?? e.message));
      if (e.code === '22P02') return validation('invalid input: ' + e.message);
      if (e.code === '22007' || e.code === '22008') return validation('invalid date: ' + e.message);
    }
    if (e.validation && e.statusCode === 400) return validation(e.message);
    if (typeof e.statusCode === 'number' && e.statusCode < 500) {
      const code: ErrorCode = e.statusCode === 404 ? 'not_found' : e.statusCode === 401 ? 'unauthorized' : e.statusCode === 403 ? 'forbidden' : 'validation';
      return new ApiError(e.statusCode, code, e.message ?? 'bad request');
    }
  }
  return internal(e?.message ?? 'internal error');
}
