// ============================================================================
// Client-side QuerySpec evaluator. Semantics mirror query/compile.ts exactly
// (asserted by query/parity.test.ts against an in-memory SQLite database with
// the real migration applied). Rows are the shape @pm/db hydrates from
// work_items_v: `fields` parsed, `label_names` an array, is_blocked/confidential
// booleans, dates 'YYYY-MM-DD' text and timestamps ISO text.
// ============================================================================
import type { FilterExpr, QuerySpec, QueryContext, SortSpec, FieldRef, ValueMacro } from './spec.js';
import { STATE_CATEGORY_ORDER } from './spec.js';
import type { WorkItem, WorkflowState, ItemType, Project, Label, User, FieldDef } from '../schema/entities.js';
import { PRIORITY_LABELS } from '../schema/entities.js';
import {
  resolveValueMacro as resolveMacroImpl, resolveField, coerceTemporal, withinDaysBounds, toArray, coerceScalar,
  type ResolvedField, type ValueKind,
} from './common.js';

/** A work item joined with what the client has locally. Same shape the server's work_items_v exposes. */
export interface ItemRow extends WorkItem {
  state_category?: string;
  state_key?: string;
  state_name?: string;
  type_key?: string;
  type_name?: string;
  project_key?: string;
  project_name?: string;
  assignee_name?: string | null;
  label_ids?: string[];
  label_names?: string[] | null;
  parent_id?: string | null;
  is_blocked?: boolean;
}

/** Lookup tables the client passes so dotted fields resolve without joins. */
export interface EvalLookups {
  states: Record<string, WorkflowState>;
  types: Record<string, ItemType>;
  projects: Record<string, Project>;
  labelIdsByItem?: Record<string, string[]>;
  parentByItem?: Record<string, string>;
  blockedItems?: Set<string>;
  /** Optional: label id -> Label, so `labels has <name>` works locally and groups get names. */
  labels?: Record<string, Label>;
  /** Optional: user id -> User, for assignee/reporter group labels. */
  users?: Record<string, User>;
}

export const VALUE_MACROS: ValueMacro[] = ['$me', '$today', '$now', '$start_of_week', '$end_of_week', '$start_of_month'];

export function resolveMacro(value: unknown, ctx: QueryContext): unknown {
  return resolveMacroImpl(value, ctx);
}

// ---------------------------------------------------------------------------
// Field access
// ---------------------------------------------------------------------------
const NUMBER_FIELDS = new Set(['number', 'priority', 'estimate', 'sort_order']);
const DATETIME_FIELDS = new Set(['created_at', 'updated_at', 'completed_at', 'archived_at', 'deleted_at', 'canceled_at']);
const DATE_FIELDS = new Set(['start_date', 'due_date']);

function normalizeColumn(name: string, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (NUMBER_FIELDS.has(name)) { const n = typeof v === 'number' ? v : Number(v); return Number.isNaN(n) ? v : n; }
  if (v instanceof Date) return DATE_FIELDS.has(name) ? v.toISOString().slice(0, 10) : v.toISOString();
  if (DATE_FIELDS.has(name) && typeof v === 'string' && v.length > 10) return v.slice(0, 10);
  if (DATETIME_FIELDS.has(name) && typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? v : new Date(t).toISOString(); }
  return v;
}

export function labelIdsOf(item: ItemRow, lookups: EvalLookups): string[] {
  return lookups.labelIdsByItem?.[item.id] ?? item.label_ids ?? [];
}

/** Lower-cased label names for an item (from lookups.labels, else the view's label_names column). */
export function labelNamesOf(item: ItemRow, lookups: EvalLookups): string[] {
  if (lookups.labels) {
    const ids = labelIdsOf(item, lookups);
    const names = ids.map((id) => lookups.labels?.[id]?.name).filter((n): n is string => typeof n === 'string');
    if (names.length || !item.label_names) return names.map((n) => n.toLowerCase());
  }
  return (item.label_names ?? []).map((n) => n.toLowerCase());
}

export function getField(item: ItemRow, field: FieldRef, lookups: EvalLookups): unknown {
  switch (field) {
    case 'state.category': return lookups.states[item.state_id]?.category ?? item.state_category ?? null;
    case 'state.key': return lookups.states[item.state_id]?.key ?? item.state_key ?? null;
    case 'type.key': return lookups.types[item.type_id]?.key ?? item.type_key ?? null;
    case 'project.key': return lookups.projects[item.project_id]?.key ?? item.project_key ?? null;
    case 'labels': return labelIdsOf(item, lookups);
    case 'parent_id': return lookups.parentByItem?.[item.id] ?? item.parent_id ?? null;
    case 'is_blocked': return lookups.blockedItems ? lookups.blockedItems.has(item.id) : (item.is_blocked ?? false);
    case 'search': return `${item.key ?? ''} ${item.title ?? ''} ${item.description ?? ''}`;
  }
  if (field.startsWith('fields.')) {
    const v = item.fields?.[field.slice(7)];
    return v === undefined ? null : v;
  }
  return normalizeColumn(field, (item as unknown as Record<string, unknown>)[field]);
}

function fieldDefsForItem(item: ItemRow, lookups: EvalLookups): FieldDef[] | undefined {
  return lookups.types[item.type_id]?.field_defs;
}

/** Resolve a field + its value kind for one item (JSON field kinds come from the item's type defs). */
function resolveForItem(field: FieldRef, item: ItemRow, lookups: EvalLookups): ResolvedField {
  const defs = fieldDefsForItem(item, lookups);
  const r = resolveField(field, defs ? [defs] : null);
  if (r.kind === 'json' && !r.def) {
    // Unknown key: infer from the runtime value like the SQL compiler treats it as text.
    const v = item.fields?.[r.key];
    if (Array.isArray(v)) return { ...r, valueKind: 'array' };
    if (typeof v === 'number') return { ...r, valueKind: 'number' };
    if (typeof v === 'boolean') return { ...r, valueKind: 'bool' };
  }
  return r;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
function isNil(v: unknown): boolean { return v === null || v === undefined; }

function cmpStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Compare two non-null values of a kind. Returns NaN when not comparable. */
export function compareValues(kind: ValueKind, a: unknown, b: unknown): number {
  switch (kind) {
    case 'number': { const x = Number(a), y = Number(b); if (Number.isNaN(x) || Number.isNaN(y)) return NaN; return x < y ? -1 : x > y ? 1 : 0; }
    case 'bool': { const x = Number(a === true || a === 'true'), y = Number(b === true || b === 'true'); return x - y; }
    case 'date': return cmpStrings(String(a), String(b));
    case 'datetime': { const x = Date.parse(String(a)), y = Date.parse(String(b)); if (Number.isNaN(x) || Number.isNaN(y)) return cmpStrings(String(a), String(b)); return x < y ? -1 : x > y ? 1 : 0; }
    case 'enum': {
      const x = STATE_CATEGORY_ORDER.indexOf(a as never), y = STATE_CATEGORY_ORDER.indexOf(b as never);
      if (x >= 0 && y >= 0) return x - y;
      return cmpStrings(String(a), String(b));
    }
    case 'uuid': return cmpStrings(String(a), String(b));
    case 'text': return String(a).localeCompare(String(b), 'en');
    default: return cmpStrings(JSON.stringify(a), JSON.stringify(b));
  }
}

function eqValues(kind: ValueKind, a: unknown, b: unknown): boolean {
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);
  switch (kind) {
    case 'number': return Number(a) === Number(b);
    case 'bool': return (a === true || a === 'true') === (b === true || b === 'true');
    case 'datetime': { const x = Date.parse(String(a)), y = Date.parse(String(b)); return Number.isNaN(x) || Number.isNaN(y) ? String(a) === String(b) : x === y; }
    case 'array': return JSON.stringify(a) === JSON.stringify(b);
    default: return String(a) === String(b);
  }
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

function isEmptyValue(v: unknown): boolean {
  return isNil(v) || v === '' || (Array.isArray(v) && v.length === 0);
}

function matchesLabels(op: string, value: unknown, item: ItemRow, lookups: EvalLookups): boolean {
  const ids = labelIdsOf(item, lookups);
  const names = labelNamesOf(item, lookups);
  const hit = (v: unknown) => { const s = String(v); return ids.includes(s) || names.includes(s.toLowerCase()); };
  const vals = toArray(value);
  switch (op) {
    case 'has': case 'eq': return hit(value);
    case 'neq': return !hit(value);
    case 'has_any': case 'in': return vals.some(hit);
    case 'nin': return !vals.some(hit);
    case 'has_all': return vals.every(hit);
    case 'is_null': case 'is_empty': return ids.length === 0;
    case 'not_null': case 'not_empty': return ids.length > 0;
    default: throw new Error(`op ${op} is not supported on labels`);
  }
}

function matchesArray(op: string, value: unknown, raw: unknown): boolean {
  const arr: unknown[] = Array.isArray(raw) ? raw : isNil(raw) ? [] : [raw];
  const present = !isNil(raw) && (!Array.isArray(raw) || raw.length > 0);
  const hit = (v: unknown) => arr.some((x) => eqValues('text', x, v) || eqValues('array', x, v));
  const vals = toArray(value);
  switch (op) {
    case 'has': case 'eq': return hit(value);
    case 'neq': return !hit(value);
    case 'has_any': case 'in': return vals.some(hit);
    case 'nin': return !vals.some(hit);
    case 'has_all': return vals.every(hit);
    case 'is_null': case 'is_empty': return !present;
    case 'not_null': case 'not_empty': return present;
    case 'contains': return present && arr.some((x) => textOf(x).toLowerCase().includes(String(value).toLowerCase()));
    case 'starts_with': return present && arr.some((x) => textOf(x).toLowerCase().startsWith(String(value).toLowerCase()));
    default: throw new Error(`op ${op} is not supported on array fields`);
  }
}

function matchesLeaf(expr: { field: FieldRef; op: string; value?: unknown }, item: ItemRow, ctx: QueryContext, lookups: EvalLookups): boolean {
  const { field, op } = expr;
  const value = resolveMacroImpl(expr.value, ctx);
  if (field === 'labels') return matchesLabels(op, value, item, lookups);
  if (field === 'search') {
    if (op !== 'match' && op !== 'contains') throw new Error(`op ${op} is not supported on search`);
    const hay = String(getField(item, 'search', lookups)).toLowerCase();
    return String(value ?? '').trim() === '' ? true : hay.includes(String(value).toLowerCase());
  }
  const r = resolveForItem(field, item, lookups);
  const raw = getField(item, field, lookups);
  const kind = r.valueKind;
  if (kind === 'array') return matchesArray(op, value, raw);

  const cv = (v: unknown) => coerceScalar(kind, v, ctx);
  switch (op) {
    case 'eq': case 'has': return isNil(value) ? isNil(raw) : eqValues(kind, raw, cv(value));
    case 'neq': return isNil(value) ? !isNil(raw) : !eqValues(kind, raw, cv(value));
    case 'in': case 'has_any': {
      const vals = toArray(value);
      if (isNil(raw)) return vals.some(isNil);
      return vals.some((v) => !isNil(v) && eqValues(kind, raw, cv(v)));
    }
    case 'nin': {
      const vals = toArray(value);
      if (isNil(raw)) return !vals.some(isNil);
      return !vals.some((v) => !isNil(v) && eqValues(kind, raw, cv(v)));
    }
    case 'has_all': { const vals = toArray(value); return vals.length > 0 && vals.every((v) => !isNil(v) && eqValues(kind, raw, cv(v))); }
    case 'lt': case 'before': { if (isNil(raw) || isNil(value)) return false; const c = compareValues(kind, raw, cv(value)); return c < 0; }
    case 'lte': { if (isNil(raw) || isNil(value)) return false; const c = compareValues(kind, raw, cv(value)); return c <= 0; }
    case 'gt': case 'after': { if (isNil(raw) || isNil(value)) return false; const c = compareValues(kind, raw, cv(value)); return c > 0; }
    case 'gte': { if (isNil(raw) || isNil(value)) return false; const c = compareValues(kind, raw, cv(value)); return c >= 0; }
    case 'contains': case 'match': return !isNil(raw) && textOf(raw).toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'starts_with': return !isNil(raw) && textOf(raw).toLowerCase().startsWith(String(value ?? '').toLowerCase());
    case 'is_null': return isNil(raw);
    case 'not_null': return !isNil(raw);
    case 'is_empty': return kind === 'text' ? isEmptyValue(raw) : isNil(raw);
    case 'not_empty': return kind === 'text' ? !isEmptyValue(raw) : !isNil(raw);
    case 'within_days': {
      if (isNil(raw)) return false;
      const tk = kind === 'datetime' ? 'datetime' : 'date';
      const { start, end } = withinDaysBounds(tk, Number(value), ctx);
      const v = coerceTemporal(tk, raw, ctx);
      if (v === null) return false;
      if (tk === 'date') return v >= start && v <= end;
      const t = Date.parse(v);
      return t >= Date.parse(start) && t < Date.parse(end);
    }
    default: throw new Error(`unsupported filter op: ${op}`);
  }
}

export function matchesFilter(expr: FilterExpr | undefined, item: ItemRow, ctx: QueryContext, lookups: EvalLookups): boolean {
  if (!expr) return true;
  if ('and' in expr) return expr.and.every((e) => matchesFilter(e, item, ctx, lookups));
  if ('or' in expr) return expr.or.length === 0 ? false : expr.or.some((e) => matchesFilter(e, item, ctx, lookups));
  if ('not' in expr) return !matchesFilter(expr.not, item, ctx, lookups);
  return matchesLeaf(expr, item, ctx, lookups);
}

/** Filter + the implicit exclusions every query applies (deleted, archived unless include_archived). */
export function matchesSpec(spec: QuerySpec, item: ItemRow, ctx: QueryContext, lookups: EvalLookups): boolean {
  if (!isNil(item.deleted_at)) return false;
  if (!spec.include_archived && !isNil(item.archived_at)) return false;
  if (ctx.visibleProjectIds && ctx.visibleProjectIds !== 'all' && !ctx.visibleProjectIds.includes(item.project_id)) return false;
  return matchesFilter(spec.filter, item, ctx, lookups);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
export const DEFAULT_SORT: SortSpec[] = [{ field: 'sort_order', dir: 'asc' }, { field: 'created_at', dir: 'desc' }];

/** Value an item sorts by for a field (state_id/type_id sort by their workflow/type order; categories by lifecycle order). */
export function sortValue(item: ItemRow, field: FieldRef, lookups: EvalLookups): { value: unknown; kind: ValueKind } {
  switch (field) {
    case 'state_id': { const s = lookups.states[item.state_id]; return { value: s ? s.sort : null, kind: 'number' }; }
    case 'type_id': { const t = lookups.types[item.type_id]; return { value: t ? t.sort : null, kind: 'number' }; }
    case 'state.category': return { value: getField(item, field, lookups), kind: 'enum' };
  }
  const r = resolveForItem(field, item, lookups);
  if (r.kind === 'builtin' && !r.sortable) throw new Error(`field ${field} is not sortable`);
  let v = getField(item, field, lookups);
  if (r.valueKind === 'date' || r.valueKind === 'datetime') v = isNil(v) ? null : coerceTemporal(r.valueKind, v, { userId: '' });
  return { value: v, kind: r.valueKind };
}

type Comparator = (a: ItemRow, b: ItemRow) => number;

function comparatorFor(s: SortSpec, lookups: EvalLookups): Comparator {
  const dir = s.dir === 'desc' ? -1 : 1;
  const nullsFirst = s.nulls === 'first';
  return (a, b) => {
    const va = sortValue(a, s.field, lookups);
    const vb = sortValue(b, s.field, lookups);
    const an = isNil(va.value), bn = isNil(vb.value);
    if (an && bn) return 0;
    if (an) return nullsFirst ? -1 : 1;
    if (bn) return nullsFirst ? 1 : -1;
    const kind = va.kind === vb.kind ? va.kind : 'text';
    let c = compareValues(kind, va.value, vb.value);
    if (Number.isNaN(c)) c = cmpStrings(String(va.value), String(vb.value));
    return c * dir;
  };
}

/** Group ordering: the group's sort key, then the group value itself (keeps groups contiguous like SQL). */
function groupComparator(groupBy: FieldRef, lookups: EvalLookups): Comparator {
  const bySort = comparatorFor({ field: groupBy, dir: 'asc' }, lookups);
  return (a, b) => bySort(a, b) || cmpStrings(groupKeyOf(getField(a, groupBy, lookups)), groupKeyOf(getField(b, groupBy, lookups)));
}

function chain(cmps: Comparator[]): Comparator {
  return (a, b) => {
    for (const c of cmps) { const r = c(a, b); if (r !== 0) return r; }
    return cmpStrings(a.id, b.id);
  };
}

/** Reject sort keys the SQL compiler would reject (unknown or non-sortable fields) before comparing anything. */
function validateSort(sort: SortSpec[]): void {
  for (const s of sort) {
    const r = resolveField(s.field);
    if (r.kind === 'builtin' && !r.sortable) throw new Error(`field ${s.field} is not sortable`);
  }
}

/** Stable multi-key sort; nulls last unless the key says otherwise; final tiebreaker is the item id (as in SQL). */
export function sortItems(items: ItemRow[], sort: SortSpec[] | undefined, lookups: EvalLookups): ItemRow[] {
  const keys = sort && sort.length ? sort : DEFAULT_SORT;
  validateSort(keys);
  const cmp = chain(keys.map((s) => comparatorFor(s, lookups)));
  return [...items].sort(cmp);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
function groupKeyOf(v: unknown): string {
  if (isNil(v)) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Human label for a group value. */
export function groupLabel(field: FieldRef, value: unknown, item: ItemRow | undefined, lookups: EvalLookups): string {
  if (isNil(value) || value === '') {
    return field === 'assignee_id' ? 'Unassigned' : field === 'parent_id' ? 'No parent' : 'None';
  }
  const s = String(value);
  switch (field) {
    case 'state_id': return lookups.states[s]?.name ?? item?.state_name ?? s;
    case 'type_id': return lookups.types[s]?.name ?? item?.type_name ?? s;
    case 'project_id': return lookups.projects[s]?.name ?? item?.project_name ?? s;
    case 'priority': return PRIORITY_LABELS[Number(s)] ?? s;
    case 'assignee_id': return lookups.users?.[s]?.name ?? item?.assignee_name ?? s;
    case 'reporter_id': case 'created_by': return lookups.users?.[s]?.name ?? s;
    case 'state.category': return titleCase(s);
    case 'is_blocked': case 'confidential': return value === true || value === 'true' ? 'Yes' : 'No';
    case 'parent_id': return s;
  }
  if (field.startsWith('fields.') && item) {
    const def = fieldDefsForItem(item, lookups)?.find((d) => d.key === field.slice(7));
    if (def?.options) {
      const opt = def.options.find((o) => o.value === s);
      if (opt) return opt.label;
    }
    if (def?.kind === 'bool') return value === true ? 'Yes' : 'No';
    if (def?.kind === 'user') return lookups.users?.[s]?.name ?? s;
  }
  return s;
}

export function groupItems(items: ItemRow[], groupBy: FieldRef | null | undefined, lookups: EvalLookups): { key: string; label: string; items: ItemRow[] }[] {
  if (!groupBy) return [{ key: '', label: 'All', items: [...items] }];
  if (groupBy === 'labels' || groupBy === 'search') throw new Error(`cannot group by ${groupBy}`);
  const groups = new Map<string, { key: string; label: string; items: ItemRow[]; first: ItemRow }>();
  for (const item of items) {
    const value = getField(item, groupBy, lookups);
    const key = groupKeyOf(value);
    let g = groups.get(key);
    if (!g) { g = { key, label: groupLabel(groupBy, value, item, lookups), items: [], first: item }; groups.set(key, g); }
    g.items.push(item);
  }
  const groupCmp = groupComparator(groupBy, lookups);
  return [...groups.values()]
    .sort((a, b) => groupCmp(a.first, b.first))
    .map(({ key, label, items: gi }) => ({ key, label, items: gi }));
}

// ---------------------------------------------------------------------------
// runSpec: filter + sort + group + limit (same order of operations as SQL)
// ---------------------------------------------------------------------------
export function runSpec(spec: QuerySpec, items: ItemRow[], ctx: QueryContext, lookups: EvalLookups): { items: ItemRow[]; groups: { key: string; label: string; items: ItemRow[] }[] | null } {
  const filtered = items.filter((it) => matchesSpec(spec, it, ctx, lookups));
  const keys = spec.sort && spec.sort.length ? spec.sort : DEFAULT_SORT;
  validateSort(keys);
  if (spec.group_by === 'labels' || spec.group_by === 'search') throw new Error(`cannot group by ${spec.group_by}`);
  const cmps = keys.map((s) => comparatorFor(s, lookups));
  if (spec.group_by) cmps.unshift(groupComparator(spec.group_by, lookups));
  let sorted = [...filtered].sort(chain(cmps));
  const offset = spec.offset ?? 0;
  if (offset || spec.limit !== undefined) sorted = sorted.slice(offset, spec.limit !== undefined ? offset + spec.limit : undefined);
  return { items: sorted, groups: spec.group_by ? groupItems(sorted, spec.group_by, lookups) : null };
}
