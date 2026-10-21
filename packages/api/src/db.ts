import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** Any query runner (connection pool or an open transaction). */
export type Q = Sql | Tx;
export type Row = Record<string, any>;

/** Advisory lock taken by every write transaction so `version` order == commit order. */
export const SYNC_LOCK_ID = 42;

function pgTimestampToIso(x: string): string {
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? x : d.toISOString();
}

/**
 * postgres.js client. Rows are returned exactly as SQL (snake_case).
 * Parsers: bigint/numeric -> number, date -> 'YYYY-MM-DD' string, timestamps -> ISO strings,
 * so rows can be JSON-serialized and diffed without surprises.
 */
export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    transform: { undefined: null },
    onnotice: () => {},
    types: {
      bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)),
        parse: (x: string) => x,
      },
      timestamp: {
        to: 1184,
        from: [1114, 1184],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
        parse: pgTimestampToIso,
      },
    },
  });
}

/** Run `fn` in a transaction that holds the global sync advisory lock (write path). */
export async function withTxn<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${SYNC_LOCK_ID})`;
    return fn(tx);
  })) as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/** Current global sync version (last value handed out by sync_version_seq). */
export async function currentVersion(q: Q): Promise<number> {
  const [r] = await q`select last_value::bigint as v, is_called from sync_version_seq`;
  return r?.is_called ? Number(r.v) : 0;
}
