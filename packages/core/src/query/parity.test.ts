// Parity test: the SQL compiler and the client-side evaluator must return the
// same ids in the same order for every QuerySpec. Runs only when the test
// database is reachable (create it with:
//   PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -c 'create database pmtool_core_test'
//   PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d pmtool_core_test -f ../db/migrations/0001_init.sql
import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { compileQuery, compileWidget, visibilityWhere } from './compile.js';
import { runSpec, matchesSpec, type ItemRow, type EvalLookups } from './evaluate.js';
import { addDays, dateInTz } from './common.js';
import type { QuerySpec, QueryContext, Widget } from './spec.js';
import type { FieldDef, WorkflowState, ItemType, Project, Label, User } from '../schema/entities.js';

const URL = process.env.CORE_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/pmtool_core_test';

async function connect(): Promise<postgres.Sql | null> {
  const sql = postgres(URL, {
    max: 1,
    connect_timeout: 3,
    onnotice: () => {},
    // keep `date` columns as 'YYYY-MM-DD' strings (what the API sends to clients)
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
  });
  try {
    await sql`select 1 from work_items_v limit 0`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    return null;
  }
}

const sql = await connect();
const d = sql ? describe : describe.skip;
if (!sql) console.warn(`[parity] ${URL} not reachable; skipping SQL/local parity tests`);

const uid = () => crypto.randomUUID();
const now = new Date();
const today = dateInTz(now, 'UTC');

const alice = uid(), bob = uid(), carol = uid();
const ctx: QueryContext = { userId: alice, tz: 'UTC', now };

interface Seeded {
  items: ItemRow[];
  lookups: EvalLookups;
  fieldDefs: Record<string, FieldDef[]>;
  tst: string; sec: string;
  labelIds: Record<string, string>;
  initiativeIds: string[];
}

const EXTRA_TASK_DEFS: FieldDef[] = [
  { key: 'tags', label: 'Tags', kind: 'multi_select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] },
  { key: 'review_date', label: 'Review date', kind: 'date' },
  { key: 'owner', label: 'Owner', kind: 'user' },
  { key: 'links', label: 'Links', kind: 'url', multi: true },
  { key: 'weight', label: 'Weight', kind: 'number' },
  { key: 'go_live', label: 'Go live', kind: 'datetime' },
];

async function seed(sql: postgres.Sql): Promise<Seeded> {
  await sql`truncate users, projects, labels cascade`;
  await sql`update item_types set field_defs = ${sql.json(EXTRA_TASK_DEFS as never)} where key = 'task'`;

  await sql`insert into users (id, email, name, firm_role) values
    (${alice}, 'alice@test.com', 'Alice', 'owner'),
    (${bob}, 'bob@test.com', 'Bob', 'member'),
    (${carol}, 'carol@test.com', 'Carol', 'member')`;
  const tst = uid(), sec = uid();
  await sql`insert into projects (id, key, name, visibility, lead_id) values
    (${tst}, 'TST', 'Test project', 'firm', ${alice}),
    (${sec}, 'SEC', 'Secret project', 'private', ${alice})`;
  await sql`insert into project_members (project_id, user_id, role) values (${sec}, ${alice}, 'admin')`;

  const labelIds: Record<string, string> = { regulatory: uid(), 'tech-debt': uid(), 'quick-win': uid(), audit: uid() };
  await sql`insert into labels (id, project_id, name, color) values
    (${labelIds.regulatory!}, null, 'regulatory', '#f00'),
    (${labelIds['tech-debt']!}, null, 'tech-debt', '#0f0'),
    (${labelIds['quick-win']!}, ${tst}, 'quick-win', '#00f'),
    (${labelIds.audit!}, ${sec}, 'audit', '#ff0')`;

  const typeRows = await sql<ItemType[]>`select * from item_types where deleted_at is null`;
  const stateRows = await sql<WorkflowState[]>`select * from workflow_states where deleted_at is null order by workflow_id, sort`;
  const typeByKey = Object.fromEntries(typeRows.map((t) => [t.key, t]));
  const statesOf = (t: ItemType) => stateRows.filter((s) => s.workflow_id === t.workflow_id);

  const nouns = ['swaption pricer', 'collateral feed', 'repo blotter', 'curve builder', 'risk report', 'vol surface', 'trade capture', 'margin call'];
  const verbs = ['Migrate', 'Fix', 'Review', 'Build', 'Retire', 'Automate'];
  const ids: string[] = [];
  const initiativeIds: string[] = [];
  const users = [alice, bob, carol, null];
  const itemsById = new Map<string, { type: string; i: number }>();
  for (let i = 0; i < 40; i++) {
    const typeKey = i % 8 === 0 ? 'initiative' : i % 3 === 0 ? 'bug' : i % 5 === 0 ? 'request' : 'task';
    const type = typeByKey[typeKey]!;
    const states = statesOf(type);
    const state = states[(i * 5) % states.length]!;
    const id = uid();
    ids.push(id);
    itemsById.set(id, { type: typeKey, i });
    if (typeKey === 'initiative') initiativeIds.push(id);
    const project = i % 4 === 3 ? sec : tst;
    let fields: Record<string, unknown> = {};
    if (typeKey === 'bug') fields = { severity: ['s1', 's2', 's3', 's4'][i % 4], environment: i % 2 ? 'prod' : null, steps: i % 3 ? `step ${i}` : '' };
    if (typeKey === 'initiative') fields = { owner_desk: i % 16 ? 'Rates' : 'EQD', budget: i * 1000, quarter: ['2026Q4', '2027Q1', '2027Q2'][i % 3] };
    if (typeKey === 'request') fields = { requester_desk: 'Ops', urgency: ['today', 'this_week', 'whenever'][i % 3], approved: i % 2 === 0 };
    if (typeKey === 'task') {
      fields = {
        tags: i % 4 === 0 ? [] : i % 4 === 1 ? ['a'] : i % 4 === 2 ? ['a', 'b'] : ['c'],
        review_date: i % 3 === 0 ? null : addDays(today, (i % 9) - 4),
        owner: i % 2 ? alice : bob,
        links: i % 3 === 1 ? ['https://github.com/org/repo/pull/1'] : [],
        weight: (i % 6) + 0.25,
        go_live: i % 5 === 1 ? new Date(now.getTime() + (i - 20) * 86400000).toISOString() : null,
      };
      if (i % 7 === 0) delete fields.tags; // missing key vs empty array
    }
    const createdAt = new Date(now.getTime() - ((i * 7919) % 40) * 3600_000 - i * 1000 - (i % 3) * 7);
    const updatedAt = new Date(now.getTime() - ((i * 31) % 20) * 3600_000 - i * 10);
    const completedAt = state.category === 'done' ? new Date(now.getTime() - (i * 3) * 86400000 - i * 1000) : null;
    const canceledAt = state.category === 'canceled' ? new Date(now.getTime() - 3600_000) : null;
    const dueDate = i % 3 === 0 ? null : addDays(today, (i % 11) - 5);
    const startDate = i % 4 === 0 ? addDays(today, -i) : null;
    const estimate = i % 4 === 1 ? null : (i % 7) + 0.5;
    const title = `${verbs[i % verbs.length]} ${nouns[i % nouns.length]} ${i}`;
    const description = i % 2 ? `Work on the ${nouns[i % nouns.length]} for the desk. ${i % 6 === 1 ? 'Needs regulatory sign-off.' : ''}` : '';
    await sql`insert into work_items (id, project_id, type_id, title, description, state_id, priority, assignee_id, reporter_id, created_by,
        start_date, due_date, estimate, fields, confidential, sort_order, created_at, updated_at, completed_at, canceled_at, archived_at)
      values (${id}, ${project}, ${type.id}, ${title}, ${description}, ${state.id}, ${i % 5}, ${users[i % 4]!}, ${users[(i + 1) % 4]!}, ${alice},
        ${startDate}, ${dueDate}, ${estimate}, ${sql.json(fields as never)}, ${i % 10 === 7}, ${(i * 13) % 7},
        ${createdAt}, ${updatedAt}, ${completedAt}, ${canceledAt}, ${i === 21 || i === 22 ? now : null})`;
  }
  // tombstone one row: must never appear anywhere
  await sql`update work_items set deleted_at = now() where id = ${ids[23]!}`;

  // labels
  for (let i = 0; i < 40; i++) {
    const id = ids[i]!;
    const names: string[] = [];
    if (i % 3 === 0) names.push('regulatory');
    if (i % 4 === 0) names.push('tech-debt');
    if (i % 5 === 0) names.push('quick-win');
    if (i % 7 === 0) names.push('audit');
    for (const n of names) await sql`insert into work_item_labels (item_id, label_id) values (${id}, ${labelIds[n]!})`;
  }
  // relations: initiatives parent their next three items; some blocks; a duplicate; an external link
  for (const init of [0, 8, 16, 24, 32]) {
    for (let k = 1; k <= 3; k++) {
      await sql`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uid()}, 'parent_of', ${ids[init]!}, ${ids[init + k]!}, ${alice})`;
    }
  }
  for (const [a, b] of [[1, 2], [9, 10], [17, 18], [33, 34], [4, 6], [12, 13]]) {
    await sql`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uid()}, 'blocks', ${ids[a!]!}, ${ids[b!]!}, ${alice})`;
  }
  await sql`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uid()}, 'duplicates', ${ids[11]!}, ${ids[12]!}, ${alice})`;
  await sql`insert into relations (id, type, from_item_id, external_kind, external_ref, created_by) values (${uid()}, 'links_to', ${ids[13]!}, 'github_pr', ${sql.json({ url: 'https://github.com/org/repo/pull/7', number: 7 })}, ${alice})`;

  // ---- load what the client would have ------------------------------------
  const rows = await sql`select * from work_items_v`;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const items: ItemRow[] = rows.map((r) => ({
    ...(r as unknown as ItemRow),
    created_at: iso(r.created_at) as string,
    updated_at: iso(r.updated_at) as string,
    completed_at: iso(r.completed_at) as string | null,
    canceled_at: iso(r.canceled_at) as string | null,
    archived_at: iso(r.archived_at) as string | null,
    deleted_at: iso(r.deleted_at) as string | null,
    // estimate stays a numeric string on purpose: the evaluator must coerce it
  }));
  const projects = await sql<Project[]>`select * from projects`;
  const labels = await sql<Label[]>`select * from labels`;
  const userRows = await sql<User[]>`select * from users`;
  const wil = await sql<{ item_id: string; label_id: string }[]>`select item_id, label_id from work_item_labels where deleted_at is null`;
  const parents = await sql<{ from_item_id: string; to_item_id: string }[]>`select from_item_id, to_item_id from relations where type = 'parent_of' and deleted_at is null`;
  const blocked = await sql<{ id: string }[]>`select w.id from work_items w where exists (select 1 from item_open_blockers(w.id))`;
  const labelIdsByItem: Record<string, string[]> = {};
  for (const r of wil) (labelIdsByItem[r.item_id] ??= []).push(r.label_id);
  const lookups: EvalLookups = {
    states: Object.fromEntries(stateRows.map((s) => [s.id, s])),
    types: Object.fromEntries(typeRows.map((t) => [t.id, t])),
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    labels: Object.fromEntries(labels.map((l) => [l.id, l])),
    users: Object.fromEntries(userRows.map((u) => [u.id, u])),
    labelIdsByItem,
    parentByItem: Object.fromEntries(parents.map((p) => [p.to_item_id, p.from_item_id])),
    blockedItems: new Set(blocked.map((b) => b.id)),
  };
  const fieldDefs = Object.fromEntries(typeRows.map((t) => [t.key, t.field_defs]));
  return { items, lookups, fieldDefs, tst, sec, labelIds, initiativeIds };
}

d('SQL compiler ⇔ local evaluator parity', async () => {
  const S = await seed(sql!);
  afterAll(async () => { await sql!.end({ timeout: 2 }); });

  const local = (spec: QuerySpec) => runSpec(spec, S.items, ctx, S.lookups).items.map((i) => i.id);
  const remote = async (spec: QuerySpec) => {
    const q = compileQuery(spec, ctx, { fieldDefs: S.fieldDefs });
    const rows = await sql!.unsafe(q.text, q.values as never[]);
    return rows.map((r) => r.id as string);
  };

  const specs: Record<string, QuerySpec & { expectEmpty?: boolean }> = {
    'default sort': {},
    'open items (category nin)': { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } },
    'done, newest completion first': { filter: { field: 'state.category', op: 'in', value: ['done'] }, sort: [{ field: 'completed_at', dir: 'desc' }] },
    'assigned to $me': { filter: { field: 'assignee_id', op: 'eq', value: '$me' } },
    'unassigned': { filter: { field: 'assignee_id', op: 'is_null' } },
    'neq includes nulls': { filter: { field: 'assignee_id', op: 'neq', value: alice } },
    'nin includes nulls': { filter: { field: 'assignee_id', op: 'nin', value: [alice, bob] } },
    'in with null element': { filter: { field: 'assignee_id', op: 'in', value: [carol, null] } },
    'priority lte + sort nulls first': { filter: { field: 'priority', op: 'lte', value: 2 }, sort: [{ field: 'priority', dir: 'asc' }, { field: 'due_date', dir: 'asc', nulls: 'first' }] },
    'overdue': { filter: { and: [{ field: 'due_date', op: 'before', value: '$today' }, { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }] }, sort: [{ field: 'due_date', dir: 'asc' }] },
    'due within 7 days': { filter: { field: 'due_date', op: 'within_days', value: 7 }, sort: [{ field: 'due_date', dir: 'asc' }, { field: 'priority', dir: 'desc' }] },
    'due after today': { filter: { field: 'due_date', op: 'after', value: '$today' } },
    'completed last 30 days': { filter: { field: 'completed_at', op: 'within_days', value: -30 } },
    'completed before today (datetime vs date macro)': { filter: { field: 'completed_at', op: 'before', value: '$today' } },
    'updated since instant': { filter: { field: 'updated_at', op: 'gt', value: new Date(now.getTime() - 10 * 3600_000).toISOString() }, sort: [{ field: 'updated_at', dir: 'desc' }] },
    'created this month / week macros': { filter: { or: [{ field: 'created_at', op: 'gte', value: '$start_of_week' }, { field: 'created_at', op: 'lt', value: '$start_of_month' }] } },
    'title contains (case-insensitive)': { filter: { field: 'title', op: 'contains', value: 'SWAPTION' }, sort: [{ field: 'title', dir: 'asc' }] },
    'title starts_with': { filter: { field: 'title', op: 'starts_with', value: 'fix' }, sort: [{ field: 'title', dir: 'desc' }] },
    'key starts_with SEC-': { filter: { field: 'key', op: 'starts_with', value: 'SEC-' }, sort: [{ field: 'number', dir: 'asc' }] },
    'like metachars are escaped': { filter: { field: 'title', op: 'contains', value: '100%' }, expectEmpty: true },
    'description is_empty': { filter: { field: 'description', op: 'is_empty' } },
    'description not_empty': { filter: { field: 'description', op: 'not_empty' } },
    'estimate is_null': { filter: { field: 'estimate', op: 'is_null' } },
    'estimate gte 3 (numeric string on client)': { filter: { field: 'estimate', op: 'gte', value: 3 }, sort: [{ field: 'estimate', dir: 'desc' }] },
    'bugs with severity in': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'bug' }, { field: 'fields.severity', op: 'in', value: ['s1', 's2'] }] } },
    'fields.severity eq': { filter: { field: 'fields.severity', op: 'eq', value: 's1' } },
    'fields.severity neq (missing key counts)': { filter: { field: 'fields.severity', op: 'neq', value: 's1' } },
    'fields.environment is_null': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'bug' }, { field: 'fields.environment', op: 'is_null' }] } },
    'fields.steps is_empty': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'bug' }, { field: 'fields.steps', op: 'is_empty' }] } },
    'fields.budget gte sorted desc': { filter: { field: 'fields.budget', op: 'gte', value: 8000 }, sort: [{ field: 'fields.budget', dir: 'desc' }] },
    'fields.approved eq true': { filter: { field: 'fields.approved', op: 'eq', value: true } },
    'fields.approved neq true': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'request' }, { field: 'fields.approved', op: 'neq', value: true }] } },
    'fields.tags has_any': { filter: { field: 'fields.tags', op: 'has_any', value: ['b', 'c'] } },
    'fields.tags has_all': { filter: { field: 'fields.tags', op: 'has_all', value: ['a', 'b'] } },
    'fields.tags has': { filter: { field: 'fields.tags', op: 'has', value: 'a' } },
    'fields.tags neq (not has)': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { field: 'fields.tags', op: 'neq', value: 'a' }] } },
    'fields.tags is_empty (missing or [])': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { field: 'fields.tags', op: 'is_empty' }] } },
    'fields.tags not_empty': { filter: { field: 'fields.tags', op: 'not_empty' } },
    'fields.links not_empty (multi url)': { filter: { field: 'fields.links', op: 'not_empty' } },
    'fields.review_date before today': { filter: { field: 'fields.review_date', op: 'before', value: '$today' }, sort: [{ field: 'fields.review_date', dir: 'asc' }] },
    'fields.review_date within 3 days': { filter: { field: 'fields.review_date', op: 'within_days', value: 3 } },
    'fields.go_live after now (datetime json)': { filter: { field: 'fields.go_live', op: 'after', value: '$now' } },
    'fields.weight range': { filter: { and: [{ field: 'fields.weight', op: 'gte', value: 2 }, { field: 'fields.weight', op: 'lt', value: 5 }] }, sort: [{ field: 'fields.weight', dir: 'asc' }] },
    'fields.owner eq $me (user kind)': { filter: { field: 'fields.owner', op: 'eq', value: '$me' } },
    'fields.unknown_key is_null (undefined key = text)': { filter: { field: 'fields.unknown_key', op: 'is_null' } },
    'labels has by name': { filter: { field: 'labels', op: 'has', value: 'Regulatory' } },
    'labels has by id': { filter: { field: 'labels', op: 'has', value: S.labelIds['tech-debt'] } },
    'labels has_any id + name': { filter: { field: 'labels', op: 'has_any', value: [S.labelIds['tech-debt'], 'quick-win'] } },
    'labels has_all': { filter: { field: 'labels', op: 'has_all', value: ['regulatory', 'tech-debt'] } },
    'labels is_empty': { filter: { field: 'labels', op: 'is_empty' } },
    'labels not_empty + nin': { filter: { and: [{ field: 'labels', op: 'not_empty' }, { field: 'labels', op: 'nin', value: ['audit'] }] } },
    'children of an initiative': { filter: { field: 'parent_id', op: 'eq', value: S.initiativeIds[0] } },
    'has parent': { filter: { field: 'parent_id', op: 'not_null' } },
    'blocked': { filter: { field: 'is_blocked', op: 'eq', value: true } },
    'not blocked': { filter: { field: 'is_blocked', op: 'neq', value: true } },
    'search match (explicit sort)': { filter: { field: 'search', op: 'match', value: 'collateral' }, sort: [{ field: 'key', dir: 'asc' }] },
    'search match + other filter': { filter: { and: [{ field: 'search', op: 'match', value: 'regulatory' }, { field: 'priority', op: 'gt', value: 0 }] }, sort: [{ field: 'priority', dir: 'asc' }] },
    'or / not nesting': { filter: { or: [{ field: 'priority', op: 'eq', value: 1 }, { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { not: { field: 'assignee_id', op: 'is_null' } }] }] } },
    'project.key + state.key': { filter: { and: [{ field: 'project.key', op: 'eq', value: 'TST' }, { field: 'state.key', op: 'in', value: ['in_progress', 'in_review'] }] } },
    'type_id in': { filter: { field: 'type_id', op: 'in', value: Object.values(S.lookups.types).filter((t) => t.key !== 'task').map((t) => t.id) } },
    'confidential': { filter: { field: 'confidential', op: 'eq', value: true } },
    'archived only, include_archived': { filter: { field: 'archived_at', op: 'not_null' }, include_archived: true },
    'archived excluded by default': { filter: { field: 'archived_at', op: 'not_null' }, expectEmpty: true },
    'limit/offset': { sort: [{ field: 'priority', dir: 'desc' }, { field: 'title', dir: 'asc' }], limit: 10, offset: 5 },
    'sort by workflow state order then estimate': { sort: [{ field: 'state_id', dir: 'asc' }, { field: 'estimate', dir: 'desc' }] },
    'sort by type order, category desc': { sort: [{ field: 'type_id', dir: 'asc' }, { field: 'state.category', dir: 'desc' }] },
    'sort by start_date desc nulls last': { sort: [{ field: 'start_date', dir: 'desc' }] },
    'group by state': { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }, group_by: 'state_id' },
    'group by assignee': { group_by: 'assignee_id', sort: [{ field: 'priority', dir: 'asc' }] },
    'group by priority': { group_by: 'priority', sort: [{ field: 'due_date', dir: 'asc' }] },
    'group by severity (json)': { filter: { field: 'type.key', op: 'eq', value: 'bug' }, group_by: 'fields.severity' },
    'group by category': { group_by: 'state.category' },
    'group by project with limit': { group_by: 'project_id', limit: 12 },
  };

  for (const [name, spec] of Object.entries(specs)) {
    it(name, async () => {
      const { expectEmpty, ...s } = spec;
      const [r, l] = [await remote(s), local(s)];
      expect(r).toEqual(l);
      if (expectEmpty) expect(r).toEqual([]);
      else expect(r.length, 'spec should match something so the test is meaningful').toBeGreaterThan(0);
    });
  }

  it('never returns the tombstoned row', async () => {
    const r = await remote({ include_archived: true });
    expect(r).not.toContain(S.items.find((i) => i.deleted_at)!.id);
    expect(r.length).toBe(39);
  });

  it('group_by exposes __group and groups agree', async () => {
    const spec: QuerySpec = { group_by: 'state_id', filter: { field: 'project.key', op: 'eq', value: 'TST' } };
    const q = compileQuery(spec, ctx, { fieldDefs: S.fieldDefs });
    const rows = await sql!.unsafe(q.text, q.values as never[]);
    const remoteGroups = [...new Set(rows.map((r) => r.__group as string))];
    const res = runSpec(spec, S.items, ctx, S.lookups);
    expect(remoteGroups).toEqual(res.groups!.map((g) => g.key));
    expect(res.groups!.every((g) => g.label && g.label !== g.key)).toBe(true);
  });

  it('search without sort orders by ts_rank (same set)', async () => {
    const spec: QuerySpec = { filter: { field: 'search', op: 'match', value: 'desk' } };
    const r = await remote(spec);
    const l = local(spec);
    expect(new Set(r)).toEqual(new Set(l));
    expect(r.length).toBeGreaterThan(0);
  });

  it('visibilityWhere scopes rows like can_view_item', async () => {
    const bobCtx: QueryContext = { userId: bob, tz: 'UTC', now, visibleProjectIds: [S.tst] };
    const q = compileQuery({}, bobCtx, { extraWhere: [visibilityWhere(bob, 0)] });
    expect(q.text).toContain('can_view_item(');
    const rows = await sql!.unsafe(q.text, q.values as never[]);
    const expected = runSpec({}, S.items, bobCtx, S.lookups).items
      .filter((i) => !i.confidential || i.assignee_id === bob || i.reporter_id === bob || i.created_by === bob)
      .map((i) => i.id);
    expect(rows.map((r) => r.id)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(39);
  });

  it('widget aggregates agree with local groups', async () => {
    const widgets: Widget[] = [
      { id: 'w1', title: 'Open by state', viz: 'bar', query: { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } }, group_by: 'state_id', measure: 'count', w: 4, h: 3 },
      { id: 'w2', title: 'Estimate by assignee', viz: 'bar', query: {}, group_by: 'assignee_id', measure: 'sum_estimate', w: 4, h: 3 },
      { id: 'w3', title: 'Overdue', viz: 'number', query: { filter: { and: [{ field: 'due_date', op: 'before', value: '$today' }, { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }] } }, measure: 'count', w: 2, h: 2 },
      { id: 'w4', title: 'Budget by quarter', viz: 'pie', query: { filter: { field: 'type.key', op: 'eq', value: 'initiative' } }, group_by: 'fields.quarter', measure: 'sum_field', measure_field: 'fields.budget', w: 4, h: 3 },
      { id: 'w5', title: 'Due per week', viz: 'line', query: { filter: { field: 'due_date', op: 'not_null' } }, group_by: 'due_date', time_bucket: 'week', measure: 'count', w: 6, h: 3 },
    ];
    for (const w of widgets) {
      const q = compileWidget(w, ctx, { fieldDefs: S.fieldDefs });
      expect(q.isAggregate).toBe(true);
      const rows = await sql!.unsafe(q.text, q.values as never[]);
      const localRows = S.items.filter((i) => matchesSpec(w.query, i, ctx, S.lookups));
      if (!w.group_by) {
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]!.value)).toBe(localRows.length);
        continue;
      }
      const res = runSpec({ ...w.query, group_by: w.time_bucket ? undefined : w.group_by }, S.items, ctx, S.lookups);
      if (w.time_bucket) {
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.reduce((a, r) => a + Number(r.value), 0)).toBe(localRows.length);
        continue;
      }
      const localMap = new Map(res.groups!.map((g) => [g.key, g.items]));
      expect(new Set(rows.map((r) => r.key ?? ''))).toEqual(new Set(localMap.keys()));
      for (const r of rows) {
        const gi = localMap.get(r.key ?? '')!;
        if (w.measure === 'count') expect(Number(r.value)).toBe(gi.length);
        if (w.measure === 'sum_estimate') expect(Number(r.value)).toBeCloseTo(gi.reduce((a, i) => a + Number(i.estimate ?? 0), 0), 6);
        if (w.measure === 'sum_field') expect(Number(r.value)).toBeCloseTo(gi.reduce((a, i) => a + Number(i.fields.budget ?? 0), 0), 6);
      }
      // ordered by value desc
      const values = rows.map((r) => Number(r.value));
      expect(values).toEqual([...values].sort((a, b) => b - a));
    }
  });
});
