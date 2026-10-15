// ============================================================================
// Drop everything and rebuild: schema -> migrations -> seed.
//   pnpm --filter @pm/db reset [--yes]
// Refuses non-local DATABASE_URL hosts unless --yes is passed.
// ============================================================================
import { connect, databaseUrl, hasFlag, isMain, type Sql } from './client.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db']);

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Drop `public`, re-run migrations and seed. Takes a URL rather than a client on
 * purpose: dropping the schema invalidates every prepared statement (and the
 * type OIDs postgres.js caches) on an existing connection, so this opens its own
 * short-lived connection with prepared statements disabled.
 */
export async function reset(url: string = databaseUrl(), opts: { log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const sql: Sql = connect(url, { prepare: false });
  try {
    await sql.unsafe('drop schema public cascade; create schema public;');
    log('schema public dropped and recreated');
    const m = await runMigrations(sql, { log });
    log(`migrate: ${m.applied.length} applied`);
    const s = await seed(sql, { force: true, log });
    if (s) log(`seed: ${s.work_items} work items in ${s.projects} projects`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isMain(import.meta.url)) {
  const url = databaseUrl();
  if (!isLocalDatabaseUrl(url) && !hasFlag('--yes')) {
    console.error(`reset: refusing to drop non-local database ${url.replace(/\/\/.*@/, '//***@')}; pass --yes to override`);
    process.exit(1);
  }
  await reset(url, { log: (m) => console.log(m) });
  console.log('reset: done');
}
