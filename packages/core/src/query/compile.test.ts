import { describe, it, expect } from 'vitest';
import { compileQuery, compileWidget, visibilityWhere, ftsQuery, toSqlParam } from './compile.js';
import { timeBucket } from './common.js';
import type { QueryContext, QuerySpec } from './spec.js';
import type { FieldDef } from '../schema/entities.js';

const ctx: QueryContext = { userId: 'u-1', tz: 'UTC', now: new Date('2026-10-15T12:00:00Z') };
const fieldDefs: Record<string, FieldDef[]> = {
  bug: [{ key: 'severity', label: 'Severity', kind: 'select', options: [{ value: 's1', label: 'S1' }] }, { key: 'budget', label: 'Budget', kind: 'number' }],
  task: [{ key: 'tags', label: 'Tags', kind: 'multi_select' }, { key: 'review_date', label: 'Review', kind: 'date' }, { key: 'approved', label: 'Approved', kind: 'bool' }],
};

/** Every `?` in the text must have exactly one value (and nothing else is interpolated). */
const placeholders = (text: string) => (text.match(/\?/g) ?? []).length;

describe('compileQuery', () => {
  it('applies default exclusions, default sort and id tiebreaker', () => {
    const q = compileQuery({}, ctx);
    expect(q.text).toBe('select w.* from work_items_v w where w.deleted_at is null and w.archived_at is null order by w.sort_order asc, w.created_at desc, w.id asc');
    expect(q.values).toEqual([]);
    expect(q.isAggregate).toBe(false);
  });

  it('includes archived rows only when asked', () => {
    expect(compileQuery({ include_archived: true }, ctx).text).not.toContain('archived_at');
  });

  it('puts every value into positional ? params (no casts, no interpolation)', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'assignee_id', op: 'eq', value: '$me' },
      { field: 'priority', op: 'in', value: [1, 2] },
      { field: 'title', op: 'contains', value: "x' or 1=1 --" },
    ] } }, ctx);
    expect(q.text).toContain('w.assignee_id = ?');
    expect(q.text).toContain('w.priority in (?, ?)');
    expect(q.text).toContain("lower(w.title) like lower(?) escape '\\'");
    expect(q.values).toEqual(['u-1', 1, 2, "%x' or 1=1 --%"]);
    expect(q.text).not.toContain('1=1');
    expect(q.text).not.toMatch(/\$\d|::/);
    expect(placeholders(q.text)).toBe(q.values.length);
  });

  it('escapes LIKE metacharacters', () => {
    const q = compileQuery({ filter: { field: 'title', op: 'starts_with', value: '100%_done\\' } }, ctx);
    expect(q.values[0]).toBe('100\\%\\_done\\\\%');
  });

  it('rejects unknown fields, bad custom keys and non-sortable fields', () => {
    expect(() => compileQuery({ filter: { field: 'title; drop table users', op: 'eq', value: 1 } }, ctx)).toThrow(/unknown field/);
    expect(() => compileQuery({ filter: { field: "fields.x'||'", op: 'eq', value: 1 } }, ctx)).toThrow(/invalid custom field key/);
    expect(() => compileQuery({ filter: { field: 'fields.a.b', op: 'eq', value: 1 } }, ctx)).toThrow(/invalid custom field key/);
    expect(() => compileQuery({ filter: { field: 'fields.Upper', op: 'eq', value: 1 } }, ctx)).toThrow(/invalid custom field key/);
    expect(() => compileQuery({ sort: [{ field: 'labels', dir: 'asc' }] }, ctx)).toThrow(/not sortable/);
    expect(() => compileQuery({ sort: [{ field: 'description', dir: 'asc' }] }, ctx)).toThrow(/not sortable/);
    expect(() => compileQuery({ group_by: 'labels' }, ctx)).toThrow(/cannot group by/);
  });

  it('types JSON fields from fieldDefs (json_extract + cast by kind), text when unknown', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'fields.severity', op: 'eq', value: 's1' },
      { field: 'fields.budget', op: 'gte', value: '100' },
      { field: 'fields.approved', op: 'eq', value: true },
      { field: 'fields.review_date', op: 'before', value: '$today' },
      { field: 'fields.mystery', op: 'eq', value: 'x' },
    ] } }, ctx, { fieldDefs });
    expect(q.text).toContain("json_extract(w.fields, '$.severity') = ?");
    expect(q.text).toContain("cast(json_extract(w.fields, '$.budget') as real) >= ?");
    expect(q.text).toContain("json_extract(w.fields, '$.approved') = ?");
    expect(q.text).toContain("json_extract(w.fields, '$.review_date') < ?");
    expect(q.text).toContain("json_extract(w.fields, '$.mystery') = ?");
    expect(q.values).toEqual(['s1', 100, 1, '2026-10-15', 'x']);
  });

  it('compares booleans as 0/1', () => {
    const q = compileQuery({ filter: { and: [{ field: 'confidential', op: 'eq', value: true }, { field: 'is_blocked', op: 'neq', value: 'true' }] } }, ctx);
    expect(q.text).toContain('w.confidential = ?');
    expect(q.text).toContain('w.is_blocked is not ?');
    expect(q.values).toEqual([1, 1]);
  });

  it('compiles multi_select ops to json_each EXISTS subqueries', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'fields.tags', op: 'has', value: 'a' },
      { field: 'fields.tags', op: 'has_any', value: ['a', 'b'] },
      { field: 'fields.tags', op: 'has_all', value: ['a', 'b'] },
      { field: 'fields.tags', op: 'is_empty' },
      { field: 'fields.tags', op: 'contains', value: 'x_' },
      { field: 'fields.tags', op: 'starts_with', value: 'ht' },
    ] } }, ctx, { fieldDefs });
    expect(q.text).toContain("exists (select 1 from json_each(w.fields, '$.tags') e where e.value = ?)");
    expect(q.text).toContain("exists (select 1 from json_each(w.fields, '$.tags') e where e.value in (?, ?))");
    expect(q.text).toContain("not exists (select 1 from json_each(?) req where not exists (select 1 from json_each(w.fields, '$.tags') e where e.value = req.value))");
    expect(q.text).toContain("not (json_extract(w.fields, '$.tags') is not null and (json_type(w.fields, '$.tags') <> 'array' or json_array_length(w.fields, '$.tags') > 0))");
    expect(q.text).toContain("lower(json_extract(w.fields, '$.tags')) like lower(?) escape '\\'");
    expect(q.text).toContain("exists (select 1 from json_each(w.fields, '$.tags') e where lower(e.value) like lower(?) escape '\\')");
    expect(q.values).toEqual(['a', 'a', 'b', '["a","b"]', '%x\\_%', 'ht%']);
    expect(placeholders(q.text)).toBe(q.values.length);
  });

  it('compiles labels to EXISTS over work_item_labels accepting ids or names', () => {
    const q = compileQuery({ filter: { field: 'labels', op: 'has_any', value: ['Regulatory', 'abc'] } }, ctx);
    expect(q.text).toMatch(/exists \(select 1 from work_item_labels wl join labels l on l\.id = wl\.label_id and l\.deleted_at is null where wl\.item_id = w\.id and wl\.deleted_at is null/);
    expect(q.text).toContain('(l.id in (?, ?) or lower(l.name) in (?, ?))');
    expect(q.values).toEqual(['regulatory', 'abc', 'regulatory', 'abc']);
    const one = compileQuery({ filter: { field: 'labels', op: 'has', value: 'Audit' } }, ctx);
    expect(one.text).toContain('(l.id = ? or lower(l.name) = ?)');
    expect(one.values).toEqual(['audit', 'audit']);
    const all = compileQuery({ filter: { field: 'labels', op: 'has_all', value: ['a', 'b'] } }, ctx);
    expect(all.text.match(/exists \(select 1 from work_item_labels/g)).toHaveLength(2);
    expect(all.text).toMatch(/\) and exists \(/);
    const none = compileQuery({ filter: { field: 'labels', op: 'is_empty' } }, ctx);
    expect(none.text).toContain('not exists (select 1 from work_item_labels');
  });

  it('compiles full-text search to an FTS5 subquery with bm25 ordering when no sort is given', () => {
    const q = compileQuery({ filter: { field: 'search', op: 'match', value: '  swaption   pricer ' } }, ctx);
    expect(q.text).toContain('w.id in (select f.id from work_items_fts f where f.work_items_fts match ?)');
    expect(q.text).toContain('order by (select bm25(f.work_items_fts, 0.0, 10.0, 5.0, 1.0) from work_items_fts f where f.work_items_fts match ? and f.id = w.id) asc nulls last, w.sort_order asc');
    expect(q.values).toEqual(['"swaption" "pricer"', '"swaption" "pricer"']);
    const sorted = compileQuery({ filter: { field: 'search', op: 'match', value: 'x' }, sort: [{ field: 'key', dir: 'asc' }] }, ctx);
    expect(sorted.text).not.toContain('bm25');
    expect(sorted.values).toEqual(['"x"']);
    const blank = compileQuery({ filter: { field: 'search', op: 'match', value: '   ' } }, ctx);
    expect(blank.text).not.toContain('work_items_fts');
    expect(blank.values).toEqual([]);
  });

  it('never lets FTS syntax through MATCH (every token is a quoted phrase)', () => {
    expect(ftsQuery('curve AND (NOT x) OR "y" NEAR z*')).toBe('"curve" "AND" "(NOT" "x)" "OR" """y""" "NEAR" "z*"');
    expect(ftsQuery('')).toBe('');
    const q = compileQuery({ filter: { field: 'search', op: 'match', value: 'a" OR 1=1 --' } }, ctx);
    expect(q.values[0]).toBe('"a""" "OR" "1=1" "--"');
    expect(q.text).not.toContain('1=1');
  });

  it('resolves date macros and within_days bounds as text params', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'due_date', op: 'within_days', value: 7 },
      { field: 'completed_at', op: 'within_days', value: -30 },
      { field: 'due_date', op: 'after', value: '$start_of_week' },
      { field: 'created_at', op: 'gte', value: '$start_of_month' },
      { field: 'due_date', op: 'lte', value: '$end_of_week' },
    ] } }, { ...ctx, tz: 'America/New_York' });
    expect(q.text).toContain('(w.due_date >= ? and w.due_date <= ?)');
    expect(q.text).toContain('(w.completed_at >= ? and w.completed_at < ?)');
    expect(q.text).toContain('w.due_date > ?');
    expect(q.text).toContain('w.created_at >= ?');
    expect(q.values).toEqual(['2026-10-15', '2026-10-22', '2026-09-15T04:00:00.000Z', '2026-10-16T04:00:00.000Z', '2026-10-12', '2026-10-01T04:00:00.000Z', '2026-10-18']);
  });

  it('coerces a date-only value to local midnight for datetime columns and instants to dates for date columns', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'completed_at', op: 'before', value: '2026-10-15' },
      { field: 'due_date', op: 'eq', value: '2026-10-15T03:30:00Z' },
    ] } }, { ...ctx, tz: 'America/New_York' });
    expect(q.values).toEqual(['2026-10-15T04:00:00.000Z', '2026-10-14']);
  });

  it('handles null semantics for eq/neq/in/nin', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'assignee_id', op: 'eq', value: null },
      { field: 'assignee_id', op: 'neq', value: 'u-2' },
      { field: 'assignee_id', op: 'nin', value: ['u-2'] },
      { field: 'assignee_id', op: 'in', value: ['u-2', null] },
      { field: 'assignee_id', op: 'nin', value: ['u-3', null] },
    ] } }, ctx);
    expect(q.text).toContain('w.assignee_id is null and');
    expect(q.text).toContain('w.assignee_id is not ?');
    expect(q.text).toContain('(w.assignee_id is null or not (w.assignee_id in (?)))');
    expect(q.text).toContain('(w.assignee_id in (?) or w.assignee_id is null)');
    expect(q.text).toContain('not (w.assignee_id in (?) or w.assignee_id is null)');
    expect(q.values).toEqual(['u-2', 'u-2', 'u-2', 'u-3']);
  });

  it('supports and/or/not nesting with empty groups', () => {
    const q = compileQuery({ filter: { or: [{ and: [] }, { not: { field: 'priority', op: 'eq', value: 1 } }, { or: [] }] } }, ctx);
    expect(q.text).toContain('(true or (not w.priority = ?) or false)');
  });

  it('compares state.category by lifecycle order and text case-insensitively', () => {
    const q = compileQuery({ filter: { and: [{ field: 'state.category', op: 'lt', value: 'done' }, { field: 'state.category', op: 'eq', value: 'todo' }, { field: 'title', op: 'gt', value: 'm' }] } }, ctx);
    expect(q.text).toContain("case w.state_category when 'backlog' then 0 when 'todo' then 1 when 'in_progress' then 2 when 'done' then 3 when 'canceled' then 4 end < ?");
    expect(q.text).toContain('w.state_category = ?');
    expect(q.text).toContain('w.title collate nocase > ?');
    expect(q.values).toEqual([3, 'todo', 'm']);
    // unknown category falls back to a plain text comparison
    expect(compileQuery({ filter: { field: 'state.category', op: 'gte', value: 'zzz' } }, ctx).text).toContain('w.state_category >= ?');
  });

  it('sorts with nulls handling, workflow order for state_id, lifecycle order for categories and nocase for text', () => {
    const q = compileQuery({ sort: [{ field: 'state_id', dir: 'asc' }, { field: 'due_date', dir: 'desc', nulls: 'first' }, { field: 'state.category', dir: 'asc' }, { field: 'title', dir: 'desc' }] }, ctx);
    expect(q.text).toContain("order by (select s.sort from workflow_states s where s.id = w.state_id) asc nulls last, w.due_date desc nulls first, case w.state_category when 'backlog' then 0 when 'todo' then 1 when 'in_progress' then 2 when 'done' then 3 when 'canceled' then 4 end asc nulls last, w.title collate nocase desc nulls last, w.id asc");
    const t = compileQuery({ sort: [{ field: 'type_id', dir: 'desc' }, { field: 'fields.budget', dir: 'asc' }, { field: 'fields.severity', dir: 'asc' }] }, ctx, { fieldDefs });
    expect(t.text).toContain("order by (select t.sort from item_types t where t.id = w.type_id) desc nulls last, cast(json_extract(w.fields, '$.budget') as real) asc nulls last, json_extract(w.fields, '$.severity') collate nocase asc nulls last, w.id asc");
  });

  it('adds a __group column and orders by it first', () => {
    const q = compileQuery({ group_by: 'assignee_id', sort: [{ field: 'priority', dir: 'asc' }] }, ctx);
    expect(q.text).toContain('select w.*, w.assignee_id as __group');
    expect(q.text).toContain('order by w.assignee_id asc nulls last, w.priority asc nulls last, w.id asc');
    expect(q.isAggregate).toBe(false);
    const s = compileQuery({ group_by: 'state_id' }, ctx);
    expect(s.text).toContain('order by (select s.sort from workflow_states s where s.id = w.state_id) asc nulls last, w.state_id asc nulls last, w.sort_order asc');
    const b = compileQuery({ group_by: 'is_blocked' }, ctx);
    expect(b.text).toContain("case when w.is_blocked is null then null when w.is_blocked then 'true' else 'false' end as __group");
  });

  it('applies limit/offset, extraWhere (spliced in order) and visibleProjectIds', () => {
    const q = compileQuery({ filter: { field: 'priority', op: 'eq', value: 1 }, limit: 50, offset: 100 }, { ...ctx, visibleProjectIds: ['p1', 'p2'] }, {
      extraWhere: [visibilityWhere('u-1', 0), { text: 'w.project_id = ? and w.type_id <> ?', values: ['p1', 't1'] }],
    });
    expect(q.text).toContain('w.project_id in (?, ?)');
    expect(q.text).toContain('w.priority = ?');
    expect(q.text).toContain('(exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id))');
    expect(q.text).toContain('(w.project_id = ? and w.type_id <> ?)');
    expect(q.text).toMatch(/limit \? offset \?$/);
    expect(q.values).toEqual(['p1', 'p2', 1, 'u-1', 'p1', 't1', 50, 100]);
    expect(placeholders(q.text)).toBe(q.values.length);
    expect(compileQuery({}, { ...ctx, visibleProjectIds: [] }).text).toContain('and false order by');
    // SQLite needs a LIMIT before OFFSET
    const off = compileQuery({ offset: 10 }, ctx);
    expect(off.text).toMatch(/limit -1 offset \?$/);
    expect(off.values).toEqual([10]);
  });

  it('honours from/select options', () => {
    const q = compileQuery({}, ctx, { from: 'my_items w', select: 'w.id' });
    expect(q.text.startsWith('select w.id from my_items w')).toBe(true);
  });

  it('emits only SQLite-compatible SQL', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'search', op: 'match', value: 'a b' }, { field: 'labels', op: 'has_all', value: ['x', 'y'] },
      { field: 'fields.tags', op: 'has_any', value: ['a'] }, { field: 'fields.approved', op: 'eq', value: false },
      { field: 'completed_at', op: 'within_days', value: -7 }, { field: 'assignee_id', op: 'neq', value: 'u' },
      { field: 'title', op: 'contains', value: 'q' },
    ] }, group_by: 'state.category', limit: 5 }, ctx, { fieldDefs, extraWhere: [visibilityWhere('u-1', 0)] });
    expect(q.text).not.toMatch(/::|= any\(|unnest|jsonb|\?\||\?&|@>|ilike|websearch|ts_rank|is distinct from|date_trunc|at time zone|can_view_item/);
    expect(placeholders(q.text)).toBe(q.values.length);
    for (const v of q.values) expect(['string', 'number']).toContain(typeof v);
  });
});

describe('compileWidget', () => {
  const base = { id: 'w', title: 't', viz: 'bar' as const, w: 4, h: 3 };
  it('aggregates by group with a measure', () => {
    const q = compileWidget({ ...base, query: { filter: { field: 'state.category', op: 'nin', value: ['done'] } }, group_by: 'state_id', measure: 'count' }, ctx);
    expect(q.text).toBe('select w.state_id as key, count(*) as value from work_items_v w where w.deleted_at is null and w.archived_at is null and (w.state_category is null or not (w.state_category in (?))) group by 1 order by 2 desc, 1 asc nulls last');
    expect(q.values).toEqual(['done']);
    expect(q.isAggregate).toBe(true);
  });
  it('supports number widgets without group_by', () => {
    const q = compileWidget({ ...base, viz: 'number', query: {}, measure: 'sum_estimate' }, ctx);
    expect(q.text).toBe('select null as key, coalesce(sum(w.estimate), 0) as value from work_items_v w where w.deleted_at is null and w.archived_at is null');
  });
  it('supports sum_field/avg_field on numeric JSON fields and boolean keys', () => {
    const q = compileWidget({ ...base, query: {}, group_by: 'fields.severity', measure: 'avg_field', measure_field: 'fields.budget' }, ctx, { fieldDefs });
    expect(q.text).toContain("select json_extract(w.fields, '$.severity') as key, avg(cast(json_extract(w.fields, '$.budget') as real)) as value");
    expect(() => compileWidget({ ...base, query: {}, measure: 'sum_field', measure_field: 'fields.severity' }, ctx, { fieldDefs })).toThrow(/not numeric/);
    expect(() => compileWidget({ ...base, query: {}, measure: 'sum_field' }, ctx)).toThrow(/requires measure_field/);
    const s = compileWidget({ ...base, query: {}, group_by: 'fields.budget', measure: 'sum_field', measure_field: 'fields.budget' }, ctx, { fieldDefs });
    expect(s.text).toContain("coalesce(sum(cast(json_extract(w.fields, '$.budget') as real)), 0) as value");
    const b = compileWidget({ ...base, query: {}, group_by: 'is_blocked', measure: 'count' }, ctx);
    expect(b.text).toContain("select case when w.is_blocked is null then null when w.is_blocked then 'true' else 'false' end as key");
  });
  it('buckets dates in UTC with substr/date arithmetic (no tz param)', () => {
    const week = compileWidget({ ...base, viz: 'line', query: {}, group_by: 'completed_at', time_bucket: 'week', measure: 'count' }, { ...ctx, tz: 'Europe/London' });
    expect(week.text).toContain("select date(substr(w.completed_at, 1, 10), '-' || ((cast(strftime('%w', substr(w.completed_at, 1, 10)) as integer) + 6) % 7) || ' days') as key");
    expect(week.text).toContain('group by 1 order by 1 asc nulls last');
    expect(week.values).toEqual([]);
    const day = compileWidget({ ...base, viz: 'line', query: {}, group_by: 'due_date', time_bucket: 'day', measure: 'count' }, ctx);
    expect(day.text).toContain('select substr(w.due_date, 1, 10) as key');
    const month = compileWidget({ ...base, viz: 'line', query: {}, group_by: 'fields.review_date', time_bucket: 'month', measure: 'count' }, ctx, { fieldDefs });
    expect(month.text).toContain("select (substr(json_extract(w.fields, '$.review_date'), 1, 7) || '-01') as key");
    expect(() => compileWidget({ ...base, viz: 'line', query: {}, group_by: 'title', time_bucket: 'month', measure: 'count' }, ctx)).toThrow(/time_bucket requires a date field/);
  });
  it('splices extraWhere into widgets too', () => {
    const q = compileWidget({ ...base, viz: 'number', query: {}, measure: 'count' }, ctx, { extraWhere: [visibilityWhere('u-9', 3)] });
    expect(q.text).toContain('and (exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id))');
    expect(q.values).toEqual(['u-9']);
  });
});

describe('time buckets (client side, UTC)', () => {
  it('agree with the SQL definition: day, Monday week, first of month', () => {
    expect(timeBucket('2026-10-15T23:30:00.000Z', 'day')).toBe('2026-10-15');
    expect(timeBucket('2026-10-15', 'week')).toBe('2026-10-12');
    expect(timeBucket('2026-10-12', 'week')).toBe('2026-10-12'); // Monday stays
    expect(timeBucket('2026-10-18T01:00:00.000Z', 'week')).toBe('2026-10-12'); // Sunday → previous Monday
    expect(timeBucket('2026-10-31', 'month')).toBe('2026-10-01');
    expect(timeBucket(new Date('2026-01-01T00:00:00Z'), 'month')).toBe('2026-01-01');
    expect(timeBucket(null, 'day')).toBeNull();
    expect(timeBucket('nope', 'day')).toBeNull();
  });
});

describe('visibilityWhere', () => {
  it('uses the visible_items view with a positional parameter regardless of offset', () => {
    const expected = { text: 'exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id)', values: ['u'] };
    expect(visibilityWhere('u', 0)).toEqual(expected);
    expect(visibilityWhere('u', 4)).toEqual(expected);
    expect(visibilityWhere('u')).toEqual(expected);
  });
});

describe('toSqlParam', () => {
  it('normalizes JS values to SQLite scalars', () => {
    expect(toSqlParam(true)).toBe(1);
    expect(toSqlParam(false)).toBe(0);
    expect(toSqlParam(undefined)).toBeNull();
    expect(toSqlParam(new Date('2026-10-15T00:00:00Z'))).toBe('2026-10-15T00:00:00.000Z');
    expect(toSqlParam(['a'])).toBe('["a"]');
    expect(toSqlParam(3n)).toBe(3);
    expect(toSqlParam('x')).toBe('x');
  });
});

describe('QuerySpec zod parsing round-trips into the compiler', () => {
  it('accepts the documented view spec', () => {
    const spec = QuerySpecParse({
      filter: { and: [{ field: 'state.category', op: 'nin', value: ['done', 'canceled'] }, { field: 'fields.severity', op: 'in', value: ['s1', 's2'] }] },
      sort: [{ field: 'priority', dir: 'asc' }, { field: 'due_date', dir: 'asc' }],
      group_by: 'state_id',
    });
    expect(() => compileQuery(spec, ctx, { fieldDefs })).not.toThrow();
  });
});

import { QuerySpec as QuerySpecSchema } from './spec.js';
function QuerySpecParse(x: unknown): QuerySpec { return QuerySpecSchema.parse(x); }
