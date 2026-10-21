import { sqliteErrorKind } from './db.js';

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

/** True for errors raised by node:sqlite (constraint violations, trigger RAISEs, busy). */
export function isSqliteError(e: unknown): boolean {
  const x = e as { code?: unknown; errcode?: unknown } | null;
  return !!x && typeof x === 'object' && (x.code === 'ERR_SQLITE_ERROR' || typeof x.errcode === 'number');
}

/**
 * Map a SQLite error to the API envelope:
 *   unique index          → 409 conflict
 *   trigger RAISE         → 409 conflict for cycle / "already exists" messages, else 400 validation with the RAISE text
 *   check / not null      → 400 validation
 *   foreign key           → 400 validation (invalid reference)
 *   busy / locked         → 503 (transient)
 */
export function sqliteToApiError(e: unknown): ApiError | null {
  if (!isSqliteError(e)) return null;
  const message = String((e as Error).message ?? 'database error');
  switch (sqliteErrorKind(e)) {
    case 'unique': return conflict('already exists: ' + message);
    case 'trigger': return /cycle|already exists/i.test(message) ? conflict(message) : validation(message);
    case 'check': case 'not_null': return validation(message);
    case 'foreign_key': return validation('invalid reference: ' + message);
    case 'busy': return new ApiError(503, 'internal', 'database is busy, please retry');
    default: return null;
  }
}

/** Map any thrown value to an ApiError (zod, permission errors, SQLite constraint/trigger errors). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as any;
  if (e && typeof e === 'object') {
    if (e.name === 'ZodError' && Array.isArray(e.issues)) {
      return validation('invalid request', e.issues.map((i: any) => ({ path: i.path.join('.'), message: i.message })));
    }
    if (e.name === 'PermissionError' || e.status === 403) return forbidden(e.message ?? 'forbidden');
    if (e.name === 'FieldValidationError') return validation(e.message, e.details);
    const db = sqliteToApiError(e);
    if (db) return db;
    if (e.validation && e.statusCode === 400) return validation(e.message);
    if (typeof e.statusCode === 'number' && e.statusCode < 500) {
      const code: ErrorCode = e.statusCode === 404 ? 'not_found' : e.statusCode === 401 ? 'unauthorized' : e.statusCode === 403 ? 'forbidden' : 'validation';
      return new ApiError(e.statusCode, code, e.message ?? 'bad request');
    }
  }
  return internal(e?.message ?? 'internal error');
}
