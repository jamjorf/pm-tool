// ============================================================================
// @pm/db runtime: the one database layer every package uses.
//
//   import { openDb, type Sql, type Q } from '@pm/db';
//   const sql = openDb('./data/pmtool.db');
//   const rows = await sql`select * from work_items where project_id = ${pid}`;
//   await sql.begin(async (tx) => { await tx`update ...`; await tx`insert ...`; });
//
// Built on Node's bundled SQLite (`node:sqlite`, Node 22.13+): no native
// modules, no server, no sudo. The API is deliberately close to the postgres.js
// tagged-template style so call sites read the same:
//   * sql`...${value}...`  → parameterised query (never string-concatenated)
//   * ${sql(array)}        → an IN list:  `where id in ${sql(ids)}`
//   * ${sql.raw(text)}     → verbatim SQL (identifiers, ORDER BY fragments)
//   * nested sql`` / sql.unsafe(...) fragments are spliced with their params
//   * objects/arrays become JSON text, booleans become 0/1, undefined → null
//   * result rows are hydrated: JSON columns parsed, boolean columns → true/false
//
// Concurrency: node:sqlite is synchronous. A single connection is shared and
// an async mutex serialises transactions; a transaction opened with
// `sql.begin` runs `BEGIN IMMEDIATE`, which also serialises writers across
// processes. Statements issued while a transaction is open in the same async
// context (AsyncLocalStorage) run inside it, so passing `sql` or `tx` around
// both work and nothing can deadlock on itself.
// ============================================================================
import type { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Row = Record<string, any>;

/**
 * Load `node:sqlite` lazily through process.getBuiltinModule so that (a) the
 * one-time "SQLite is an experimental feature" warning is silenced and (b)
 * bundlers/test runners that cannot resolve the `node:sqlite` specifier
 * (vite-node 2.x) still work, since there is no static import to rewrite.
 */
type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | undefined;
function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const orig = process.emitWarning;
  (process as any).emitWarning = (warning: unknown, ...rest: unknown[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as any)?.type;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning))) return;
    return (orig as any).call(process, warning, ...rest);
  };
  try {
    const getBuiltin = (process as any).getBuiltinModule as ((id: string) => unknown) | undefined;
    sqliteModule = (getBuiltin ? getBuiltin('node:sqlite') : undefined) as SqliteModule | undefined;
    if (!sqliteModule) throw new Error('node:sqlite is not available; pm-tool needs Node.js 22.13 or newer');
  } finally {
    process.emitWarning = orig;
  }
  return sqliteModule;
}

// ---------------------------------------------------------------------------
// Fragments & params
// ---------------------------------------------------------------------------
const FRAG = Symbol('pm.sql.fragment');
export interface Fragment { [FRAG]: true; text: string; params: unknown[] }
export const isFragment = (v: unknown): v is Fragment => !!v && typeof v === 'object' && (v as any)[FRAG] === true;
export const fragment = (text: string, params: unknown[] = []): Fragment => ({ [FRAG]: true, text, params });

const JSON_PARAM = Symbol('pm.sql.json');
interface JsonParam { [JSON_PARAM]: true; value: unknown }

/** Convert a JS value into something SQLite accepts. */
export function toParam(v: unknown): string | number | bigint | null | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object' && (v as any)[JSON_PARAM]) return JSON.stringify((v as JsonParam).value ?? null);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Row hydration (SQLite has no JSON/boolean column types)
// ---------------------------------------------------------------------------
export const JSON_COLUMNS = new Set([
  'settings', 'field_defs', 'guards', 'effects', 'fields', 'allowed_type_ids', 'spec', 'rules', 'quiet_hours',
  'external_ref', 'meta', 'old_value', 'new_value', 'payload', 'config', 'scopes', 'event_kinds',
  'notification_ids', 'label_names', 'label_ids', 'children_categories', 'ids', 'data', 'changes', 'failures',
]);
export const BOOLEAN_COLUMNS = new Set([
  'confidential', 'muted', 'resync_required', 'allowed', 'ok', 'read', 'touched', 'has_parent',
]);
/** Extend hydration for query aliases your code introduces (e.g. `as foo_json`). */
export function registerJsonColumns(...names: string[]) { for (const n of names) JSON_COLUMNS.add(n); }
export function registerBooleanColumns(...names: string[]) { for (const n of names) BOOLEAN_COLUMNS.add(n); }

export function hydrateRow<T extends Row = Row>(raw: Row | undefined): T | undefined {
  if (!raw) return undefined;
  const out: Row = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (typeof v === 'string' && (JSON_COLUMNS.has(k) || k.endsWith('_json'))) {
      try { out[k.endsWith('_json') ? k.slice(0, -5) : k] = JSON.parse(v); continue; } catch { /* keep text */ }
    }
    if ((typeof v === 'number') && (BOOLEAN_COLUMNS.has(k) || k.startsWith('is_')) && (v === 0 || v === 1)) { out[k] = v === 1; continue; }
    if (typeof v === 'bigint') { out[k] = Number(v); continue; }
    out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Query objects (thenable + sync accessors)
// ---------------------------------------------------------------------------
export interface RunResult { changes: number; lastInsertRowid: number }
export interface Query<T extends Row = Row> extends PromiseLike<T[]> {
  readonly text: string;
  readonly params: unknown[];
  /** Execute synchronously and return all rows (hydrated). */
  all(): T[];
  /** Execute synchronously and return the first row or undefined. */
  get(): T | undefined;
  /** Execute synchronously for statements without a result set. */
  run(): RunResult;
  /** Use as a fragment inside another query. */
  readonly fragment: Fragment;
}

interface Ctx { depth: number }
const als = new AsyncLocalStorage<Ctx>();

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    return prev.then(() => release);
  }
}

// ---------------------------------------------------------------------------
// The Sql interface
// ---------------------------------------------------------------------------
export interface Sql {
  <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): Query<T>;
  /** `${sql(list)}` → `(?, ?, ?)`; an empty list yields `(null)` so `in ()` never happens. */
  (list: readonly unknown[]): Fragment;
  /** Raw, parameterised SQL text. */
  unsafe<T extends Row = Row>(text: string, params?: unknown[]): Query<T>;
  /** Verbatim SQL (identifiers, keywords). Never pass user input. */
  raw(text: string): Fragment;
  /** Force JSON serialisation of a value (objects/arrays already are). */
  json(value: unknown): JsonParam;
  /** Run `fn` inside BEGIN IMMEDIATE (serialised writer). Nested calls become savepoints. */
  begin<T>(fn: (tx: Sql) => T | Promise<T>): Promise<T>;
  /** Run `fn` inside a deferred read transaction (consistent snapshot under WAL). */
  snapshot<T>(fn: (tx: Sql) => T | Promise<T>): Promise<T>;
  /** Explicit savepoint inside a transaction. */
  savepoint<T>(fn: (tx: Sql) => T | Promise<T>): Promise<T>;
  /** Execute multiple statements (migrations). */
  exec(text: string): void;
  /** Bump and return the global sync version (sync_state). Use inside a transaction. */
  nextVersion(): number;
  currentVersion(): number;
  /** True while this async context is inside begin()/snapshot(). */
  readonly inTransaction: boolean;
  readonly path: string;
  readonly db: DatabaseSync;
  close(): void;
}
/** Alias kept for call sites that distinguish pool vs transaction handles. */
export type Tx = Sql;
export type Q = Sql;

// ---------------------------------------------------------------------------
// Opening a database
// ---------------------------------------------------------------------------
export interface OpenOptions {
  /** Apply `PRAGMA journal_mode = WAL` (default true for file databases). */
  wal?: boolean;
  /** Milliseconds to wait on a locked database (default 5000). */
  busyTimeout?: number;
  /** Create parent directories (default true). */
  mkdir?: boolean;
}

export const DEFAULT_DB_PATH = './data/pmtool.db';

/** Repo root = nearest ancestor with pnpm-workspace.yaml, else cwd. */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/** Resolve DATABASE_URL / a path: `:memory:`, `sqlite:...`, `file:...`, absolute, or relative to the repo root. */
export function resolveDbPath(url: string | undefined = process.env.DATABASE_URL): string {
  let p = (url && url.trim()) || DEFAULT_DB_PATH;
  if (p === ':memory:' || p === 'sqlite::memory:' || p === 'file::memory:') return ':memory:';
  p = p.replace(/^sqlite:\/\/\/?/, '').replace(/^sqlite:/, '').replace(/^file:\/\/\/?/, '').replace(/^file:/, '');
  if (isAbsolute(p)) return p;
  if (process.env.PM_ROOT) return resolve(process.env.PM_ROOT, p);
  return resolve(findRepoRoot(), p);
}

export function openDb(pathOrUrl?: string, opts: OpenOptions = {}): Sql {
  const path = resolveDbPath(pathOrUrl);
  if (path !== ':memory:' && (opts.mkdir ?? true)) mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  db.exec(`pragma busy_timeout = ${Math.max(0, opts.busyTimeout ?? 5000)}`);
  if (path !== ':memory:' && (opts.wal ?? true)) db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma synchronous = NORMAL');
  // Helpers so SQL written for Postgres keeps working where it is harmless.
  db.function('now', { deterministic: false }, () => new Date().toISOString());
  db.function('gen_random_uuid', { deterministic: false }, () => randomUUID());
  db.function('uuid', { deterministic: false }, () => randomUUID());
  db.function('today', { deterministic: false }, () => new Date().toISOString().slice(0, 10));
  return makeSql(db, path, new Mutex());
}

function makeSql(db: DatabaseSync, path: string, mutex: Mutex): Sql {
  function compile(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
    let text = '';
    const params: unknown[] = [];
    strings.forEach((s, i) => {
      text += s;
      if (i >= values.length) return;
      const v = values[i];
      if (isFragment(v)) { text += v.text; params.push(...v.params); }
      else if (v && typeof v === 'object' && 'fragment' in (v as any) && isFragment((v as any).fragment)) { const f = (v as Query).fragment; text += f.text; params.push(...f.params); }
      else { text += '?'; params.push(v); }
    });
    return { text, params };
  }

  function execute(text: string, params: unknown[], mode: 'all' | 'get' | 'run'): any {
    const stmt = db.prepare(text);
    const bound = params.map(toParam) as any[];
    if (mode === 'run') { const r = stmt.run(...bound); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
    const rows = stmt.all(...bound) as Row[];
    if (mode === 'get') return hydrateRow(rows[0]);
    return rows.map((r) => hydrateRow(r)!);
  }

  const makeQuery = <T extends Row>(text: string, params: unknown[]): Query<T> => {
    const q: Query<T> = {
      text, params,
      all: () => execute(text, params, 'all'),
      get: () => execute(text, params, 'get'),
      run: () => execute(text, params, 'run'),
      get fragment() { return fragment(text, params); },
      then(onFulfilled, onRejected) {
        const p = (async () => {
          if (als.getStore()) return execute(text, params, 'all') as T[];
          const release = await mutex.acquire();
          try { return execute(text, params, 'all') as T[]; } finally { release(); }
        })();
        return p.then(onFulfilled, onRejected);
      },
    };
    return q;
  };

  async function transaction<T>(kind: 'IMMEDIATE' | 'DEFERRED', fn: (tx: Sql) => T | Promise<T>): Promise<T> {
    const store = als.getStore();
    if (store) return savepoint(fn); // nested → savepoint
    const release = await mutex.acquire();
    try {
      db.exec(`BEGIN ${kind}`);
      try {
        const result = await als.run({ depth: 0 }, () => fn(sql));
        db.exec('COMMIT');
        return result;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    } finally {
      release();
    }
  }

  async function savepoint<T>(fn: (tx: Sql) => T | Promise<T>): Promise<T> {
    const store = als.getStore();
    if (!store) return transaction('IMMEDIATE', fn);
    const name = `sp_${++store.depth}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn(sql);
      db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ${name}`); db.exec(`RELEASE SAVEPOINT ${name}`); } catch { /* ignore */ }
      throw e;
    } finally {
      store.depth--;
    }
  }

  const sql = ((first: any, ...values: unknown[]) => {
    if (Array.isArray(first) && 'raw' in first) { const { text, params } = compile(first as TemplateStringsArray, values); return makeQuery(text, params); }
    if (Array.isArray(first)) { return first.length ? fragment(`(${first.map(() => '?').join(', ')})`, [...first]) : fragment('(null)'); }
    throw new TypeError('sql must be used as a tagged template or called with an array');
  }) as Sql;

  Object.defineProperties(sql, {
    inTransaction: { get: () => !!als.getStore() },
    path: { value: path },
    db: { value: db },
  });
  sql.unsafe = (text, params = []) => makeQuery(text, params);
  sql.raw = (text) => fragment(text);
  sql.json = (value) => ({ [JSON_PARAM]: true, value });
  sql.begin = (fn) => transaction('IMMEDIATE', fn);
  sql.snapshot = (fn) => transaction('DEFERRED', fn);
  sql.savepoint = (fn) => savepoint(fn);
  sql.exec = (text) => db.exec(text);
  sql.nextVersion = () => Number((db.prepare('update sync_state set version = version + 1 where id = 1 returning version').get() as any).version);
  sql.currentVersion = () => Number((db.prepare('select version from sync_state where id = 1').get() as any)?.version ?? 0);
  sql.close = () => db.close();
  return sql;
}

// ---------------------------------------------------------------------------
// Error classification (node:sqlite exposes errcode = SQLite extended code)
// ---------------------------------------------------------------------------
export type SqliteErrorKind = 'unique' | 'check' | 'foreign_key' | 'not_null' | 'trigger' | 'busy' | 'other';
export function sqliteErrorKind(e: unknown): SqliteErrorKind {
  const code = Number((e as any)?.errcode ?? (e as any)?.cause?.errcode ?? NaN);
  const msg = String((e as any)?.message ?? '');
  if (code === 2067 || /UNIQUE constraint failed/i.test(msg)) return 'unique';
  if (code === 275 || /CHECK constraint failed/i.test(msg)) return 'check';
  if (code === 787 || /FOREIGN KEY constraint failed/i.test(msg)) return 'foreign_key';
  if (code === 1299 || /NOT NULL constraint failed/i.test(msg)) return 'not_null';
  if (code === 1811 || (code === 19 && !/constraint failed/i.test(msg))) return 'trigger'; // RAISE(ABORT, ...)
  if (code === 5 || code === 6 || /database is locked/i.test(msg)) return 'busy';
  return 'other';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
export const nowIso = () => new Date().toISOString();
