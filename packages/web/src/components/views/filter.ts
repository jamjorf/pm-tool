// Pure helpers for the filter builder: field catalog, ops per kind, Condition[] <-> FilterExpr.
import { BUILTIN_FIELDS, STATE_CATEGORY_ORDER, type FilterExpr, type FilterOp, type ItemType, type FieldDef } from '@pm/core';

export type FieldKindUI = 'text' | 'number' | 'bool' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array' | 'fts';
export type EntityRef = 'user' | 'state' | 'type' | 'project' | 'label' | 'item';

export interface FieldInfo {
  ref: string;
  label: string;
  kind: FieldKindUI;
  sortable: boolean;
  entity?: EntityRef;
  options?: { value: string; label: string }[];
  group: 'Item' | 'Fields';
}

const ENTITY_OF: Record<string, EntityRef> = { assignee_id: 'user', reporter_id: 'user', created_by: 'user', state_id: 'state', type_id: 'type', project_id: 'project', parent_id: 'item' };
const HIDDEN = new Set(['id', 'description', 'number', 'sort_order']);

function kindOfDef(d: FieldDef): FieldKindUI {
  switch (d.kind) {
    case 'number': return 'number';
    case 'bool': return 'bool';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'select': return d.multi ? 'array' : 'enum';
    case 'multi_select': return 'array';
    case 'user': return 'uuid';
    default: return 'text';
  }
}

/** Builtin fields + `fields.<key>` from every item type (deduped by key). */
export function buildFieldCatalog(types: ItemType[]): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const [ref, f] of Object.entries(BUILTIN_FIELDS)) {
    if (HIDDEN.has(ref)) continue;
    const info: FieldInfo = { ref, label: f.label, kind: f.kind, sortable: f.sortable, entity: ENTITY_OF[ref], group: 'Item' };
    if (ref === 'labels') info.entity = 'label';
    if (ref === 'state.category') info.options = STATE_CATEGORY_ORDER.map((c) => ({ value: c, label: c.replace('_', ' ') }));
    if (ref === 'priority') { info.kind = 'enum'; info.options = [{ value: '0', label: 'None' }, { value: '1', label: 'Urgent' }, { value: '2', label: 'High' }, { value: '3', label: 'Medium' }, { value: '4', label: 'Low' }]; }
    out.push(info);
  }
  const seen = new Set<string>();
  for (const t of types) {
    for (const d of t.field_defs) {
      const ref = `fields.${d.key}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const info: FieldInfo = { ref, label: `${d.label} (${t.name})`, kind: kindOfDef(d), sortable: true, group: 'Fields' };
      if (d.options) info.options = d.options.map((o) => ({ value: o.value, label: o.label }));
      if (d.kind === 'user') info.entity = 'user';
      out.push(info);
    }
  }
  return out;
}

export const OPS_BY_KIND: Record<FieldKindUI, FilterOp[]> = {
  text: ['contains', 'eq', 'neq', 'starts_with', 'is_empty', 'not_empty', 'is_null', 'not_null'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'],
  bool: ['eq'],
  date: ['eq', 'before', 'after', 'within_days', 'is_null', 'not_null'],
  datetime: ['before', 'after', 'within_days', 'is_null', 'not_null'],
  uuid: ['eq', 'neq', 'in', 'nin', 'is_null', 'not_null'],
  enum: ['eq', 'neq', 'in', 'nin'],
  array: ['has', 'has_any', 'has_all', 'is_empty', 'not_empty'],
  fts: ['match'],
};

export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is', neq: 'is not', in: 'is any of', nin: 'is none of', lt: '<', lte: '≤', gt: '>', gte: '≥',
  contains: 'contains', starts_with: 'starts with', is_null: 'is empty', not_null: 'is set', is_empty: 'is empty', not_empty: 'is not empty',
  has: 'has', has_any: 'has any of', has_all: 'has all of', match: 'matches', before: 'before', after: 'after', within_days: 'within days',
};

export const NO_VALUE_OPS = new Set<FilterOp>(['is_null', 'not_null', 'is_empty', 'not_empty']);
export const MULTI_VALUE_OPS = new Set<FilterOp>(['in', 'nin', 'has_any', 'has_all']);
export const DATE_MACROS = ['$today', '$now', '$start_of_week', '$end_of_week', '$start_of_month'] as const;

export interface Condition { field: string; op: FilterOp; value?: unknown }

function isCondition(e: FilterExpr): e is { field: string; op: FilterOp; value?: unknown } {
  return 'field' in e;
}

/** Flatten a top-level AND into editable conditions; anything else is kept verbatim in `rest`. */
export function toConditions(expr: FilterExpr | undefined | null): { conditions: Condition[]; rest: FilterExpr[] } {
  if (!expr) return { conditions: [], rest: [] };
  const parts: FilterExpr[] = 'and' in expr ? expr.and : [expr];
  const conditions: Condition[] = [];
  const rest: FilterExpr[] = [];
  for (const p of parts) {
    if (isCondition(p)) conditions.push({ field: p.field, op: p.op, ...(p.value !== undefined ? { value: p.value } : {}) });
    else rest.push(p);
  }
  return { conditions, rest };
}

/** Inverse of toConditions: one condition → itself; several → `{ and }`; none → undefined. */
export function fromConditions(conditions: Condition[], rest: FilterExpr[] = []): FilterExpr | undefined {
  const parts: FilterExpr[] = [
    ...conditions.map((c) => (c.value === undefined || NO_VALUE_OPS.has(c.op) ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: c.value })),
    ...rest,
  ];
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { and: parts };
}

export function defaultOpFor(info: FieldInfo | undefined): FilterOp {
  return info ? OPS_BY_KIND[info.kind][0]! : 'eq';
}

export function defaultValueFor(info: FieldInfo | undefined, op: FilterOp): unknown {
  if (NO_VALUE_OPS.has(op)) return undefined;
  if (MULTI_VALUE_OPS.has(op)) return [];
  if (!info) return '';
  if (info.kind === 'bool') return true;
  if (info.kind === 'number') return 0;
  if (info.kind === 'date' && op === 'within_days') return 7;
  if (info.kind === 'date' || info.kind === 'datetime') return '$today';
  if (info.entity === 'user') return '$me';
  if (info.options?.length) return info.options[0]!.value;
  return '';
}

export const DEFAULT_COLUMNS = ['key', 'title', 'state_id', 'assignee_id', 'priority', 'due_date', 'labels'];
