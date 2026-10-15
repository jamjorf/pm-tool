import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from './migrate.js';
import { seed, SEED_PROJECTS, SEED_USERS } from './seed.js';
import { reset, isLocalDatabaseUrl } from './reset.js';
import { connect } from './client.js';

const ADMIN_URL = process.env.DB_TEST_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const TEST_DB = 'pmtool_db_test';

async function prepare(): Promise<string | null> {
  const admin = postgres(ADMIN_URL, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    return ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
  } catch {
    return null;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => undefined);
  }
}

const url = await prepare();
const d = url ? describe : describe.skip;
if (!url) console.warn(`[db] ${ADMIN_URL} not reachable; skipping migration/seed tests`);

d('migrations + seed', () => {
  const sql = connect(url!);
  afterAll(async () => { await sql.end({ timeout: 2 }); });

  it('lists migration files in order', () => {
    expect(listMigrations()).toEqual(expect.arrayContaining(['0001_init.sql']));
    expect(MIGRATIONS_DIR.endsWith('migrations')).toBe(true);
  });

  it('applies all migrations once, then is a no-op', async () => {
    const first = await runMigrations(sql);
    expect(first.applied).toEqual(listMigrations());
    expect(first.adopted).toEqual([]);
    const second = await runMigrations(sql);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(listMigrations());
    const rows = await sql`select name from schema_migrations order by name`;
    expect(rows.map((r) => r.name)).toEqual(listMigrations());
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from workflow_states`;
    expect(n).toBe(10);
  });

  it('seeds once and skips the second time', async () => {
    const s = await seed(sql);
    expect(s).not.toBeNull();
    expect(s!.work_items).toBeGreaterThanOrEqual(60);
    expect(s!.users).toBe(SEED_USERS.length);
    expect(s!.projects).toBe(SEED_PROJECTS.length);
    expect(await seed(sql)).toBeNull();

    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from work_items_v where deleted_at is null`;
    expect(n).toBe(s!.work_items);
    const bugsWithoutSeverity = await sql`select 1 from work_items_v where type_key = 'bug' and fields->>'severity' is null`;
    expect(bugsWithoutSeverity).toHaveLength(0);
    const doneWithoutCompleted = await sql`select 1 from work_items_v where state_category = 'done' and completed_at is null`;
    expect(doneWithoutCompleted).toHaveLength(0);
    const [{ overdue }] = await sql<{ overdue: number }[]>`select count(*)::int as overdue from work_items_v where due_date < current_date and state_category not in ('done','canceled')`;
    expect(overdue).toBeGreaterThan(0);
    const [{ parents }] = await sql<{ parents: number }[]>`select count(distinct from_item_id)::int as parents from relations where type = 'parent_of'`;
    expect(parents).toBe(6);
    const [{ blocked }] = await sql<{ blocked: number }[]>`select count(*)::int as blocked from work_items_v where is_blocked`;
    expect(blocked).toBeGreaterThan(0);
    const mentions = await sql`select body from comments where body like '%@[%](user:%'`;
    expect(mentions.length).toBeGreaterThan(0);
    const onb = await sql`select effective_project_role(u.id, p.id) as role from users u, projects p where u.email = 'carol@firm.com' and p.key = 'ONB'`;
    expect(onb[0]!.role).toBeNull();
    const [{ views }] = await sql<{ views: number }[]>`select count(*)::int as views from views where kind = 'dashboard'`;
    expect(views).toBe(SEED_PROJECTS.length);
  });

  it('--force wipes and reseeds (including the append-only activity log)', async () => {
    const s = await seed(sql, { force: true });
    expect(s).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from activity_events`;
    expect(n).toBe(s!.activity_events);
  });

  it('adopts a schema that was applied with psql', async () => {
    await sql.unsafe('drop schema public cascade; create schema public;');
    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
    const r = await runMigrations(sql);
    expect(r.adopted).toEqual(['0001_init.sql']);
    expect(r.applied).toEqual(listMigrations().filter((f) => f !== '0001_init.sql'));
  });

  it('reset drops, migrates and seeds (own connection, survives schema drop)', async () => {
    await reset(url!);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from work_items`;
    expect(n).toBeGreaterThanOrEqual(60);
  });

  it('isLocalDatabaseUrl', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@localhost:5432/x')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://u:p@127.0.0.1/x')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://u:p@db.prod.internal/x')).toBe(false);
    expect(isLocalDatabaseUrl('nope')).toBe(false);
  });
});
