// ============================================================================
// The API's single import point for the database layer (@pm/db on node:sqlite).
//
//   const rows = await q`select * from work_items where id = ${id}`;   // hydrated rows
//   await sql.begin(async (tx) => { ... });                           // BEGIN IMMEDIATE (serialised writer)
//   `where id in ${q(ids)}`                                           // IN list
//   `set ${setOf(q, updates)}`                                        // dynamic UPDATE ... SET
//
// Conventions the rest of the API relies on:
//   * booleans are 0/1 in SQL (JS booleans passed as params are converted; `is_*`,
//     `confidential`, `muted`, `resync_required` come back as booleans)
//   * JSON columns (fields, settings, spec, payload, scopes, event_kinds, label_ids, ...)
//     are text in SQL and parsed on the way out; objects/arrays passed as params are
//     serialised; use `q.json(v)` to force JSON for scalars (activity old/new values)
//   * timestamps are ISO-8601 text; compare as text and pass `nowIso()` instead of now()
//   * `insert ... returning *` runs BEFORE the AFTER INSERT triggers (number/key/version
//     are not filled in yet) — re-read the row when you need them
//   * never hold `sql.begin()` across network I/O: the transaction mutex blocks every
//     other request while it is open
// ============================================================================
import { openDb, isUuid, nowIso, sqliteErrorKind, type Sql as DbSql, type Row as DbRow, type Fragment } from '@pm/db/sqlite';
import { ftsQuery } from '@pm/core';

export type Sql = DbSql;
/** Transaction handle (same interface; statements issued inside `begin()` run in the transaction). */
export type Tx = Sql;
/** Any query runner (the shared connection or an open transaction). */
export type Q = Sql;
export type Row = DbRow;
export type { Fragment };
export { isUuid, nowIso, sqliteErrorKind };

/** Open the SQLite database at `url` (a path, `sqlite:path`, `file:path` or `:memory:`). */
export function createDb(url: string): Sql {
  return openDb(url);
}

/** Run `fn` in a write transaction (BEGIN IMMEDIATE). Writers are serialised, so `version` order == commit order. */
export async function withTxn<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(fn);
}

/** Current global sync version (sync_state.version). */
export async function currentVersion(q: Q): Promise<number> {
  return q.currentVersion();
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** `col = ?, col2 = ?` fragment for dynamic updates; keys are validated identifiers, values are bound. */
export function setOf(q: Q, updates: Record<string, unknown>): Fragment {
  const keys = Object.keys(updates);
  if (!keys.length) throw new Error('setOf: nothing to update');
  for (const k of keys) if (!IDENT_RE.test(k)) throw new Error(`setOf: invalid column "${k}"`);
  return q.unsafe(keys.map((k) => `${k} = ?`).join(', '), keys.map((k) => updates[k])).fragment;
}

/** Empty fragment, for optional clauses: `${cond ? q\`and x = ${v}\` : nothing(q)}`. */
export const nothing = (q: Q): Fragment => q.raw('');

/** ISO timestamp `ms` milliseconds from now (positive or negative). */
export const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** `YYYY-MM-DD` (UTC) `days` days from today. */
export const dateIn = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Escape `%`, `_` and `\` for a LIKE pattern used with `escape '\'`. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * Safe FTS5 MATCH string from free text (same builder as the QuerySpec `search` op in @pm/core:
 * every whitespace-separated token becomes a quoted phrase, so user punctuation cannot break the
 * query). null when there is no token.
 */
export function ftsMatch(text: string): string | null {
  return ftsQuery(text) || null;
}
