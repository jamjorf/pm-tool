import { describe, it, expect } from 'vitest';
import { compileQuery, compileWidget, visibilityWhere } from './compile.js';
import type { QueryContext, QuerySpec } from './spec.js';
import type { FieldDef } from '../schema/entities.js';

const ctx: QueryContext = { userId: 'u-1', tz: 'UTC', now: new Date('2026-10-15T12:00:00Z') };
const fieldDefs: Record<string, FieldDef[]> = {
  bug: [{ key: 'severity', label: 'Severity', kind: 'select', options: [{ value: 's1', label: 'S1' }] }, { key: 'budget', label: 'Budget', kind: 'number' }],
  task: [{ key: 'tags', label: 'Tags', kind: 'multi_select' }, { key: 'review_date', label: 'Review', kind: 'date' }, { key: 'approved', label: 'Approved', kind: 'bool' }],
};

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

  it('puts every value into params and casts them', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'assignee_id', op: 'eq', value: '$me' },
      { field: 'priority', op: 'in', value: [1, 2] },
      { field: 'title', op: 'contains', value: "x' or 1=1 --" },
    ] } }, ctx);
    expect(q.text).toContain('w.assignee_id = $1::uuid');
    expect(q.text).toContain('w.priority = any($2::numeric[])');
    expect(q.text).toContain('(w.title)::text ilike $3::text');
    expect(q.values).toEqual(['u-1', [1, 2], "%x' or 1=1 --%"]);
    expect(q.text).not.toContain('1=1');
  });

  it('escapes LIKE metacharacters', () => {
    const q = compileQuery({ filter: { field: 'title', op: 'starts_with', value: '100%_done\\' } }, ctx);
    expect(q.values[0]).toBe('100\\%\\_done\\\\%');
  });

  it('rejects unknown fields, bad custom keys and non-sortable fields', () => {
    expect(() => compileQuery({ filter: { field: 'title; drop table users', op: 'eq', value: 1 } }, ctx)).toThrow(/unknown field/);
    expect(() => compileQuery({ filter: { field: "fields.x'||'", op: 'eq', value: 1 } }, ctx)).toThrow(/invalid custom field key/);
    expect(() => compileQuery({ sort: [{ field: 'labels', dir: 'asc' }] }, ctx)).toThrow(/not sortable/);
    expect(() => compileQuery({ sort: [{ field: 'description', dir: 'asc' }] }, ctx)).toThrow(/not sortable/);
    expect(() => compileQuery({ group_by: 'labels' }, ctx)).toThrow(/cannot group by/);
  });

  it('types JSONB fields from fieldDefs, text when unknown', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'fields.severity', op: 'eq', value: 's1' },
      { field: 'fields.budget', op: 'gte', value: '100' },
      { field: 'fields.approved', op: 'eq', value: true },
      { field: 'fields.review_date', op: 'before', value: '$today' },
      { field: 'fields.mystery', op: 'eq', value: 'x' },
    ] } }, ctx, { fieldDefs });
    expect(q.text).toContain("(w.fields->>'severity') = $1::text");
    expect(q.text).toContain("(w.fields->>'budget')::numeric >= $2::numeric");
    expect(q.text).toContain("(w.fields->>'approved')::boolean = $3::boolean");
    expect(q.text).toContain("(w.fields->>'review_date')::date < $4::date");
    expect(q.text).toContain("(w.fields->>'mystery') = $5::text");
    expect(q.values).toEqual(['s1', 100, true, '2026-10-15', 'x']);
  });

  it('compiles multi_select ops to jsonb operators', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'fields.tags', op: 'has', value: 'a' },
      { field: 'fields.tags', op: 'has_any', value: ['a', 'b'] },
      { field: 'fields.tags', op: 'has_all', value: ['a', 'b'] },
      { field: 'fields.tags', op: 'is_empty' },
    ] } }, ctx, { fieldDefs });
    expect(q.text).toContain("(w.fields->'tags') @> $1::text::jsonb");
    expect(q.text).toContain("(w.fields->'tags') ?| $2::text[]");
    expect(q.text).toContain("(w.fields->'tags') ?& $3::text[]");
    expect(q.text).toContain("= '[]'::jsonb");
    expect(q.values[0]).toBe('["a"]');
  });

  it('compiles labels to EXISTS over work_item_labels accepting ids or names', () => {
    const q = compileQuery({ filter: { field: 'labels', op: 'has_any', value: ['Regulatory', 'abc'] } }, ctx);
    expect(q.text).toMatch(/exists \(select 1 from work_item_labels wl join labels l on l\.id = wl\.label_id/);
    expect(q.text).toContain('l.id::text = any($1::text[]) or lower(l.name) = any($1::text[])');
    expect(q.values).toEqual([['regulatory', 'abc']]);
    const all = compileQuery({ filter: { field: 'labels', op: 'has_all', value: ['a', 'b'] } }, ctx);
    expect(all.text).toContain('not exists (select 1 from unnest($1::text[]) v where not exists');
  });

  it('compiles full-text search with ts_rank ordering when no sort is given', () => {
    const q = compileQuery({ filter: { field: 'search', op: 'match', value: 'swaption pricer' } }, ctx);
    expect(q.text).toContain("w.search @@ websearch_to_tsquery('english', $1::text)");
    expect(q.text).toContain("order by ts_rank(w.search, websearch_to_tsquery('english', $2::text)) desc, w.sort_order asc");
    const sorted = compileQuery({ filter: { field: 'search', op: 'match', value: 'x' }, sort: [{ field: 'key', dir: 'asc' }] }, ctx);
    expect(sorted.text).not.toContain('ts_rank');
  });

  it('resolves date macros and within_days bounds', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'due_date', op: 'within_days', value: 7 },
      { field: 'completed_at', op: 'within_days', value: -30 },
      { field: 'due_date', op: 'after', value: '$start_of_week' },
      { field: 'created_at', op: 'gte', value: '$start_of_month' },
    ] } }, { ...ctx, tz: 'America/New_York' });
    expect(q.text).toContain('(w.due_date >= $1::date and w.due_date <= $2::date)');
    expect(q.text).toContain('(w.completed_at >= $3::timestamptz and w.completed_at < $4::timestamptz)');
    expect(q.values).toEqual(['2026-10-15', '2026-10-22', '2026-09-15T04:00:00.000Z', '2026-10-16T04:00:00.000Z', '2026-10-12', '2026-10-01T04:00:00.000Z']);
  });

  it('handles null semantics for eq/neq/in/nin', () => {
    const q = compileQuery({ filter: { and: [
      { field: 'assignee_id', op: 'eq', value: null },
      { field: 'assignee_id', op: 'neq', value: 'u-2' },
      { field: 'assignee_id', op: 'nin', value: ['u-2'] },
      { field: 'assignee_id', op: 'in', value: ['u-2', null] },
    ] } }, ctx);
    expect(q.text).toContain('w.assignee_id is null and');
    expect(q.text).toContain('w.assignee_id is distinct from $1::uuid');
    expect(q.text).toContain('(w.assignee_id is null or not (w.assignee_id = any($2::uuid[])))');
    expect(q.text).toContain('(w.assignee_id = any($3::uuid[]) or w.assignee_id is null)');
  });

  it('supports and/or/not nesting with empty groups', () => {
    const q = compileQuery({ filter: { or: [{ and: [] }, { not: { field: 'priority', op: 'eq', value: 1 } }, { or: [] }] } }, ctx);
    expect(q.text).toContain('(true or (not w.priority = $1::numeric) or false)');
  });

  it('sorts with nulls handling and workflow order for state_id', () => {
    const q = compileQuery({ sort: [{ field: 'state_id', dir: 'asc' }, { field: 'due_date', dir: 'desc', nulls: 'first' }, { field: 'state.category', dir: 'asc' }] }, ctx);
    expect(q.text).toContain('order by (select s.sort from workflow_states s where s.id = w.state_id) asc nulls last, w.due_date desc nulls first, w.state_category asc nulls last, w.id asc');
  });

  it('adds a __group column and orders by it first', () => {
    const q = compileQuery({ group_by: 'assignee_id', sort: [{ field: 'priority', dir: 'asc' }] }, ctx);
    expect(q.text).toContain('select w.*, w.assignee_id as __group');
    expect(q.text).toContain('order by w.assignee_id asc nulls last, w.priority asc nulls last, w.id asc');
    expect(q.isAggregate).toBe(false);
  });

  it('applies limit/offset, extraWhere (renumbered) and visibleProjectIds', () => {
    const q = compileQuery({ filter: { field: 'priority', op: 'eq', value: 1 }, limit: 50, offset: 100 }, { ...ctx, visibleProjectIds: ['p1'] }, {
      extraWhere: [visibilityWhere('u-1', 0), { text: 'w.project_id = $1 and w.type_id <> $2', values: ['p1', 't1'] }],
    });
    expect(q.text).toContain('w.project_id = any($1::uuid[])');
    expect(q.text).toContain('w.priority = $2::numeric');
    expect(q.text).toContain('(can_view_item($3, w.id))');
    expect(q.text).toContain('(w.project_id = $4 and w.type_id <> $5)');
    expect(q.text).toMatch(/limit \$6::int offset \$7::int$/);
    expect(q.values).toEqual([['p1'], 1, 'u-1', 'p1', 't1', 50, 100]);
  });

  it('honours from/select options', () => {
    const q = compileQuery({}, ctx, { from: 'my_items w', select: 'w.id' });
    expect(q.text.startsWith('select w.id from my_items w')).toBe(true);
  });
});

describe('compileWidget', () => {
  const base = { id: 'w', title: 't', viz: 'bar' as const, w: 4, h: 3 };
  it('aggregates by group with a measure', () => {
    const q = compileWidget({ ...base, query: { filter: { field: 'state.category', op: 'nin', value: ['done'] } }, group_by: 'state_id', measure: 'count' }, ctx);
    expect(q.text).toBe("select (w.state_id)::text as key, count(*)::int as value from work_items_v w where w.deleted_at is null and w.archived_at is null and (w.state_category::text is null or not (w.state_category::text = any($1::text[]))) group by 1 order by 2 desc, 1 asc nulls last");
    expect(q.isAggregate).toBe(true);
  });
  it('supports number widgets without group_by', () => {
    const q = compileWidget({ ...base, viz: 'number', query: {}, measure: 'sum_estimate' }, ctx);
    expect(q.text).toBe('select null::text as key, coalesce(sum(w.estimate), 0)::float as value from work_items_v w where w.deleted_at is null and w.archived_at is null');
  });
  it('supports sum_field/avg_field on numeric JSONB fields and time buckets', () => {
    const q = compileWidget({ ...base, query: {}, group_by: 'fields.severity', measure: 'avg_field', measure_field: 'fields.budget' }, ctx, { fieldDefs });
    expect(q.text).toContain("avg((w.fields->>'budget')::numeric)::float as value");
    expect(() => compileWidget({ ...base, query: {}, measure: 'sum_field', measure_field: 'fields.severity' }, ctx, { fieldDefs })).toThrow(/not numeric/);
    const t = compileWidget({ ...base, viz: 'line', query: {}, group_by: 'completed_at', time_bucket: 'week', measure: 'count' }, { ...ctx, tz: 'Europe/London' });
    expect(t.text).toContain("date_trunc('week', (w.completed_at at time zone $1::text))::date::text as key");
    expect(t.text).toContain('order by 1 asc');
    expect(t.values).toEqual(['Europe/London']);
  });
});

describe('visibilityWhere', () => {
  it('numbers its parameter from the offset', () => {
    expect(visibilityWhere('u', 0)).toEqual({ text: 'can_view_item($1, w.id)', values: ['u'] });
    expect(visibilityWhere('u', 4)).toEqual({ text: 'can_view_item($5, w.id)', values: ['u'] });
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
