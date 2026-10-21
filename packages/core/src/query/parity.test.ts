// Parity test: the SQL compiler and the client-side evaluator must return the
// same ids in the same order for every QuerySpec. Runs against an in-memory
// SQLite database (node:sqlite via @pm/db) with the real migration applied, so
// it needs no external services and runs everywhere.
//
// Rows are loaded from work_items_v through the same @pm/db runtime the API
// uses (JSON columns parsed, is_*/confidential booleans, label_names arrays), so
// the evaluator sees exactly what a synced client would.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openDb } from '@pm/db';
import { compileQuery, compileWidget, visibilityWhere } from './compile.js';
import { runSpec, matchesSpec, type ItemRow, type EvalLookups } from './evaluate.js';
import { addDays, dateInTz, timeBucket } from './common.js';
import type { QuerySpec, QueryContext, Widget } from './spec.js';
import type { FieldDef, WorkflowState, ItemType, Project, Label, User } from '../schema/entities.js';

const MIGRATION = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations/0001_init.sql');

const uid = () => crypto.randomUUID();
const now = new Date();
const nowIso = now.toISOString();
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
  users: User[];
}

const EXTRA_TASK_DEFS: FieldDef[] = [
  { key: 'tags', label: 'Tags', kind: 'multi_select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] },
  { key: 'review_date', label: 'Review date', kind: 'date' },
  { key: 'owner', label: 'Owner', kind: 'user' },
  { key: 'links', label: 'Links', kind: 'url', multi: true },
  { key: 'weight', label: 'Weight', kind: 'number' },
  { key: 'go_live', label: 'Go live', kind: 'datetime' },
];

const sql = openDb(':memory:');
sql.exec(readFileSync(MIGRATION, 'utf8'));

function seed(): Seeded {
  sql`update item_types set field_defs = ${JSON.stringify(EXTRA_TASK_DEFS)} where key = 'task'`.run();

  sql`insert into users (id, email, name, firm_role) values
    (${alice}, 'alice@test.com', 'Alice', 'owner'),
    (${bob}, 'bob@test.com', 'Bob', 'member'),
    (${carol}, 'carol@test.com', 'Carol', 'member')`.run();
  const tst = uid(), sec = uid();
  sql`insert into projects (id, key, name, visibility, lead_id) values
    (${tst}, 'TST', 'Test project', 'firm', ${alice}),
    (${sec}, 'SEC', 'Secret project', 'private', ${alice})`.run();
  sql`insert into project_members (project_id, user_id, role) values (${sec}, ${alice}, 'admin')`.run();

  const labelIds: Record<string, string> = { regulatory: uid(), 'tech-debt': uid(), 'quick-win': uid(), audit: uid() };
  sql`insert into labels (id, project_id, name, color) values
    (${labelIds.regulatory!}, null, 'regulatory', '#f00'),
    (${labelIds['tech-debt']!}, null, 'tech-debt', '#0f0'),
    (${labelIds['quick-win']!}, ${tst}, 'quick-win', '#00f'),
    (${labelIds.audit!}, ${sec}, 'audit', '#ff0')`.run();

  const typeRows = sql.unsafe<ItemType>('select * from item_types where deleted_at is null').all();
  const stateRows = sql.unsafe<WorkflowState>('select * from workflow_states where deleted_at is null order by workflow_id, sort').all();
  const typeByKey = Object.fromEntries(typeRows.map((t) => [t.key, t]));
  const statesOf = (t: ItemType) => stateRows.filter((s) => s.workflow_id === t.workflow_id);

  const nouns = ['swaption pricer', 'collateral feed', 'repo blotter', 'curve builder', 'risk report', 'vol surface', 'trade capture', 'margin call'];
  const verbs = ['Migrate', 'Fix', 'Review', 'Build', 'Retire', 'Automate'];
  const ids: string[] = [];
  const initiativeIds: string[] = [];
  const users = [alice, bob, carol, null];
  const seq: Record<string, number> = { [tst]: 0, [sec]: 0 };
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  for (let i = 0; i < 40; i++) {
    const typeKey = i % 8 === 0 ? 'initiative' : i % 3 === 0 ? 'bug' : i % 5 === 0 ? 'request' : 'task';
    const type = typeByKey[typeKey]!;
    const states = statesOf(type);
    const state = states[(i * 5) % states.length]!;
    const id = uid();
    ids.push(id);
    if (typeKey === 'initiative') initiativeIds.push(id);
    const project = i % 4 === 3 ? sec : tst;
    let fields: Record<string, unknown> = {};
    if (typeKey === 'bug') fields = { severity: ['s1', 's2', 's3', 's4'][i % 4], environment: i % 2 ? 'prod' : null, steps: i % 2 ? `Step ${i}: reproduce` : '' };
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
    let title = `${verbs[i % verbs.length]} ${nouns[i % nouns.length]} ${i}`;
    if (i % 11 === 5) title = title.toLowerCase(); // mixed case: text sorts/filters must be case-insensitive on both sides
    const description = i % 2 ? `Work on the ${nouns[i % nouns.length]} for the desk. ${i % 6 === 1 ? 'Needs regulatory sign-off.' : ''}` : '';
    // number/key given explicitly: the assign_item_number trigger would otherwise UPDATE the
    // row and the version trigger would reset updated_at to now.
    const n = ++seq[project]!;
    const key = `${project === sec ? 'SEC' : 'TST'}-${n}`;
    sql`insert into work_items (id, project_id, type_id, number, key, title, description, state_id, priority, assignee_id, reporter_id, created_by,
        start_date, due_date, estimate, fields, confidential, sort_order, created_at, updated_at, completed_at, canceled_at, archived_at)
      values (${id}, ${project}, ${type.id}, ${n}, ${key}, ${title}, ${description}, ${state.id}, ${i % 5}, ${users[i % 4]!}, ${users[(i + 1) % 4]!}, ${alice},
        ${startDate}, ${dueDate}, ${estimate}, ${JSON.stringify(fields)}, ${i % 10 === 7 ? 1 : 0}, ${(i * 13) % 7},
        ${iso(createdAt)}, ${iso(updatedAt)}, ${iso(completedAt)}, ${iso(canceledAt)}, ${i === 21 || i === 22 ? nowIso : null})`.run();
  }
  // tombstone one row: must never appear anywhere
  sql`update work_items set deleted_at = ${nowIso} where id = ${ids[23]!}`.run();

  // labels
  for (let i = 0; i < 40; i++) {
    const id = ids[i]!;
    const names: string[] = [];
    if (i % 3 === 0) names.push('regulatory');
    if (i % 4 === 0) names.push('tech-debt');
    if (i % 5 === 0) names.push('quick-win');
    if (i % 7 === 0) names.push('audit');
    for (const n of names) sql`insert into work_item_labels (item_id, label_id) values (${id}, ${labelIds[n]!})`.run();
  }
  // relations: initiatives parent their next three items; some blocks; a duplicate; an external link
  for (const init of [0, 8, 16, 24, 32]) {
    for (let k = 1; k <= 3; k++) {
      sql`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uid()}, 'parent_of', ${ids[init]!}, ${ids[init + k]!}, ${alice})`.run();
    }
  }
  for (const [a, b] of [[1, 2], [9, 10], [17, 18], [33, 34], [4, 6], [12, 13]]) {
    sql`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uid()}, 'blocks', ${ids[a!]!}, ${ids[b!]!}, ${alice})`.run();
  }
  sql`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uid()}, 'duplicates', ${ids[11]!}, ${ids[12]!}, ${alice})`.run();
  sql`insert into relations (id, type, from_item_id, external_kind, external_ref, created_by) values (${uid()}, 'links_to', ${ids[13]!}, 'github_pr', ${JSON.stringify({ url: 'https://github.com/org/repo/pull/7', number: 7 })}, ${alice})`.run();

  // ---- load what the client would have (same runtime hydration as the API) --
  const items = sql.unsafe<ItemRow>('select * from work_items_v').all();
  const projects = sql.unsafe<Project>('select * from projects').all();
  const labels = sql.unsafe<Label>('select * from labels').all();
  const userRows = sql.unsafe<User>('select * from users').all();
  const wil = sql.unsafe<{ item_id: string; label_id: string }>('select item_id, label_id from work_item_labels where deleted_at is null').all();
  const parents = sql.unsafe<{ item_id: string; parent_id: string }>('select item_id, parent_id from item_parents').all();
  const blocked = sql.unsafe<{ item_id: string }>('select distinct item_id from open_blockers').all();
  const labelIdsByItem: Record<string, string[]> = {};
  for (const r of wil) (labelIdsByItem[r.item_id] ??= []).push(r.label_id);
  const lookups: EvalLookups = {
    states: Object.fromEntries(stateRows.map((s) => [s.id, s])),
    types: Object.fromEntries(typeRows.map((t) => [t.id, t])),
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    labels: Object.fromEntries(labels.map((l) => [l.id, l])),
    users: Object.fromEntries(userRows.map((u) => [u.id, u])),
    labelIdsByItem,
    parentByItem: Object.fromEntries(parents.map((p) => [p.item_id, p.parent_id])),
    blockedItems: new Set(blocked.map((b) => b.item_id)),
  };
  const fieldDefs = Object.fromEntries(typeRows.map((t) => [t.key, t.field_defs]));
  return { items, lookups, fieldDefs, tst, sec, labelIds, initiativeIds, users: userRows };
}

describe('SQL compiler ⇔ local evaluator parity (SQLite)', () => {
  const S = seed();
  afterAll(() => { sql.close(); });

  const local = (spec: QuerySpec, c: QueryContext = ctx) => runSpec(spec, S.items, c, S.lookups).items.map((i) => i.id);
  const remote = (spec: QuerySpec, c: QueryContext = ctx) => {
    const q = compileQuery(spec, c, { fieldDefs: S.fieldDefs });
    return sql.unsafe(q.text, q.values).all().map((r) => r.id as string);
  };

  it('seeded rows are hydrated the way the client stores them', () => {
    expect(S.items).toHaveLength(40);
    const task = S.items.find((i) => i.type_key === 'task' && Array.isArray(i.fields.tags))!;
    expect(typeof task.fields).toBe('object');
    expect(Array.isArray(task.label_names)).toBe(true);
    expect(typeof task.is_blocked).toBe('boolean');
    expect(typeof task.confidential).toBe('boolean');
    expect(typeof task.estimate === 'number' || task.estimate === null).toBe(true);
    expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(S.items.filter((i) => i.deleted_at)).toHaveLength(1);
    expect(S.items.filter((i) => i.archived_at)).toHaveLength(2);
    expect(S.items.filter((i) => i.confidential)).toHaveLength(4);
    expect(S.lookups.blockedItems!.size).toBeGreaterThan(0);
  });

  const specs: Record<string, QuerySpec & { expectEmpty?: boolean }> = {
    'default sort': {},
    'open items (category nin)': { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } },
    'done, newest completion first': { filter: { field: 'state.category', op: 'in', value: ['done'] }, sort: [{ field: 'completed_at', dir: 'desc' }] },
    'category lt done (lifecycle order, not alphabetical)': { filter: { field: 'state.category', op: 'lt', value: 'done' }, sort: [{ field: 'state.category', dir: 'asc' }] },
    'category gte in_progress': { filter: { field: 'state.category', op: 'gte', value: 'in_progress' } },
    'assigned to $me': { filter: { field: 'assignee_id', op: 'eq', value: '$me' } },
    'unassigned': { filter: { field: 'assignee_id', op: 'is_null' } },
    'neq includes nulls': { filter: { field: 'assignee_id', op: 'neq', value: alice } },
    'nin includes nulls': { filter: { field: 'assignee_id', op: 'nin', value: [alice, bob] } },
    'nin with null element excludes nulls': { filter: { field: 'assignee_id', op: 'nin', value: [alice, null] } },
    'in with null element': { filter: { field: 'assignee_id', op: 'in', value: [carol, null] } },
    'key eq': { filter: { field: 'key', op: 'eq', value: 'TST-3' } },
    'number in (both projects)': { filter: { field: 'number', op: 'in', value: [1, 2, 3] }, sort: [{ field: 'project.key', dir: 'asc' }, { field: 'number', dir: 'asc' }] },
    'priority lte + sort nulls first': { filter: { field: 'priority', op: 'lte', value: 2 }, sort: [{ field: 'priority', dir: 'asc' }, { field: 'due_date', dir: 'asc', nulls: 'first' }] },
    'overdue': { filter: { and: [{ field: 'due_date', op: 'before', value: '$today' }, { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }] }, sort: [{ field: 'due_date', dir: 'asc' }] },
    'due within 7 days': { filter: { field: 'due_date', op: 'within_days', value: 7 }, sort: [{ field: 'due_date', dir: 'asc' }, { field: 'priority', dir: 'desc' }] },
    'due in the past 4 days (negative window)': { filter: { field: 'due_date', op: 'within_days', value: -4 } },
    'due after today': { filter: { field: 'due_date', op: 'after', value: '$today' } },
    'due by end of week': { filter: { field: 'due_date', op: 'lte', value: '$end_of_week' } },
    'completed last 30 days': { filter: { field: 'completed_at', op: 'within_days', value: -30 } },
    'created within 2 days (datetime window)': { filter: { field: 'created_at', op: 'within_days', value: -2 } },
    'completed before today (datetime vs date macro)': { filter: { field: 'completed_at', op: 'before', value: '$today' } },
    'updated since instant': { filter: { field: 'updated_at', op: 'gt', value: new Date(now.getTime() - 10 * 3600_000).toISOString() }, sort: [{ field: 'updated_at', dir: 'desc' }] },
    'created this month / week macros': { filter: { or: [{ field: 'created_at', op: 'gte', value: '$start_of_week' }, { field: 'created_at', op: 'lt', value: '$start_of_month' }] } },
    'title contains (case-insensitive)': { filter: { field: 'title', op: 'contains', value: 'SWAPTION' }, sort: [{ field: 'title', dir: 'asc' }] },
    'title starts_with': { filter: { field: 'title', op: 'starts_with', value: 'fix' }, sort: [{ field: 'title', dir: 'desc' }] },
    'title gt (case-insensitive text comparison)': { filter: { field: 'title', op: 'gt', value: 'm' }, sort: [{ field: 'title', dir: 'asc' }] },
    'sort by title (mixed case)': { sort: [{ field: 'title', dir: 'asc' }] },
    'key starts_with SEC-': { filter: { field: 'key', op: 'starts_with', value: 'SEC-' }, sort: [{ field: 'number', dir: 'asc' }] },
    'like metachars are escaped': { filter: { field: 'title', op: 'contains', value: '100%' }, expectEmpty: true },
    'description is_empty': { filter: { field: 'description', op: 'is_empty' } },
    'description not_empty': { filter: { field: 'description', op: 'not_empty' } },
    'estimate is_null': { filter: { field: 'estimate', op: 'is_null' } },
    'estimate gte 3': { filter: { field: 'estimate', op: 'gte', value: 3 }, sort: [{ field: 'estimate', dir: 'desc' }] },
    'estimate has_all (scalar all-eq)': { filter: { field: 'estimate', op: 'has_all', value: [3.5] } },
    'bugs with severity in': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'bug' }, { field: 'fields.severity', op: 'in', value: ['s1', 's2'] }] } },
    'fields.severity eq': { filter: { field: 'fields.severity', op: 'eq', value: 's1' } },
    'fields.severity neq (missing key counts)': { filter: { field: 'fields.severity', op: 'neq', value: 's1' } },
    'fields.severity nin (missing key counts)': { filter: { field: 'fields.severity', op: 'nin', value: ['s1', 's2'] } },
    'fields.environment is_null': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'bug' }, { field: 'fields.environment', op: 'is_null' }] } },
    'fields.steps is_empty': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'bug' }, { field: 'fields.steps', op: 'is_empty' }] } },
    'fields.steps starts_with': { filter: { field: 'fields.steps', op: 'starts_with', value: 'STEP 1' } },
    'fields.budget gte sorted desc': { filter: { field: 'fields.budget', op: 'gte', value: 8000 }, sort: [{ field: 'fields.budget', dir: 'desc' }] },
    'fields.approved eq true': { filter: { field: 'fields.approved', op: 'eq', value: true } },
    'fields.approved neq true': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'request' }, { field: 'fields.approved', op: 'neq', value: true }] } },
    'fields.tags has_any': { filter: { field: 'fields.tags', op: 'has_any', value: ['b', 'c'] } },
    'fields.tags has_all': { filter: { field: 'fields.tags', op: 'has_all', value: ['a', 'b'] } },
    'fields.tags has': { filter: { field: 'fields.tags', op: 'has', value: 'a' } },
    'fields.tags nin': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { field: 'fields.tags', op: 'nin', value: ['b', 'c'] }] } },
    'fields.tags neq (not has)': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { field: 'fields.tags', op: 'neq', value: 'a' }] } },
    'fields.tags is_empty (missing or [])': { filter: { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { field: 'fields.tags', op: 'is_empty' }] } },
    'fields.tags not_empty': { filter: { field: 'fields.tags', op: 'not_empty' } },
    'fields.tags contains (json text)': { filter: { field: 'fields.tags', op: 'contains', value: 'B' } },
    'fields.links not_empty (multi url)': { filter: { field: 'fields.links', op: 'not_empty' } },
    'fields.links starts_with (element prefix)': { filter: { field: 'fields.links', op: 'starts_with', value: 'HTTPS://github' } },
    'fields.review_date before today': { filter: { field: 'fields.review_date', op: 'before', value: '$today' }, sort: [{ field: 'fields.review_date', dir: 'asc' }] },
    'fields.review_date within 3 days': { filter: { field: 'fields.review_date', op: 'within_days', value: 3 } },
    'fields.go_live after now (datetime json)': { filter: { field: 'fields.go_live', op: 'after', value: '$now' } },
    'fields.go_live within past 30 days (datetime json window)': { filter: { field: 'fields.go_live', op: 'within_days', value: -30 } },
    'fields.weight range': { filter: { and: [{ field: 'fields.weight', op: 'gte', value: 2 }, { field: 'fields.weight', op: 'lt', value: 5 }] }, sort: [{ field: 'fields.weight', dir: 'asc' }] },
    'fields.owner eq $me (user kind)': { filter: { field: 'fields.owner', op: 'eq', value: '$me' } },
    'fields.unknown_key is_null (undefined key = text)': { filter: { field: 'fields.unknown_key', op: 'is_null' } },
    'labels has by name': { filter: { field: 'labels', op: 'has', value: 'Regulatory' } },
    'labels has by id': { filter: { field: 'labels', op: 'has', value: S.labelIds['tech-debt'] } },
    'labels neq': { filter: { field: 'labels', op: 'neq', value: 'regulatory' } },
    'labels has_any id + name': { filter: { field: 'labels', op: 'has_any', value: [S.labelIds['tech-debt'], 'quick-win'] } },
    'labels has_all': { filter: { field: 'labels', op: 'has_all', value: ['regulatory', 'tech-debt'] } },
    'labels is_empty': { filter: { field: 'labels', op: 'is_empty' } },
    'labels not_empty + nin': { filter: { and: [{ field: 'labels', op: 'not_empty' }, { field: 'labels', op: 'nin', value: ['audit'] }] } },
    'children of an initiative': { filter: { field: 'parent_id', op: 'eq', value: S.initiativeIds[0] } },
    'has parent': { filter: { field: 'parent_id', op: 'not_null' } },
    'blocked': { filter: { field: 'is_blocked', op: 'eq', value: true } },
    'not blocked': { filter: { field: 'is_blocked', op: 'neq', value: true } },
    'sort by blocked first': { sort: [{ field: 'is_blocked', dir: 'desc' }, { field: 'key', dir: 'asc' }] },
    'search match (explicit sort)': { filter: { field: 'search', op: 'match', value: 'collateral' }, sort: [{ field: 'key', dir: 'asc' }] },
    'search match two words (implicit AND)': { filter: { field: 'search', op: 'match', value: 'Collateral FEED' }, sort: [{ field: 'key', dir: 'asc' }] },
    'search match + other filter': { filter: { and: [{ field: 'search', op: 'match', value: 'regulatory' }, { field: 'priority', op: 'gt', value: 0 }] }, sort: [{ field: 'priority', dir: 'asc' }] },
    'search match nothing': { filter: { field: 'search', op: 'match', value: 'zyxwv' }, expectEmpty: true },
    'or / not nesting': { filter: { or: [{ field: 'priority', op: 'eq', value: 1 }, { and: [{ field: 'type.key', op: 'eq', value: 'task' }, { not: { field: 'assignee_id', op: 'is_null' } }] }] } },
    'not (or)': { filter: { not: { or: [{ field: 'type.key', op: 'eq', value: 'task' }, { field: 'labels', op: 'has', value: 'regulatory' }] } } },
    'project.key + state.key': { filter: { and: [{ field: 'project.key', op: 'eq', value: 'TST' }, { field: 'state.key', op: 'in', value: ['in_progress', 'in_review'] }] } },
    'type_id in': { filter: { field: 'type_id', op: 'in', value: Object.values(S.lookups.types).filter((t) => t.key !== 'task').map((t) => t.id) } },
    'confidential': { filter: { field: 'confidential', op: 'eq', value: true } },
    'not confidential (neq false excludes nothing but confidential)': { filter: { field: 'confidential', op: 'neq', value: true } },
    'archived only, include_archived': { filter: { field: 'archived_at', op: 'not_null' }, include_archived: true },
    'archived excluded by default': { filter: { field: 'archived_at', op: 'not_null' }, expectEmpty: true },
    'limit/offset': { sort: [{ field: 'priority', dir: 'desc' }, { field: 'title', dir: 'asc' }], limit: 10, offset: 5 },
    'offset without limit': { sort: [{ field: 'key', dir: 'asc' }], offset: 30 },
    'sort by workflow state order then estimate': { sort: [{ field: 'state_id', dir: 'asc' }, { field: 'estimate', dir: 'desc' }] },
    'sort by type order, category desc': { sort: [{ field: 'type_id', dir: 'asc' }, { field: 'state.category', dir: 'desc' }] },
    'sort by start_date desc nulls last': { sort: [{ field: 'start_date', dir: 'desc' }] },
    'sort by json number desc, nulls first': { sort: [{ field: 'fields.weight', dir: 'desc', nulls: 'first' }, { field: 'key', dir: 'asc' }] },
    'sort by json datetime': { sort: [{ field: 'fields.go_live', dir: 'asc' }] },
    'sort by assignee (uuid) and project key': { sort: [{ field: 'assignee_id', dir: 'asc' }, { field: 'project.key', dir: 'desc' }] },
    'group by state': { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }, group_by: 'state_id' },
    'group by assignee': { group_by: 'assignee_id', sort: [{ field: 'priority', dir: 'asc' }] },
    'group by priority': { group_by: 'priority', sort: [{ field: 'due_date', dir: 'asc' }] },
    'group by severity (json)': { filter: { field: 'type.key', op: 'eq', value: 'bug' }, group_by: 'fields.severity' },
    'group by category': { group_by: 'state.category' },
    'group by type': { group_by: 'type_id', sort: [{ field: 'title', dir: 'desc' }] },
    'group by is_blocked': { group_by: 'is_blocked' },
    'group by parent': { group_by: 'parent_id' },
    'group by project with limit': { group_by: 'project_id', limit: 12 },
    'kitchen sink (json in + labels + search + group)': {
      filter: { or: [{ field: 'fields.severity', op: 'in', value: ['s1'] }, { field: 'labels', op: 'has', value: 'regulatory' }, { field: 'search', op: 'match', value: 'curve' }] },
      group_by: 'state_id', sort: [{ field: 'key', dir: 'asc' }],
    },
  };

  for (const [name, spec] of Object.entries(specs)) {
    it(name, () => {
      const { expectEmpty, ...s } = spec;
      const [r, l] = [remote(s), local(s)];
      expect(r).toEqual(l);
      if (expectEmpty) expect(r).toEqual([]);
      else expect(r.length, 'spec should match something so the test is meaningful').toBeGreaterThan(0);
    });
  }

  it('time-zone aware specs agree in America/New_York and Asia/Tokyo', () => {
    for (const tz of ['America/New_York', 'Asia/Tokyo']) {
      const c: QueryContext = { ...ctx, tz };
      const tzSpecs: QuerySpec[] = [
        { filter: { field: 'due_date', op: 'before', value: '$today' } },
        { filter: { field: 'due_date', op: 'within_days', value: 3 } },
        { filter: { field: 'completed_at', op: 'within_days', value: -30 } },
        { filter: { field: 'completed_at', op: 'before', value: '$today' } },
        { filter: { field: 'created_at', op: 'gte', value: '$start_of_week' } },
        { filter: { field: 'fields.go_live', op: 'after', value: '$today' } },
        { filter: { field: 'fields.review_date', op: 'within_days', value: 3 } },
      ];
      for (const s of tzSpecs) expect(remote(s, c), `${tz} ${JSON.stringify(s)}`).toEqual(local(s, c));
    }
  });

  it('never returns the tombstoned row', () => {
    const r = remote({ include_archived: true });
    expect(r).not.toContain(S.items.find((i) => i.deleted_at)!.id);
    expect(r.length).toBe(39);
  });

  it('group_by exposes __group and groups agree (uuid, number and boolean keys)', () => {
    for (const spec of [
      { group_by: 'state_id', filter: { field: 'project.key', op: 'eq', value: 'TST' } },
      { group_by: 'priority' },
      { group_by: 'is_blocked' },
      { group_by: 'fields.severity', filter: { field: 'type.key', op: 'eq', value: 'bug' } },
    ] satisfies QuerySpec[]) {
      const q = compileQuery(spec, ctx, { fieldDefs: S.fieldDefs });
      const rows = sql.unsafe(q.text, q.values).all();
      const remoteGroups = [...new Set(rows.map((r) => (r.__group === null ? '' : String(r.__group))))];
      const res = runSpec(spec, S.items, ctx, S.lookups);
      expect(remoteGroups, spec.group_by).toEqual(res.groups!.map((g) => g.key));
      expect(res.groups!.length).toBeGreaterThan(1);
    }
    const named = runSpec({ group_by: 'state_id' }, S.items, ctx, S.lookups);
    expect(named.groups!.every((g) => g.label && g.label !== g.key)).toBe(true);
  });

  it('search without sort orders by bm25 (same set; FTS word match vs local substring agree on whole words)', () => {
    for (const term of ['desk', 'curve', 'Regulatory sign-off']) {
      const spec: QuerySpec = { filter: { field: 'search', op: 'match', value: term } };
      const q = compileQuery(spec, ctx, { fieldDefs: S.fieldDefs });
      expect(q.text).toContain('bm25(');
      const r = sql.unsafe(q.text, q.values).all().map((x) => x.id as string);
      const l = local(spec);
      expect(new Set(r), term).toEqual(new Set(l));
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('search text is never parsed as FTS syntax', () => {
    for (const term of ['curve AND', 'a" OR 1=1', '(unbalanced', 'NEAR/3 x', 'col*']) {
      expect(() => remote({ filter: { field: 'search', op: 'match', value: term } })).not.toThrow();
    }
  });

  it('visibilityWhere scopes rows like the visible_items view (owner sees all, member sees firm projects minus others\' confidential items)', () => {
    const userById = Object.fromEntries(S.users.map((u) => [u.id, u]));
    const projectsById = S.lookups.projects;
    const membership: Record<string, Record<string, string>> = { [S.sec]: { [alice]: 'admin' } };
    const roleOf = (userId: string, projectId: string): string | null => {
      const u = userById[userId]!, p = projectsById[projectId]!;
      const explicit = membership[projectId]?.[userId];
      if (explicit) return explicit;
      if (u.firm_role === 'owner' || u.firm_role === 'admin') return 'admin';
      if (u.firm_role === 'member' && p.visibility === 'firm') return 'editor';
      return null;
    };
    const canSee = (userId: string, i: ItemRow) => {
      const role = roleOf(userId, i.project_id);
      if (!role) return false;
      return !i.confidential || i.assignee_id === userId || i.reporter_id === userId || i.created_by === userId || role === 'admin';
    };
    for (const [userId, visibleProjectIds] of [[alice, undefined], [bob, undefined], [bob, [S.tst]], [carol, 'all']] as const) {
      const c: QueryContext = { userId, tz: 'UTC', now, ...(visibleProjectIds ? { visibleProjectIds: visibleProjectIds as string[] | 'all' } : {}) };
      const q = compileQuery({ include_archived: true }, c, { extraWhere: [visibilityWhere(userId, 0)] });
      expect(q.text).toContain('exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id)');
      const rows = sql.unsafe(q.text, q.values).all().map((r) => r.id as string);
      const expected = runSpec({ include_archived: true }, S.items.filter((i) => canSee(userId, i)), c, S.lookups).items.map((i) => i.id);
      expect(rows, userById[userId]!.name).toEqual(expected);
      if (userId === alice) expect(rows).toHaveLength(39);
      else { expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThan(39); }
    }
    // the view itself agrees with the local rule for every (user, item) pair
    const vi = sql.unsafe<{ user_id: string; item_id: string }>('select user_id, item_id from visible_items').all();
    const viSet = new Set(vi.map((r) => `${r.user_id}|${r.item_id}`));
    for (const u of [alice, bob, carol]) for (const i of S.items) {
      expect(viSet.has(`${u}|${i.id}`), `${userById[u]!.name} / ${i.key}`).toBe(!i.deleted_at && canSee(u, i));
    }
  });

  it('widget aggregates agree with local groups and UTC time buckets', () => {
    const widgets: Widget[] = [
      { id: 'w1', title: 'Open by state', viz: 'bar', query: { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } }, group_by: 'state_id', measure: 'count', w: 4, h: 3 },
      { id: 'w2', title: 'Estimate by assignee', viz: 'bar', query: {}, group_by: 'assignee_id', measure: 'sum_estimate', w: 4, h: 3 },
      { id: 'w3', title: 'Overdue', viz: 'number', query: { filter: { and: [{ field: 'due_date', op: 'before', value: '$today' }, { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }] } }, measure: 'count', w: 2, h: 2 },
      { id: 'w4', title: 'Budget by quarter', viz: 'pie', query: { filter: { field: 'type.key', op: 'eq', value: 'initiative' } }, group_by: 'fields.quarter', measure: 'sum_field', measure_field: 'fields.budget', w: 4, h: 3 },
      { id: 'w5', title: 'Due per week', viz: 'line', query: { filter: { field: 'due_date', op: 'not_null' } }, group_by: 'due_date', time_bucket: 'week', measure: 'count', w: 6, h: 3 },
      { id: 'w6', title: 'Created per day', viz: 'line', query: {}, group_by: 'created_at', time_bucket: 'day', measure: 'count', w: 6, h: 3 },
      { id: 'w7', title: 'Completed per month', viz: 'line', query: {}, group_by: 'completed_at', time_bucket: 'month', measure: 'count', w: 6, h: 3 },
      { id: 'w8', title: 'Avg weight by blocked', viz: 'bar', query: { filter: { field: 'type.key', op: 'eq', value: 'task' } }, group_by: 'is_blocked', measure: 'avg_field', measure_field: 'fields.weight', w: 4, h: 3 },
    ];
    for (const w of widgets) {
      const q = compileWidget(w, ctx, { fieldDefs: S.fieldDefs });
      expect(q.isAggregate).toBe(true);
      const rows = sql.unsafe(q.text, q.values).all();
      const localRows = S.items.filter((i) => matchesSpec(w.query, i, ctx, S.lookups));
      if (!w.group_by) {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.key).toBeNull();
        expect(Number(rows[0]!.value)).toBe(localRows.length);
        continue;
      }
      if (w.time_bucket) {
        const buckets = new Map<string, number>();
        for (const i of localRows) {
          const k = timeBucket((i as unknown as Record<string, unknown>)[w.group_by], w.time_bucket) ?? '';
          buckets.set(k, (buckets.get(k) ?? 0) + 1);
        }
        expect(new Map(rows.map((r) => [r.key ?? '', Number(r.value)])), w.id).toEqual(buckets);
        expect(rows.length).toBeGreaterThan(1);
        // ordered by bucket asc, nulls last
        const keys = rows.map((r) => r.key as string | null);
        const nonNull = keys.filter((k): k is string => k !== null);
        expect(nonNull).toEqual([...nonNull].sort());
        if (keys.includes(null)) expect(keys.at(-1)).toBeNull();
        continue;
      }
      const res = runSpec({ ...w.query, group_by: w.group_by }, S.items, ctx, S.lookups);
      const localMap = new Map(res.groups!.map((g) => [g.key, g.items]));
      expect(new Set(rows.map((r) => (r.key === null ? '' : String(r.key)))), w.id).toEqual(new Set(localMap.keys()));
      for (const r of rows) {
        const gi = localMap.get(r.key === null ? '' : String(r.key))!;
        if (w.measure === 'count') expect(Number(r.value)).toBe(gi.length);
        if (w.measure === 'sum_estimate') expect(Number(r.value)).toBeCloseTo(gi.reduce((a, i) => a + Number(i.estimate ?? 0), 0), 6);
        if (w.measure === 'sum_field') expect(Number(r.value)).toBeCloseTo(gi.reduce((a, i) => a + Number(i.fields.budget ?? 0), 0), 6);
        if (w.measure === 'avg_field') {
          const ws = gi.map((i) => i.fields.weight).filter((x): x is number => typeof x === 'number');
          expect(Number(r.value)).toBeCloseTo(ws.reduce((a, b) => a + b, 0) / ws.length, 6);
        }
      }
      // ordered by value desc
      const values = rows.map((r) => Number(r.value));
      expect(values).toEqual([...values].sort((a, b) => b - a));
    }
  });

  it('widgets honour the visibility scope', () => {
    const w: Widget = { id: 'v', title: 'All', viz: 'number', query: { include_archived: true }, measure: 'count', w: 2, h: 2 };
    for (const [userId, expected] of [[alice, 39], [bob, remote({ include_archived: true }, { userId: bob, tz: 'UTC', now, visibleProjectIds: [S.tst] }).filter((id) => { const i = S.items.find((x) => x.id === id)!; return !i.confidential || i.assignee_id === bob || i.reporter_id === bob || i.created_by === bob; }).length]] as const) {
      const q = compileWidget(w, { userId, tz: 'UTC', now }, { extraWhere: [visibilityWhere(userId, 0)] });
      expect(Number(sql.unsafe(q.text, q.values).get()!.value)).toBe(expected);
    }
  });
});
