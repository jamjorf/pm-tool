// Migrations, seed and reset against Node's built-in SQLite: in-memory for the
// bulk of the suite, a temp file for `reset`. No server, no native modules.
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './sqlite.js';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from './migrate.js';
import { seed, SEED_PROJECTS, SEED_USERS, countSeedItems, type ItemSeed, type SeedSummary } from './seed.js';
import { reset, isLocalDatabaseUrl } from './reset.js';

const SYNCED_TABLES = [
  'users', 'teams', 'workflows', 'workflow_states', 'workflow_transitions', 'item_types', 'projects', 'project_members',
  'work_items', 'labels', 'work_item_labels', 'comments', 'relations', 'views', 'item_watchers', 'notification_preferences',
];
const TOTAL_ITEMS = SEED_PROJECTS.reduce((n, p) => n + countSeedItems(p.items), 0);

describe('@pm/db on SQLite', () => {
  const sql = openDb(':memory:');
  let summary: SeedSummary;
  const tmp = mkdtempSync(join(tmpdir(), 'pm-db-test-'));
  afterAll(() => {
    sql.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const userId = async (email: string) => (await sql<{ id: string }>`select id from users where email = ${email}`)[0]!.id;
  const projectId = async (key: string) => (await sql<{ id: string }>`select id from projects where key = ${key}`)[0]!.id;
  const count = async (table: string, where = '') => Number((await sql<{ n: number }>`select count(*) as n from ${sql.raw(table)} ${sql.raw(where)}`)[0]!.n);

  it('lists migration files in order', () => {
    expect(listMigrations()).toEqual(expect.arrayContaining(['0001_init.sql']));
    expect(listMigrations()).toEqual([...listMigrations()].sort());
    expect(MIGRATIONS_DIR.endsWith('migrations')).toBe(true);
  });

  it('applies all migrations once, then is a no-op', async () => {
    const first = await runMigrations(sql);
    expect(first.applied).toEqual(listMigrations());
    expect(first.adopted).toEqual([]);
    const second = await runMigrations(sql);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(listMigrations());
    const rows = await sql<{ name: string }>`select name from schema_migrations order by name`;
    expect(rows.map((r) => r.name)).toEqual(listMigrations());
    expect(await count('workflow_states')).toBe(10);
    expect(await count('item_types')).toBe(4);
    expect(await count('relation_types')).toBe(5);
    const [fk] = await sql<{ foreign_keys: number }>`pragma foreign_keys`;
    expect(fk!.foreign_keys).toBe(1);
  });

  it('adopts a schema applied out-of-band (sqlite3 db < 0001_init.sql)', async () => {
    const other = openDb(':memory:');
    try {
      other.exec(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
      const r = await runMigrations(other);
      expect(r.adopted).toEqual(['0001_init.sql']);
      expect(r.applied).toEqual(listMigrations().filter((f) => f !== '0001_init.sql'));
      const again = await runMigrations(other);
      expect(again.applied).toEqual([]);
      expect(again.adopted).toEqual([]);
      expect(again.skipped).toEqual(listMigrations());
    } finally {
      other.close();
    }
  });

  it('seeds once and skips the second time', async () => {
    const s = await seed(sql);
    expect(s).not.toBeNull();
    summary = s!;
    expect(summary.users).toBe(SEED_USERS.length);
    expect(summary.teams).toBe(3);
    expect(summary.projects).toBe(SEED_PROJECTS.length);
    expect(summary.labels).toBe(9);
    expect(summary.work_items).toBe(60);
    expect(TOTAL_ITEMS).toBe(60);
    expect(summary.relations).toBe(24 + 4 + 1 + 2);
    expect(summary.comments).toBe(12);
    expect(summary.views).toBe(19);
    expect(summary.notification_preferences).toBe(SEED_USERS.length * 2);
    expect(await seed(sql)).toBeNull();

    expect(await count('users')).toBe(summary.users);
    expect(await count('users', 'where is_service = 1')).toBe(1);
    expect(await count('projects')).toBe(summary.projects);
    expect(await count('work_items')).toBe(summary.work_items);
    expect(await count('relations')).toBe(summary.relations);
    expect(await count('comments')).toBe(summary.comments);
    expect(await count('item_watchers')).toBe(summary.watchers);
    expect(await count('activity_events')).toBe(summary.activity_events);
    expect(await count('views')).toBe(summary.views);
    expect(await count('webhook_endpoints', 'where is_active = 0')).toBe(1);
    expect(await count('integration_configs', 'where is_active = 0')).toBe(3);
    expect(await count('work_items_v', 'where deleted_at is null')).toBe(summary.work_items);
  });

  it('numbers items contiguously per project with explicit KEY-n keys', async () => {
    const items = await sql<{ key: string | null; number: number | null; project_key: string }>`select key, number, project_key from work_items_v`;
    expect(items).toHaveLength(60);
    for (const it of items) {
      expect(it.key).toMatch(/^[A-Z]+-\d+$/);
      expect(it.key).toBe(`${it.project_key}-${it.number}`);
    }
    const perProject = await sql<{ key: string; item_seq: number; n: number; lo: number; hi: number; distinct_n: number }>`
      select p.key, p.item_seq, count(*) as n, min(w.number) as lo, max(w.number) as hi, count(distinct w.number) as distinct_n
        from work_items w join projects p on p.id = w.project_id group by p.id order by p.key`;
    expect(perProject.map((r) => r.key)).toEqual(['EQD', 'ONB', 'OPS', 'RATES']);
    for (const r of perProject) {
      expect(r.lo).toBe(1);
      expect(r.hi).toBe(r.n);
      expect(r.distinct_n).toBe(r.n);
      expect(r.item_seq).toBe(r.n); // the trigger continues from here for app-created items
      expect(r.n).toBe(countSeedItems(SEED_PROJECTS.find((p) => p.key === r.key)!.items));
    }
    // An item created the normal way (no number) continues the sequence.
    const rates = perProject.find((r) => r.key === 'RATES')!;
    const pid = await projectId('RATES');
    await sql.begin(async (tx) => {
      await tx`insert into work_items (id, project_id, type_id, title, state_id) values ('probe', ${pid}, '00000000-0000-4000-8000-000000000d01', 'Probe', '00000000-0000-4000-8000-000000000b02')`;
      const [row] = await tx<{ key: string; number: number }>`select key, number from work_items where id = 'probe'`;
      expect(row).toEqual({ key: `RATES-${rates.n + 1}`, number: rates.n + 1 });
      throw new Error('rollback');
    }).catch((e: Error) => expect(e.message).toBe('rollback'));
    expect(await count('work_items')).toBe(60);
  });

  it('typed fields, states and dates are consistent', async () => {
    const bugs = await sql<{ key: string; fields: Record<string, unknown>; type_key: string }>`select key, fields, type_key from work_items_v where type_key = 'bug'`;
    expect(bugs.length).toBeGreaterThan(5);
    for (const b of bugs) {
      expect(typeof b.fields).toBe('object'); // hydrated JSON
      expect(['s1', 's2', 's3', 's4']).toContain(b.fields.severity);
    }
    expect(await count('work_items_v', `where type_key = 'bug' and fields->>'severity' is null`)).toBe(0);
    expect(await count('work_items_v', `where type_key = 'request' and json_type(fields, '$.approved') not in ('true', 'false')`)).toBe(0);
    expect(await count('work_items_v', `where type_key = 'initiative' and json_type(fields, '$.budget') <> 'integer'`)).toBe(0);
    expect(await count('work_items_v', `where state_category = 'done' and completed_at is null`)).toBe(0);
    expect(await count('work_items_v', `where state_category = 'canceled' and canceled_at is null`)).toBe(0);
    expect(await count('work_items_v', `where state_category not in ('done','canceled') and completed_at is not null`)).toBe(0);
    expect(await count('work_items_v', `where due_date < date('now') and state_category not in ('done','canceled')`)).toBeGreaterThan(0);
    expect(await count('work_items_v', `where due_date >= date('now')`)).toBeGreaterThan(0);
    expect(await count('work_items', `where updated_at < created_at`)).toBe(0);
    expect(await count('work_items', `where updated_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)).toBe(0);
    // state must belong to the type's workflow (request → simple workflow)
    expect(await count('work_items_v', `where type_key = 'request' and state_key not in ('todo','doing','done','canceled')`)).toBe(0);
    const confidential = await sql<{ confidential: boolean; key: string }>`select confidential, key from work_items_v where confidential = 1`;
    expect(confidential).toHaveLength(1);
    expect(confidential[0]!.confidential).toBe(true); // hydrated boolean
  });

  it('permissions: effective_roles and visibility', async () => {
    const alice = await userId('alice@firm.com');
    const carol = await userId('carol@firm.com');
    const grace = await userId('grace@firm.com');
    const eve = await userId('eve@firm.com');
    const onb = await projectId('ONB');
    expect(await count('effective_roles', `where user_id = '${alice}'`)).toBe(4);
    expect(await count('effective_roles', `where user_id = '${alice}' and role = 'admin'`)).toBe(4);
    expect(await count('effective_roles', `where user_id = '${carol}'`)).toBe(3);
    expect(await count('effective_roles', `where user_id = '${carol}' and project_id = '${onb}'`)).toBe(0);
    const [g] = await sql<{ role: string }>`select role from effective_roles where user_id = ${grace} and project_id = ${onb}`;
    expect(g!.role).toBe('admin');
    const [e] = await sql<{ role: string }>`select role from effective_roles where user_id = ${eve} and project_id = ${onb}`;
    expect(e!.role).toBe('viewer');
    // ONB items are invisible to carol; the confidential ONB request is visible to grace (admin) but not to eve (viewer)
    expect(await count('visible_items vi join work_items w on w.id = vi.item_id', `where vi.user_id = '${carol}' and w.project_id = '${onb}'`)).toBe(0);
    expect(await count('visible_items vi join work_items w on w.id = vi.item_id', `where vi.user_id = '${carol}'`)).toBe(60 - countSeedItems(SEED_PROJECTS.find((p) => p.key === 'ONB')!.items));
    expect(await count('visible_items vi join work_items w on w.id = vi.item_id', `where vi.user_id = '${grace}' and w.confidential = 1`)).toBe(1);
    expect(await count('visible_items vi join work_items w on w.id = vi.item_id', `where vi.user_id = '${eve}' and w.confidential = 1`)).toBe(0);
  });

  it('graph: hierarchy, blockers and rollups', async () => {
    expect(await count('relations', `where type = 'parent_of'`)).toBe(24);
    expect(await count('(select distinct from_item_id from relations where type = \'parent_of\')')).toBe(6);
    expect(await count('relations', `where type = 'blocks'`)).toBe(4);
    expect(await count('relations', `where type = 'duplicates'`)).toBe(1);
    expect(await count('relations', `where type = 'links_to' and external_kind = 'github_pr'`)).toBe(2);
    const prs = await sql<{ external_ref: { url: string; number: number }; external_key: string }>`select external_ref, external_key from relations where type = 'links_to' order by external_key`;
    expect(prs.map((r) => r.external_ref.url)).toEqual(['https://github.com/firm/eqd-tooling/pull/88', 'https://github.com/firm/rates-platform/pull/412']);
    expect(prs[0]!.external_key).toBe('github_pr:firm/eqd-tooling#88');

    expect(await count('open_blockers')).toBe(4);
    const blocked = await sql<{ key: string; is_blocked: boolean }>`select key, is_blocked from work_items_v where is_blocked = 1`;
    expect(blocked).toHaveLength(4);
    expect(blocked[0]!.is_blocked).toBe(true);
    expect(await count('work_items_v', `where title = 'Decommission USD-LIBOR curve bootstrapper' and is_blocked = 1`)).toBe(1);

    // every initiative's rollup equals its seeded children
    const seedInitiatives = SEED_PROJECTS.flatMap((p) => p.items.filter((i) => i.type === 'initiative'));
    expect(seedInitiatives).toHaveLength(6);
    const estimateOf = (c: ItemSeed) => (c.estimate === undefined ? 3 : c.estimate ?? 0);
    for (const ini of seedInitiatives) {
      const [r] = await sql<{ total: number; done: number; estimate_total: number; estimate_done: number }>`
        select r.* from item_rollups r join work_items w on w.id = r.root_id where w.title = ${ini.title}`;
      const children = ini.children ?? [];
      expect(r, ini.title).toBeDefined();
      expect(r!.total).toBe(children.length);
      expect(r!.done).toBe(children.filter((c) => c.state === 'done').length);
      expect(r!.estimate_total).toBe(children.reduce((n, c) => n + estimateOf(c), 0));
      expect(r!.estimate_done).toBe(children.filter((c) => c.state === 'done').reduce((n, c) => n + estimateOf(c), 0));
    }
    expect(await count('item_ancestry', 'where depth > 1')).toBe(0);
    expect(await count('item_parents')).toBe(24);
  });

  it('comments: the @mention and its reply', async () => {
    const dan = await userId('dan@firm.com');
    const mentions = await sql<{ id: string; body: string; item_id: string }>`select id, body, item_id from comments where body like '%@[%](user:%'`;
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.body).toContain(`@[Dan Whitfield](user:${dan})`);
    const replies = await sql<{ author_id: string; parent_id: string }>`select author_id, parent_id from comments where parent_id is not null`;
    expect(replies).toEqual([{ author_id: dan, parent_id: mentions[0]!.id }]);
    // dan replied to the mention comment, so the first-wins watcher dedupe records him as a commenter on that item
    expect(await count('item_watchers', `where item_id = '${mentions[0]!.item_id}' and user_id = '${dan}' and reason in ('mention', 'commenter')`)).toBe(1);
    expect(await count('item_watchers', `where reason = 'commenter'`)).toBeGreaterThan(0);
    expect(await count('item_watchers', `where reason = 'assignee'`)).toBeGreaterThan(40);
    expect(await count('comments', `where source <> 'app'`)).toBe(0);
    expect(await count('activity_events', `where entity_type = 'comment' and action = 'create'`)).toBe(12);
  });

  it('views, notification preferences and integrations', async () => {
    const alice = await userId('alice@firm.com');
    expect(await count('views', `where kind = 'dashboard'`)).toBe(SEED_PROJECTS.length);
    expect(await count('views', `where is_default = 1 and name = 'All open' and kind = 'list'`)).toBe(SEED_PROJECTS.length);
    expect(await count('views', `where kind = 'board' and name = 'Board'`)).toBe(SEED_PROJECTS.length);
    expect(await count('views', `where kind = 'timeline' and name = 'Roadmap'`)).toBe(SEED_PROJECTS.length);
    const dashboards = await sql<{ spec: { dashboard: { widgets: { id: string; query: { filter: { and: unknown[] } } }[] } } }>`select spec from views where kind = 'dashboard'`;
    for (const d of dashboards) {
      expect(d.spec.dashboard.widgets).toHaveLength(4);
      const completed = d.spec.dashboard.widgets.find((w) => w.id === 'completed_30d')!;
      expect(completed.query.filter.and).toContainEqual({ field: 'completed_at', op: 'within_days', value: -30 });
    }
    const mine = await sql<{ name: string; is_shared: boolean; project_id: string | null }>`select name, is_shared, project_id from views where owner_id = ${alice} order by sort`;
    expect(mine).toEqual([
      { name: 'My work', is_shared: false, project_id: null },
      { name: 'Overdue across the firm', is_shared: true, project_id: null },
      { name: 'Regulatory work', is_shared: true, project_id: null },
    ]);
    expect(await count('notification_preferences', `where channel = 'in_app'`)).toBe(SEED_USERS.length);
    const [email] = await sql<{ quiet_hours: { tz: string }; rules: { mention: boolean } }>`select quiet_hours, rules from notification_preferences where channel = 'email' and user_id = ${alice}`;
    expect(email!.quiet_hours.tz).toBe('Europe/London');
    expect(email!.rules.mention).toBe(true); // column default, hydrated
    const [hook] = await sql<{ event_kinds: string[]; is_active: boolean }>`select event_kinds, is_active from webhook_endpoints`;
    expect(hook).toEqual({ event_kinds: ['*'], is_active: false });
    const configs = await sql<{ kind: string; config: Record<string, unknown>; is_active: boolean }>`select kind, config, is_active from integration_configs order by kind`;
    expect(configs.map((c) => c.kind)).toEqual(['email', 'github', 'slack']);
    expect(configs.every((c) => c.is_active === false)).toBe(true);
    expect(configs[1]!.config.repos).toEqual(['firm/rates-platform', 'firm/eqd-tooling']);
  });

  it('full-text search finds items by a title word (with stemming)', async () => {
    const hits = await sql<{ key: string; title: string }>`
      select w.key, w.title from work_items_fts f join work_items w on w.id = f.id where work_items_fts match ${'swaption'}`;
    expect(hits.map((h) => h.title)).toEqual(['Swaption vol surface fails to calibrate on holiday dates']);
    const stemmed = await sql<{ title: string }>`select w.title from work_items_fts f join work_items w on w.id = f.id where work_items_fts match ${'calibrating'} order by w.title`;
    expect(stemmed.map((h) => h.title)).toContain('Swaption vol surface fails to calibrate on holiday dates');
    expect(await count('work_items_fts')).toBe(60);
  });

  it('every synced row has version > 0; the activity log is JSON and grouped by txn', async () => {
    for (const t of SYNCED_TABLES) {
      expect(await count(t), t).toBeGreaterThan(0);
      expect(await count(t, 'where version is null or version <= 0'), t).toBe(0);
    }
    expect(sql.currentVersion()).toBeGreaterThan(0);
    const events = await sql<{ action: string; field: string | null; old_value: unknown; new_value: unknown; created_at: string }>`
      select action, field, old_value, new_value, created_at from activity_events order by created_at`;
    expect(events.length).toBe(summary.activity_events);
    expect(events.length).toBeGreaterThan(140);
    expect(await count('activity_events', `where action = 'create' and entity_type = 'work_item'`)).toBe(60);
    expect(await count('activity_events', `where field = 'state_id'`)).toBeGreaterThan(40);
    expect(await count('activity_events', `where created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)).toBe(0);
    expect(await count('activity_events', `where (old_value is not null and not json_valid(old_value)) or (new_value is not null and not json_valid(new_value))`)).toBe(0);
    const titleChange = events.find((e) => e.field === 'title')!;
    expect(typeof titleChange.new_value).toBe('string'); // scalar JSON via sql.json(), hydrated back to a string
    expect(titleChange.old_value).toBe(`Draft: ${titleChange.new_value}`);
    const [grouped] = await sql<{ n: number }>`select count(*) as n from (select txn_id from activity_events group by txn_id having count(*) > 1)`;
    expect(grouped!.n).toBeGreaterThan(0); // state_id + completed_at of a completion share a txn_id
    expect(() => sql`update activity_events set action = 'x'`.run()).toThrow(/append-only/);
  });

  it('--force wipes and reseeds, keeping the append-only guard in place', async () => {
    const before = (await sql<{ id: string }>`select id from users order by email`).map((r) => r.id);
    const s = await seed(sql, { force: true });
    expect(s).not.toBeNull();
    const after = (await sql<{ id: string }>`select id from users order by email`).map((r) => r.id);
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before); // fresh ids
    expect(await count('work_items')).toBe(60);
    expect(await count('activity_events')).toBe(s!.activity_events);
    expect(await count('work_items_fts')).toBe(60);
    expect(await count('workflow_states')).toBe(10); // reference data kept
    expect(await count('sqlite_master', `where type = 'trigger' and name in ('activity_events_no_update','activity_events_no_delete')`)).toBe(2);
    expect(() => sql`delete from activity_events`.run()).toThrow(/append-only/);
    const [fkCheck] = await sql`pragma foreign_key_check`;
    expect(fkCheck).toBeUndefined();
  });

  it('reset on a file: removes it, migrates and seeds; a second reset starts over', async () => {
    const path = join(tmp, 'reset.db');
    await reset(path);
    expect(existsSync(path)).toBe(true);
    const db = openDb(path);
    try {
      expect(Number((await db<{ n: number }>`select count(*) as n from work_items`)[0]!.n)).toBe(60);
      expect((await db<{ name: string }>`select name from schema_migrations`).map((r) => r.name)).toEqual(listMigrations());
      await db`insert into labels (id, name) values ('leftover', 'leftover')`;
      const [mode] = await db<{ journal_mode: string }>`pragma journal_mode`;
      expect(mode!.journal_mode).toBe('wal');
    } finally {
      db.close();
    }
    await reset(path);
    const db2 = openDb(path);
    try {
      expect(Number((await db2<{ n: number }>`select count(*) as n from labels where id = 'leftover'`)[0]!.n)).toBe(0);
      expect(Number((await db2<{ n: number }>`select count(*) as n from work_items`)[0]!.n)).toBe(60);
    } finally {
      db2.close();
    }
    expect(existsSync(`${path}-wal`)).toBe(false); // closed cleanly: checkpointed
    await reset(':memory:'); // nothing to delete; migrates + seeds a throwaway database
  });

  it('isLocalDatabaseUrl: every SQLite location is local', () => {
    expect(isLocalDatabaseUrl(':memory:')).toBe(true);
    expect(isLocalDatabaseUrl('./data/pmtool.db')).toBe(true);
    expect(isLocalDatabaseUrl('/var/lib/pm/pmtool.db')).toBe(true);
    expect(isLocalDatabaseUrl('sqlite:./data/pmtool.db')).toBe(true);
    expect(isLocalDatabaseUrl('file:pmtool.db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://u:p@db.prod.internal/x')).toBe(false);
    expect(isLocalDatabaseUrl('libsql://x.turso.io')).toBe(false);
  });
});
