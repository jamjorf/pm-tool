// ============================================================================
// Rebuild the database from scratch: remove the file -> migrate -> seed.
//   pnpm --filter @pm/db reset
// A SQLite database is always local (a file under the repo, or `:memory:`), so
// no confirmation flag is needed; `--yes` is still accepted for scripts that
// pass it, and is required only for a DATABASE_URL with a network scheme,
// which cannot be a SQLite database anyway.
// ============================================================================
import { existsSync, rmSync } from 'node:fs';
import { databasePath, databaseUrl, hasFlag, isMain } from './client.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';
import { openDb } from './sqlite.js';

const NETWORK_SCHEME = /^(postgres(ql)?|mysql|mariadb|mssql|mongodb(\+srv)?|redis|libsql|https?|wss?):\/\//i;

/**
 * True for `:memory:` and for any filesystem path (plain, `sqlite:` or `file:`
 * prefixed, relative or absolute) — there is no remote SQLite. Only a URL with
 * a network scheme such as `postgres://host/db` is considered non-local.
 */
export function isLocalDatabaseUrl(url: string): boolean {
  return !NETWORK_SCHEME.test(url.trim());
}

export interface ResetOptions {
  log?: (message: string) => void;
}

/**
 * Delete the database file (plus its `-wal` / `-shm` / `-journal` siblings),
 * then run the migrations and the seed on a fresh connection. Takes a URL, not
 * a client: the file is removed from under any open handle, so callers must
 * open their own connection afterwards. For `:memory:` there is nothing to
 * delete; a fresh in-memory database is migrated and seeded, then closed
 * (useful only as a smoke test — the data is gone when this returns).
 *
 * Development only: do not run it while the API is serving the same file.
 */
export async function reset(url: string = databaseUrl(), opts: ResetOptions = {}): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const path = databasePath(url);
  if (path !== ':memory:') {
    for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      if (existsSync(f)) {
        rmSync(f, { force: true });
        log(`removed ${f}`);
      }
    }
  }
  const sql = openDb(path);
  try {
    const m = await runMigrations(sql, { log });
    log(`migrate: ${m.applied.length} applied`);
    const s = await seed(sql, { force: true, log });
    if (s) log(`seed: ${s.work_items} work items in ${s.projects} projects`);
  } finally {
    sql.close(); // last connection: checkpoints and removes the -wal/-shm files
  }
}

if (isMain(import.meta.url)) {
  const url = databaseUrl();
  if (!isLocalDatabaseUrl(url) && !hasFlag('--yes')) {
    console.error(`reset: ${url.replace(/\/\/.*@/, '//***@')} is not a local SQLite database (file path or :memory:); pass --yes to override`);
    process.exit(1);
  }
  console.log(`database: ${databasePath(url)}`);
  await reset(url, { log: (m) => console.log(m) });
  console.log('reset: done');
}
