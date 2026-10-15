// ============================================================================
// Tiny migration runner: applies migrations/*.sql in filename order, each in
// its own transaction, recording them in schema_migrations.
//   pnpm --filter @pm/db migrate          (DATABASE_URL, default local)
// Exported so the API tests can bring up a schema: runMigrations(sql).
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, isMain, type Sql } from './client.js';

/** Absolute path of packages/db/migrations (works from src/ via tsx and from dist/). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationResult {
  /** migrations run by this call */
  applied: string[];
  /** migrations that were already recorded */
  skipped: string[];
  /** baseline migration recorded without running because the schema already existed */
  adopted: string[];
}

export interface MigrateOptions {
  dir?: string;
  log?: (message: string) => void;
}

/** Sorted list of migration files in a directory. */
export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
}

export async function runMigrations(sql: Sql, opts: MigrateOptions = {}): Promise<MigrationResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => undefined);
  const files = listMigrations(dir);
  const result: MigrationResult = { applied: [], skipped: [], adopted: [] };

  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  // Serialize concurrent runners (api tests, dev servers) on one advisory lock.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(424242)`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));

    // A database whose schema was applied out-of-band (psql -f migrations/0001_init.sql)
    // has no schema_migrations rows but does have work_items: record the baseline
    // instead of re-running it.
    if (done.size === 0 && files.length) {
      const [row] = await tx<{ t: string | null }[]>`select to_regclass('public.work_items')::text as t`;
      if (row?.t) {
        const first = files[0]!;
        await tx`insert into schema_migrations (name) values (${first}) on conflict do nothing`;
        done.add(first);
        result.adopted.push(first);
        log(`adopted  ${first} (schema already present; recorded as applied)`);
      }
    }

    for (const file of files) {
      if (result.adopted.includes(file)) continue;
      if (done.has(file)) { result.skipped.push(file); continue; }
      const text = readFileSync(join(dir, file), 'utf8');
      // Multi-statement text with $$ bodies: unsafe() without params uses the simple
      // query protocol, so the whole file runs as one script inside this transaction.
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
      result.applied.push(file);
      log(`applied  ${file}`);
    }
  });
  for (const f of result.skipped) log(`skipped  ${f} (already applied)`);
  return result;
}

if (isMain(import.meta.url)) {
  const sql = connect();
  try {
    const r = await runMigrations(sql, { log: (m) => console.log(m) });
    console.log(`migrate: ${r.applied.length} applied, ${r.adopted.length} adopted, ${r.skipped.length} already applied`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
