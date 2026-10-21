// ============================================================================
// Helpers shared by the SQL compiler (query/compile.ts) and the client-side
// evaluator (query/evaluate.ts). Browser-safe: only Intl + Date.
//
// Both executors must agree on: how a FieldRef resolves to a storage kind,
// how macros resolve, how date/datetime values are coerced before being
// compared, and what `within_days` means. Keeping that logic here is what
// makes the parity test (query/parity.test.ts) hold.
// ============================================================================
import type { FieldRef, QueryContext } from './spec.js';
import { BUILTIN_FIELDS } from './spec.js';
import type { FieldDef } from '../schema/entities.js';

/** Storage kind of a value a filter/sort can target. */
export type ValueKind = 'text' | 'number' | 'bool' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array' | 'fts';

export type ResolvedField =
  | { kind: 'builtin'; name: string; valueKind: ValueKind; sortable: boolean }
  | { kind: 'json'; key: string; valueKind: ValueKind; def: FieldDef | null };

const JSON_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Map an item-type FieldDef to the kind its values are compared as. */
export function fieldDefValueKind(def: FieldDef): ValueKind {
  if (def.multi || def.kind === 'multi_select') return 'array';
  switch (def.kind) {
    case 'number': return 'number';
    case 'bool': return 'bool';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    default: return 'text'; // text, long_text, select, user, url
  }
}

/** Find the FieldDef for a JSONB key in a set of type defs (first match wins). */
export function findFieldDef(key: string, defsByType?: Record<string, FieldDef[]> | FieldDef[][] | null): FieldDef | null {
  if (!defsByType) return null;
  const lists = Array.isArray(defsByType) ? defsByType : Object.values(defsByType);
  for (const defs of lists) {
    const d = defs?.find((x) => x.key === key);
    if (d) return d;
  }
  return null;
}

/**
 * Resolve a FieldRef against the allowlist. Throws on anything unknown, so a
 * field name can never reach SQL unvalidated.
 */
export function resolveField(field: FieldRef, defs?: Record<string, FieldDef[]> | FieldDef[][] | null): ResolvedField {
  if (typeof field !== 'string') throw new Error(`invalid field reference: ${String(field)}`);
  if (field.startsWith('fields.')) {
    const key = field.slice('fields.'.length);
    if (!JSON_KEY_RE.test(key)) throw new Error(`invalid custom field key: ${key}`);
    const def = findFieldDef(key, defs);
    return { kind: 'json', key, valueKind: def ? fieldDefValueKind(def) : 'text', def };
  }
  const b = Object.prototype.hasOwnProperty.call(BUILTIN_FIELDS, field) ? BUILTIN_FIELDS[field] : undefined;
  if (!b) throw new Error(`unknown field: ${field}`);
  return { kind: 'builtin', name: field, valueKind: b.kind, sortable: b.sortable };
}

export function isTemporalKind(k: ValueKind): k is 'date' | 'datetime' {
  return k === 'date' || k === 'datetime';
}

// ---------------------------------------------------------------------------
// Dates / time zones (no node: imports)
// ---------------------------------------------------------------------------
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at the given instant (positive east of UTC). */
export function tzOffsetMs(date: Date, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of dtfFor(tz).formatToParts(date)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const hour = parts.hour === 24 ? 0 : (parts.hour ?? 0);
  const asUtc = Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, hour, parts.minute ?? 0, parts.second ?? 0);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function dateInTz(date: Date, tz = 'UTC'): string {
  return new Date(date.getTime() + tzOffsetMs(date, tz)).toISOString().slice(0, 10);
}

/** ISO instant of local midnight at the start of `ymd` in `tz`. */
export function startOfDayInTz(ymd: string, tz = 'UTC'): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  let guess = utc - tzOffsetMs(new Date(utc), tz);
  const off2 = tzOffsetMs(new Date(guess), tz);
  if (utc - off2 !== guess) guess = utc - off2;
  return new Date(guess).toISOString();
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO weekday index with Monday = 0 … Sunday = 6. */
export function isoWeekday(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function ctxNow(ctx: QueryContext): Date { return ctx.now ?? new Date(); }
export function ctxTz(ctx: QueryContext): string { return ctx.tz || 'UTC'; }

/**
 * Resolve a value macro ($me, $today, $now, $start_of_week, $end_of_week,
 * $start_of_month). Arrays are resolved element-wise; anything else passes
 * through unchanged. Weeks start on Monday.
 */
export function resolveValueMacro(value: unknown, ctx: QueryContext): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveValueMacro(v, ctx));
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  const now = ctxNow(ctx);
  const tz = ctxTz(ctx);
  switch (value) {
    case '$me': return ctx.userId;
    case '$now': return now.toISOString();
    case '$today': return dateInTz(now, tz);
    case '$start_of_week': { const t = dateInTz(now, tz); return addDays(t, -isoWeekday(t)); }
    case '$end_of_week': { const t = dateInTz(now, tz); return addDays(t, 6 - isoWeekday(t)); }
    case '$start_of_month': return `${dateInTz(now, tz).slice(0, 8)}01`;
    default: return value;
  }
}

/**
 * Coerce a comparison value to the representation used for a temporal kind:
 *   date     -> 'YYYY-MM-DD' (instants are converted to the calendar date in ctx.tz)
 *   datetime -> ISO instant   (date-only strings become local midnight in ctx.tz)
 */
export function coerceTemporal(kind: 'date' | 'datetime', v: unknown, ctx: QueryContext): string | null {
  if (v === null || v === undefined) return null;
  const tz = ctxTz(ctx);
  if (v instanceof Date) return kind === 'date' ? dateInTz(v, tz) : v.toISOString();
  const s = String(v);
  if (kind === 'date') {
    if (DATE_ONLY_RE.test(s)) return s;
    const t = Date.parse(s);
    return Number.isNaN(t) ? s : dateInTz(new Date(t), tz);
  }
  if (DATE_ONLY_RE.test(s)) return startOfDayInTz(s, tz);
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

/**
 * Bounds for `within_days`: n >= 0 → [today, today + n]; n < 0 → [today + n, today].
 * For date kinds both bounds are inclusive calendar dates. For datetime kinds
 * `start` is inclusive and `end` is EXCLUSIVE (midnight after the last day).
 */
export function withinDaysBounds(kind: 'date' | 'datetime', n: number, ctx: QueryContext): { start: string; end: string } {
  const tz = ctxTz(ctx);
  const today = dateInTz(ctxNow(ctx), tz);
  const days = Number.isFinite(n) ? Math.trunc(n) : 0;
  const a = days >= 0 ? today : addDays(today, days);
  const b = days >= 0 ? addDays(today, days) : today;
  if (kind === 'date') return { start: a, end: b };
  return { start: startOfDayInTz(a, tz), end: startOfDayInTz(addDays(b, 1), tz) };
}

export type TimeBucket = 'day' | 'week' | 'month';

/**
 * Calendar bucket of a date ('YYYY-MM-DD') or ISO timestamp, computed on the UTC
 * calendar date (the first 10 characters) exactly like the SQL compiler's
 * time_bucket: day → the date, week → its Monday, month → its first day.
 * Returns null for null/undefined or non-date input.
 */
export function timeBucket(value: unknown, bucket: TimeBucket): string | null {
  if (value === null || value === undefined) return null;
  const day = (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
  if (!DATE_ONLY_RE.test(day)) return null;
  switch (bucket) {
    case 'day': return day;
    case 'month': return `${day.slice(0, 7)}-01`;
    case 'week': return addDays(day, -isoWeekday(day));
  }
}

/** Escape a value for use inside a LIKE pattern (backslash escape; emit `escape '\'`). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Coerce a scalar filter value to the given kind (numbers, booleans, temporal). */
export function coerceScalar(kind: ValueKind, v: unknown, ctx: QueryContext): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'number': { const n = typeof v === 'number' ? v : Number(v); return Number.isNaN(n) ? v : n; }
    case 'bool': return v === true || v === 'true' || v === 1 || v === '1';
    case 'date': case 'datetime': return coerceTemporal(kind, v, ctx);
    default: return v instanceof Date ? v.toISOString() : v;
  }
}

export function toArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
