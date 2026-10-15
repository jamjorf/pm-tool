import { describe, it, expect } from 'vitest';
import { resolveMacro, getField, matchesFilter, matchesSpec, sortItems, groupItems, runSpec, type ItemRow, type EvalLookups } from './evaluate.js';
import { dateInTz, startOfDayInTz, coerceTemporal, withinDaysBounds } from './common.js';
import type { QueryContext } from './spec.js';
import type { WorkflowState, ItemType, Project, Label, User } from '../schema/entities.js';

const now = new Date('2026-10-15T03:30:00Z'); // Wed 15 Oct 2026 UTC; still Tue 14 Oct in New York
const ctx: QueryContext = { userId: 'alice', tz: 'UTC', now };

const synced = { version: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null };
const state = (id: string, key: string, category: WorkflowState['category'], sort: number): WorkflowState =>
  ({ id, workflow_id: 'wf', key, name: key.replace('_', ' '), category, color: null, sort, is_initial: key === 'todo', ...synced });
const states = { todo: state('s-todo', 'todo', 'todo', 1), prog: state('s-prog', 'in_progress', 'in_progress', 2), done: state('s-done', 'done', 'done', 4) };
const types: Record<string, ItemType> = {
  't-bug': { id: 't-bug', key: 'bug', name: 'Bug', plural_name: null, icon: null, color: null, description: null, workflow_id: 'wf', is_container: false, sort: 1, is_active: true, ...synced,
    field_defs: [{ key: 'severity', label: 'Severity', kind: 'select', options: [{ value: 's1', label: 'S1 – Critical' }, { value: 's2', label: 'S2' }] }, { key: 'budget', label: 'Budget', kind: 'number' }, { key: 'tags', label: 'Tags', kind: 'multi_select' }, { key: 'review_date', label: 'Review', kind: 'date' }] },
  't-task': { id: 't-task', key: 'task', name: 'Task', plural_name: null, icon: null, color: null, description: null, workflow_id: 'wf', is_container: false, sort: 0, is_active: true, field_defs: [], ...synced },
};
const projects: Record<string, Project> = {
  p1: { id: 'p1', key: 'RATES', name: 'Rates', description: null, status: 'active', visibility: 'firm', lead_id: null, team_id: null, item_seq: 0, default_type_id: null, allowed_type_ids: null, settings: {}, start_date: null, target_date: null, archived_at: null, ...synced },
};
const labels: Record<string, Label> = { l1: { id: 'l1', project_id: null, name: 'Regulatory', color: null, ...synced }, l2: { id: 'l2', project_id: 'p1', name: 'tech-debt', color: null, ...synced } };
const users: Record<string, User> = { alice: { id: 'alice', email: 'a@x', name: 'Alice Chen', avatar_url: null, firm_role: 'owner', is_active: true, is_service: false, settings: {}, ...synced } };

function item(over: Partial<ItemRow> & { id: string }): ItemRow {
  return {
    project_id: 'p1', type_id: 't-task', number: 1, key: `RATES-${over.id}`, title: `Item ${over.id}`, description: '', state_id: 's-todo', priority: 0,
    assignee_id: null, reporter_id: null, start_date: null, due_date: null, estimate: null, fields: {}, confidential: false, sort_order: 0,
    created_by: null, completed_at: null, canceled_at: null, archived_at: null, ...synced, ...over,
  };
}
const lookups: EvalLookups = {
  states: { 's-todo': states.todo, 's-prog': states.prog, 's-done': states.done }, types, projects, labels, users,
  labelIdsByItem: { a: ['l1', 'l2'], b: ['l2'] },
  parentByItem: { b: 'a' },
  blockedItems: new Set(['c']),
};
const A = item({ id: 'a', type_id: 't-bug', state_id: 's-prog', priority: 1, assignee_id: 'alice', due_date: '2026-10-14', estimate: '3.50' as never, fields: { severity: 's1', budget: 1000, tags: ['x', 'y'], review_date: '2026-10-20' }, title: 'Fix swaption pricer', created_at: '2026-10-10T00:00:00.000Z' });
const B = item({ id: 'b', state_id: 's-done', priority: 3, assignee_id: 'bob', due_date: '2026-10-20', estimate: 1, completed_at: '2026-10-01T10:00:00.000Z', title: 'add collateral feed', description: 'Needs Regulatory sign-off', created_at: '2026-10-11T00:00:00.000Z' });
const C = item({ id: 'c', state_id: 's-todo', priority: 2, due_date: null, sort_order: -1, title: 'Build curve', created_at: '2026-10-12T00:00:00.000Z' });
const D = item({ id: 'd', state_id: 's-todo', priority: 0, archived_at: '2026-10-01T00:00:00.000Z', title: 'Archived', created_at: '2026-10-09T00:00:00.000Z' });
const E = item({ id: 'e', state_id: 's-todo', deleted_at: '2026-10-01T00:00:00.000Z', title: 'Deleted', created_at: '2026-10-08T00:00:00.000Z' });
const items = [A, B, C, D, E];

describe('macros & dates', () => {
  it('resolves every macro in the ctx time zone', () => {
    expect(resolveMacro('$me', ctx)).toBe('alice');
    expect(resolveMacro('$now', ctx)).toBe('2026-10-15T03:30:00.000Z');
    expect(resolveMacro('$today', ctx)).toBe('2026-10-15');
    expect(resolveMacro('$today', { ...ctx, tz: 'America/New_York' })).toBe('2026-10-14');
    expect(resolveMacro('$start_of_week', ctx)).toBe('2026-10-12'); // Monday
    expect(resolveMacro('$end_of_week', ctx)).toBe('2026-10-18');
    expect(resolveMacro('$start_of_month', ctx)).toBe('2026-10-01');
    expect(resolveMacro(['$me', 'x', 3], ctx)).toEqual(['alice', 'x', 3]);
    expect(resolveMacro('$unknown', ctx)).toBe('$unknown');
    expect(resolveMacro(null, ctx)).toBeNull();
  });
  it('handles DST-aware local midnight and invalid tz fallback', () => {
    expect(startOfDayInTz('2026-07-01', 'America/New_York')).toBe('2026-07-01T04:00:00.000Z');
    expect(startOfDayInTz('2026-01-01', 'America/New_York')).toBe('2026-01-01T05:00:00.000Z');
    expect(startOfDayInTz('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z');
    expect(dateInTz(new Date('2026-10-15T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-16');
    expect(dateInTz(now, 'Not/AZone')).toBe('2026-10-15');
  });
  it('coerces values across date/datetime kinds', () => {
    expect(coerceTemporal('date', '2026-10-15T03:30:00Z', { userId: '', tz: 'America/New_York' })).toBe('2026-10-14');
    expect(coerceTemporal('datetime', '2026-10-15', { userId: '', tz: 'Europe/London' })).toBe('2026-10-14T23:00:00.000Z');
    expect(withinDaysBounds('date', 7, ctx)).toEqual({ start: '2026-10-15', end: '2026-10-22' });
    expect(withinDaysBounds('date', -30, ctx)).toEqual({ start: '2026-09-15', end: '2026-10-15' });
    expect(withinDaysBounds('datetime', 0, ctx)).toEqual({ start: '2026-10-15T00:00:00.000Z', end: '2026-10-16T00:00:00.000Z' });
  });
});

describe('getField', () => {
  it('resolves dotted fields through lookups and falls back to view columns', () => {
    expect(getField(A, 'state.category', lookups)).toBe('in_progress');
    expect(getField(A, 'state.key', lookups)).toBe('in_progress');
    expect(getField(A, 'type.key', lookups)).toBe('bug');
    expect(getField(A, 'project.key', lookups)).toBe('RATES');
    expect(getField(A, 'labels', lookups)).toEqual(['l1', 'l2']);
    expect(getField(C, 'labels', lookups)).toEqual([]);
    expect(getField(B, 'parent_id', lookups)).toBe('a');
    expect(getField(A, 'parent_id', lookups)).toBeNull();
    expect(getField(C, 'is_blocked', lookups)).toBe(true);
    expect(getField(A, 'is_blocked', lookups)).toBe(false);
    expect(getField(A, 'fields.severity', lookups)).toBe('s1');
    expect(getField(A, 'fields.nope', lookups)).toBeNull();
    expect(getField(A, 'estimate', lookups)).toBe(3.5);
    expect(getField(A, 'search', lookups)).toContain('swaption');
    const bare: EvalLookups = { states: {}, types: {}, projects: {} };
    expect(getField({ ...A, state_category: 'done', label_ids: ['z'], is_blocked: true, parent_id: 'q' }, 'state.category', bare)).toBe('done');
    expect(getField({ ...A, label_ids: ['z'] }, 'labels', bare)).toEqual(['z']);
    expect(getField({ ...A, is_blocked: true }, 'is_blocked', bare)).toBe(true);
    expect(getField({ ...A, parent_id: 'q' }, 'parent_id', bare)).toBe('q');
  });
});

describe('matchesFilter', () => {
  const m = (expr: Parameters<typeof matchesFilter>[0], it: ItemRow, c = ctx) => matchesFilter(expr, it, c, lookups);
  it('scalar ops', () => {
    expect(m({ field: 'assignee_id', op: 'eq', value: '$me' }, A)).toBe(true);
    expect(m({ field: 'assignee_id', op: 'eq', value: '$me' }, B)).toBe(false);
    expect(m({ field: 'assignee_id', op: 'neq', value: 'alice' }, C)).toBe(true); // null counts as not-equal
    expect(m({ field: 'assignee_id', op: 'nin', value: ['alice'] }, C)).toBe(true);
    expect(m({ field: 'assignee_id', op: 'in', value: ['alice', null] }, C)).toBe(true);
    expect(m({ field: 'assignee_id', op: 'in', value: ['bob'] }, C)).toBe(false);
    expect(m({ field: 'assignee_id', op: 'is_null' }, C)).toBe(true);
    expect(m({ field: 'assignee_id', op: 'not_null' }, C)).toBe(false);
    expect(m({ field: 'priority', op: 'lte', value: 1 }, A)).toBe(true);
    expect(m({ field: 'priority', op: 'gt', value: '1' }, B)).toBe(true);
    expect(m({ field: 'estimate', op: 'gte', value: 3 }, A)).toBe(true); // numeric string coerced
    expect(m({ field: 'estimate', op: 'lt', value: 3 }, C)).toBe(false); // null never compares
    expect(m({ field: 'title', op: 'contains', value: 'SWAPTION' }, A)).toBe(true);
    expect(m({ field: 'title', op: 'starts_with', value: 'ADD' }, B)).toBe(true);
    expect(m({ field: 'description', op: 'is_empty' }, A)).toBe(true);
    expect(m({ field: 'description', op: 'not_empty' }, B)).toBe(true);
    expect(m({ field: 'state.category', op: 'nin', value: ['done', 'canceled'] }, A)).toBe(true);
    expect(m({ field: 'state.category', op: 'nin', value: ['done', 'canceled'] }, B)).toBe(false);
    expect(m({ field: 'state.category', op: 'lt', value: 'done' }, A)).toBe(true); // lifecycle order
    expect(m({ field: 'type.key', op: 'eq', value: 'bug' }, A)).toBe(true);
    expect(m({ field: 'is_blocked', op: 'eq', value: true }, C)).toBe(true);
    expect(m({ field: 'parent_id', op: 'eq', value: 'a' }, B)).toBe(true);
  });
  it('date ops with macros and tz', () => {
    expect(m({ field: 'due_date', op: 'before', value: '$today' }, A)).toBe(true);
    expect(m({ field: 'due_date', op: 'before', value: '$today' }, A, { ...ctx, tz: 'America/New_York' })).toBe(false); // still the 14th there
    expect(m({ field: 'due_date', op: 'after', value: '$today' }, B)).toBe(true);
    expect(m({ field: 'due_date', op: 'within_days', value: 7 }, B)).toBe(true);
    expect(m({ field: 'due_date', op: 'within_days', value: 3 }, B)).toBe(false);
    expect(m({ field: 'due_date', op: 'within_days', value: 7 }, C)).toBe(false);
    expect(m({ field: 'completed_at', op: 'within_days', value: -30 }, B)).toBe(true);
    expect(m({ field: 'completed_at', op: 'within_days', value: -7 }, B)).toBe(false);
    expect(m({ field: 'completed_at', op: 'before', value: '$today' }, B)).toBe(true);
    expect(m({ field: 'completed_at', op: 'gte', value: '$start_of_month' }, B)).toBe(true);
    expect(m({ field: 'created_at', op: 'lt', value: '$start_of_week' }, A)).toBe(true);
    expect(m({ field: 'fields.review_date', op: 'within_days', value: 7 }, A)).toBe(true);
  });
  it('JSONB fields typed by the item type', () => {
    expect(m({ field: 'fields.severity', op: 'in', value: ['s1'] }, A)).toBe(true);
    expect(m({ field: 'fields.severity', op: 'neq', value: 's1' }, B)).toBe(true); // missing key
    expect(m({ field: 'fields.budget', op: 'gte', value: '999' }, A)).toBe(true);
    expect(m({ field: 'fields.tags', op: 'has', value: 'x' }, A)).toBe(true);
    expect(m({ field: 'fields.tags', op: 'has_any', value: ['q', 'y'] }, A)).toBe(true);
    expect(m({ field: 'fields.tags', op: 'has_all', value: ['x', 'y'] }, A)).toBe(true);
    expect(m({ field: 'fields.tags', op: 'has_all', value: ['x', 'z'] }, A)).toBe(false);
    expect(m({ field: 'fields.tags', op: 'is_empty' }, B)).toBe(true);
    expect(m({ field: 'fields.tags', op: 'not_empty' }, A)).toBe(true);
    expect(m({ field: 'fields.unknown', op: 'is_null' }, A)).toBe(true);
  });
  it('labels by id or name (case-insensitive)', () => {
    expect(m({ field: 'labels', op: 'has', value: 'regulatory' }, A)).toBe(true);
    expect(m({ field: 'labels', op: 'has', value: 'l2' }, B)).toBe(true);
    expect(m({ field: 'labels', op: 'has_any', value: ['l1', 'nope'] }, B)).toBe(false);
    expect(m({ field: 'labels', op: 'has_all', value: ['Regulatory', 'tech-debt'] }, A)).toBe(true);
    expect(m({ field: 'labels', op: 'is_empty' }, C)).toBe(true);
    expect(m({ field: 'labels', op: 'nin', value: ['tech-debt'] }, C)).toBe(true);
    // names from the view column when no label lookup is present
    const bare: EvalLookups = { states: {}, types: {}, projects: {} };
    expect(matchesFilter({ field: 'labels', op: 'has', value: 'Quick-Win' }, { ...C, label_names: ['quick-win'] }, ctx, bare)).toBe(true);
  });
  it('search match is a case-insensitive substring over key/title/description', () => {
    expect(m({ field: 'search', op: 'match', value: 'REGULATORY' }, B)).toBe(true);
    expect(m({ field: 'search', op: 'match', value: 'rates-b' }, B)).toBe(true);
    expect(m({ field: 'search', op: 'match', value: 'swaption' }, B)).toBe(false);
    expect(m({ field: 'search', op: 'match', value: '  ' }, B)).toBe(true);
  });
  it('and/or/not nesting and undefined expr', () => {
    expect(m(undefined, A)).toBe(true);
    expect(m({ and: [] }, A)).toBe(true);
    expect(m({ or: [] }, A)).toBe(false);
    expect(m({ or: [{ field: 'priority', op: 'eq', value: 9 }, { not: { field: 'assignee_id', op: 'is_null' } }] }, A)).toBe(true);
    expect(m({ not: { and: [{ field: 'priority', op: 'eq', value: 1 }, { field: 'type.key', op: 'eq', value: 'bug' }] } }, A)).toBe(false);
  });
  it('throws on unknown fields/ops', () => {
    expect(() => m({ field: 'nope', op: 'eq', value: 1 }, A)).toThrow(/unknown field/);
    expect(() => m({ field: 'labels', op: 'lt', value: 1 }, A)).toThrow();
  });
});

describe('matchesSpec / runSpec', () => {
  it('excludes deleted and archived rows (unless include_archived) and applies visibleProjectIds', () => {
    expect(matchesSpec({}, D, ctx, lookups)).toBe(false);
    expect(matchesSpec({ include_archived: true }, D, ctx, lookups)).toBe(true);
    expect(matchesSpec({ include_archived: true }, E, ctx, lookups)).toBe(false);
    expect(matchesSpec({}, A, { ...ctx, visibleProjectIds: ['other'] }, lookups)).toBe(false);
    expect(matchesSpec({}, A, { ...ctx, visibleProjectIds: 'all' }, lookups)).toBe(true);
  });
  it('default sort is sort_order asc, created_at desc, id', () => {
    expect(runSpec({}, items, ctx, lookups).items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
  it('applies limit/offset after sorting and groups the page', () => {
    const r = runSpec({ sort: [{ field: 'priority', dir: 'desc' }], limit: 2, offset: 1, group_by: 'state.category' }, items, ctx, lookups);
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b']); // grouped order: in_progress(a) < done(b); todo(c) is offset away
    expect(r.groups!.map((g) => [g.key, g.label])).toEqual([['in_progress', 'In progress'], ['done', 'Done']]);
  });
  it('returns groups null without group_by', () => {
    expect(runSpec({}, items, ctx, lookups).groups).toBeNull();
  });
});

describe('sortItems', () => {
  it('is stable, multi-key, nulls last by default, honours nulls first', () => {
    expect(sortItems([A, B, C], [{ field: 'due_date', dir: 'asc' }], lookups).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(sortItems([A, B, C], [{ field: 'due_date', dir: 'desc' }], lookups).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(sortItems([A, B, C], [{ field: 'due_date', dir: 'asc', nulls: 'first' }], lookups).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(sortItems([A, B, C], [{ field: 'estimate', dir: 'desc' }], lookups).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(sortItems([A, B, C], [{ field: 'title', dir: 'asc' }], lookups).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(sortItems([A, B, C], [{ field: 'state_id', dir: 'asc' }], lookups).map((i) => i.id)).toEqual(['c', 'a', 'b']); // workflow order
    expect(sortItems([A, B, C], [{ field: 'state.category', dir: 'desc' }], lookups).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(sortItems([A, B, C], [{ field: 'type_id', dir: 'asc' }, { field: 'priority', dir: 'desc' }], lookups).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(sortItems([A, B], [{ field: 'fields.budget', dir: 'asc' }], lookups).map((i) => i.id)).toEqual(['a', 'b']);
    expect(() => sortItems([A], [{ field: 'labels', dir: 'asc' }], lookups)).toThrow(/not sortable/);
  });
  it('does not mutate the input', () => {
    const arr = [B, A];
    sortItems(arr, [{ field: 'priority', dir: 'asc' }], lookups);
    expect(arr.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('groupItems', () => {
  it('labels groups via lookups', () => {
    const g = (f: string) => groupItems([A, B, C], f, lookups).map((x) => [x.key, x.label, x.items.map((i) => i.id)]);
    expect(g('state_id')).toEqual([['s-todo', 'todo', ['c']], ['s-prog', 'in progress', ['a']], ['s-done', 'done', ['b']]]);
    expect(g('assignee_id')).toEqual([['alice', 'Alice Chen', ['a']], ['bob', 'bob', ['b']], ['', 'Unassigned', ['c']]]);
    expect(g('priority')).toEqual([['1', 'Urgent', ['a']], ['2', 'High', ['c']], ['3', 'Medium', ['b']]]);
    expect(groupItems([{ ...C, priority: 0 }], 'priority', lookups)[0]!.label).toBe('None');
    expect(g('type_id')).toEqual([['t-task', 'Task', ['b', 'c']], ['t-bug', 'Bug', ['a']]]);
    expect(g('project_id')).toEqual([['p1', 'Rates', ['a', 'b', 'c']]]);
    expect(g('fields.severity')).toEqual([['s1', 'S1 – Critical', ['a']], ['', 'None', ['b', 'c']]]);
    expect(g('is_blocked')).toEqual([['false', 'No', ['a', 'b']], ['true', 'Yes', ['c']]]);
    expect(groupItems([A, B], null, lookups)).toEqual([{ key: '', label: 'All', items: [A, B] }]);
    expect(() => groupItems([A], 'labels', lookups)).toThrow();
  });
});
