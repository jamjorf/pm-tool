// ============================================================================
// QuerySpec -> parameterized SQL over `work_items_v w`.
//
// Safety: field names only ever come from the BUILTIN_FIELDS allowlist or a
// regex-validated `fields.<key>`; every user-supplied VALUE goes into
// `values` ($n) and is cast in SQL (`$n::uuid`, `$n::text[]`, `$n::text::jsonb`)
// so the same text works under both the `postgres` and `pg` drivers.
//
// Semantics (mirrored by query/evaluate.ts; see query/parity.test.ts):
//   eq/neq       neq includes NULLs (`is distinct from`); value null = is_null/not_null
//   in/nin       nin includes NULLs; a null inside the array matches NULL rows
//   lt/lte/gt/gte  NULL never matches
//   contains/starts_with  case-insensitive (ILIKE with escaped pattern)
//   is_empty/not_empty    text: null or ''; arrays: no elements; others: null
//   has/has_any/has_all   labels: EXISTS over work_item_labels (value = label id OR name,
//                         case-insensitive); multi JSONB: @> / ?| / ?&; scalars: eq / in / all-eq
//   match        field `search`: w.search @@ websearch_to_tsquery('english', $n)
//                (ts_rank ordering when the spec has no explicit sort); other text fields: contains
//   before/after date comparison (< / >); within_days N: [today, today+N] (N<0: [today+N, today])
//   macros       $me $today $now $start_of_week $end_of_week $start_of_month (resolved in TS)
//   sort         nulls last by default; state_id/type_id sort by workflow/type order;
//                default `sort_order asc, created_at desc`; `w.id` is always the final tiebreaker
//   group_by     adds `__group` (the group value) and orders by it first
//   always       deleted_at is null; archived_at is null unless include_archived
// ============================================================================
import type { QuerySpec, QueryContext, CompiledQuery, Widget, FilterExpr, SortSpec, FieldRef } from './spec.js';
import type { FieldDef } from '../schema/entities.js';
import {
  resolveField, resolveValueMacro as resolveMacro, coerceScalar, coerceTemporal, withinDaysBounds, escapeLike, toArray,
  type ResolvedField, type ValueKind,
} from './common.js';

export interface CompileOptions {
  /** Base relation; default "work_items_v w" (has state_category, type_key, label ids etc.) */
  from?: string;
  /** Field defs by item type key, to type JSONB fields (fields.<key>) correctly */
  fieldDefs?: Record<string, FieldDef[]>;
  /**
   * Extra WHERE fragments already parameterized, e.g. permission scope.
   * Each fragment numbers its own params from $1; the compiler renumbers them,
   * so `visibilityWhere(userId, 0)` can be passed as-is.
   */
  extraWhere?: { text: string; values: unknown[] }[];
  select?: string; // default "w.*"
}

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

const COLUMN: Record<string, string> = {
  id: 'w.id', key: 'w.key', number: 'w.number', title: 'w.title', description: 'w.description',
  project_id: 'w.project_id', type_id: 'w.type_id', state_id: 'w.state_id', priority: 'w.priority',
  assignee_id: 'w.assignee_id', reporter_id: 'w.reporter_id', created_by: 'w.created_by',
  start_date: 'w.start_date', due_date: 'w.due_date', estimate: 'w.estimate', confidential: 'w.confidential',
  sort_order: 'w.sort_order', created_at: 'w.created_at', updated_at: 'w.updated_at',
  completed_at: 'w.completed_at', canceled_at: 'w.canceled_at', archived_at: 'w.archived_at',
  'state.category': 'w.state_category', 'state.key': 'w.state_key', 'type.key': 'w.type_key',
  'project.key': 'w.project_key', parent_id: 'w.parent_id', is_blocked: 'w.is_blocked', search: 'w.search',
};

const CAST: Record<ValueKind, string> = {
  text: '::text', number: '::numeric', bool: '::boolean', date: '::date', datetime: '::timestamptz',
  uuid: '::uuid', enum: '::text', array: '', fts: '',
};

/** SQL expression for comparing a field (enum cast to text, JSONB cast by kind). */
function valueExpr(r: ResolvedField): string {
  if (r.kind === 'builtin') {
    const col = COLUMN[r.name];
    if (!col) throw new Error(`field ${r.name} cannot be used here`);
    return r.valueKind === 'enum' ? `${col}::text` : col;
  }
  const k = r.key; // validated ^[a-z][a-z0-9_]*$
  switch (r.valueKind) {
    case 'number': return `(w.fields->>'${k}')::numeric`;
    case 'bool': return `(w.fields->>'${k}')::boolean`;
    case 'date': return `(w.fields->>'${k}')::date`;
    case 'datetime': return `(w.fields->>'${k}')::timestamptz`;
    case 'array': return `(w.fields->'${k}')`;
    default: return `(w.fields->>'${k}')`;
  }
}

/** SQL expression used for ORDER BY (keeps enum ordering; state/type sort by their declared order). */
function sortExpr(r: ResolvedField): string {
  if (r.kind === 'builtin') {
    if (r.name === 'state_id') return '(select s.sort from workflow_states s where s.id = w.state_id)';
    if (r.name === 'type_id') return '(select t.sort from item_types t where t.id = w.type_id)';
    if (r.name === 'labels' || r.name === 'search' || !r.sortable) throw new Error(`field ${r.name} is not sortable`);
    return COLUMN[r.name]!;
  }
  if (r.valueKind === 'array') return `(w.fields->'${r.key}')::text`;
  return valueExpr(r);
}

function labelsWhere(op: string, value: unknown, p: Params): string {
  const exists = (cond: string) =>
    `exists (select 1 from work_item_labels wl join labels l on l.id = wl.label_id and l.deleted_at is null where wl.item_id = w.id and wl.deleted_at is null and ${cond})`;
  const one = (v: unknown) => { const ph = p.add(String(v).toLowerCase()); return exists(`(l.id::text = ${ph}::text or lower(l.name) = ${ph}::text)`); };
  const any = (vals: unknown[]) => {
    if (!vals.length) return 'false';
    const ph = p.add(vals.map((v) => String(v).toLowerCase()));
    return exists(`(l.id::text = any(${ph}::text[]) or lower(l.name) = any(${ph}::text[]))`);
  };
  switch (op) {
    case 'has': case 'eq': return one(value);
    case 'neq': return `not ${one(value)}`;
    case 'has_any': case 'in': return any(toArray(value));
    case 'nin': return `not ${any(toArray(value))}`;
    case 'has_all': {
      const vals = toArray(value);
      if (!vals.length) return 'true';
      const ph = p.add(vals.map((v) => String(v).toLowerCase()));
      return `not exists (select 1 from unnest(${ph}::text[]) v where not ${exists('(l.id::text = v or lower(l.name) = v)')})`;
    }
    case 'is_null': case 'is_empty': return `not ${exists('true')}`;
    case 'not_null': case 'not_empty': return exists('true');
    default: throw new Error(`op ${op} is not supported on labels`);
  }
}

function jsonArrayWhere(expr: string, op: string, value: unknown, p: Params): string {
  const present = `(${expr} is not null and ${expr} <> 'null'::jsonb and ${expr} <> '[]'::jsonb)`;
  const has = (v: unknown) => `coalesce(${expr} @> ${p.add(JSON.stringify([v]))}::text::jsonb, false)`;
  const anyOf = (vals: unknown[]) => vals.length ? `coalesce(${expr} ?| ${p.add(vals.map(String))}::text[], false)` : 'false';
  switch (op) {
    case 'has': case 'eq': return has(value);
    case 'neq': return `not ${has(value)}`;
    case 'has_any': case 'in': return anyOf(toArray(value));
    case 'nin': return `not ${anyOf(toArray(value))}`;
    case 'has_all': { const vals = toArray(value); return vals.length ? `coalesce(${expr} ?& ${p.add(vals.map(String))}::text[], false)` : 'true'; }
    case 'is_null': case 'is_empty': return `not ${present}`;
    case 'not_null': case 'not_empty': return present;
    case 'contains': return `${expr}::text ilike ${p.add(`%${escapeLike(String(value))}%`)}::text`;
    case 'starts_with': return `(${present} and exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${expr}) = 'array' then ${expr} else jsonb_build_array(${expr}) end) e where e ilike ${p.add(`${escapeLike(String(value))}%`)}::text))`;
    default: throw new Error(`op ${op} is not supported on array fields`);
  }
}

function compileLeaf(leaf: { field: FieldRef; op: string; value?: unknown }, ctx: QueryContext, p: Params, opts: CompileOptions): string {
  const { field, op } = leaf;
  const value = resolveMacro(leaf.value, ctx);
  if (field === 'labels') return labelsWhere(op, value, p);
  if (field === 'search') {
    if (op !== 'match' && op !== 'contains') throw new Error(`op ${op} is not supported on search`);
    const q = String(value ?? '').trim();
    if (!q) return 'true';
    return `w.search @@ websearch_to_tsquery('english', ${p.add(q)}::text)`;
  }
  const r = resolveField(field, opts.fieldDefs);
  const expr = valueExpr(r);
  const kind = r.valueKind;
  if (kind === 'array') return jsonArrayWhere(expr, op, value, p);
  const cast = CAST[kind];
  const cv = (v: unknown) => coerceScalar(kind, v, ctx);
  const param = (v: unknown) => `${p.add(cv(v))}${cast}`;
  const inList = (vals: unknown[], negate: boolean) => {
    const nonNull = vals.filter((v) => v !== null && v !== undefined).map(cv);
    const hasNull = nonNull.length !== vals.length;
    const parts: string[] = [];
    if (nonNull.length) parts.push(`${expr} = any(${p.add(nonNull)}${cast}[])`);
    if (hasNull) parts.push(`${expr} is null`);
    const pos = parts.length ? `(${parts.join(' or ')})` : 'false';
    if (!negate) return pos;
    // nin: rows with NULL match unless null was in the list
    return hasNull ? `not ${pos}` : `(${expr} is null or not ${pos})`;
  };
  switch (op) {
    case 'eq': case 'has': return value === null || value === undefined ? `${expr} is null` : `${expr} = ${param(value)}`;
    case 'neq': return value === null || value === undefined ? `${expr} is not null` : `${expr} is distinct from ${param(value)}`;
    case 'in': case 'has_any': return inList(toArray(value), false);
    case 'nin': return inList(toArray(value), true);
    case 'has_all': { const vals = toArray(value); if (!vals.length) return 'false'; return `(${vals.map((v) => (v === null || v === undefined ? 'false' : `${expr} = ${param(v)}`)).join(' and ')})`; }
    case 'lt': case 'before': return `${expr} < ${param(value)}`;
    case 'lte': return `${expr} <= ${param(value)}`;
    case 'gt': case 'after': return `${expr} > ${param(value)}`;
    case 'gte': return `${expr} >= ${param(value)}`;
    case 'contains': case 'match': return `(${expr})::text ilike ${p.add(`%${escapeLike(String(value ?? ''))}%`)}::text`;
    case 'starts_with': return `(${expr})::text ilike ${p.add(`${escapeLike(String(value ?? ''))}%`)}::text`;
    case 'is_null': return `${expr} is null`;
    case 'not_null': return `${expr} is not null`;
    case 'is_empty': return kind === 'text' ? `(${expr} is null or ${expr} = '')` : `${expr} is null`;
    case 'not_empty': return kind === 'text' ? `(${expr} is not null and ${expr} <> '')` : `${expr} is not null`;
    case 'within_days': {
      const tk = kind === 'datetime' ? 'datetime' : 'date';
      const { start, end } = withinDaysBounds(tk, Number(value), ctx);
      if (tk === 'date') return `(${expr} >= ${p.add(start)}::date and ${expr} <= ${p.add(end)}::date)`;
      return `(${expr} >= ${p.add(start)}::timestamptz and ${expr} < ${p.add(end)}::timestamptz)`;
    }
    default: throw new Error(`unsupported filter op: ${op}`);
  }
}

function compileFilter(expr: FilterExpr | undefined, ctx: QueryContext, p: Params, opts: CompileOptions): string {
  if (!expr) return 'true';
  if ('and' in expr) return expr.and.length ? `(${expr.and.map((e) => compileFilter(e, ctx, p, opts)).join(' and ')})` : 'true';
  if ('or' in expr) return expr.or.length ? `(${expr.or.map((e) => compileFilter(e, ctx, p, opts)).join(' or ')})` : 'false';
  if ('not' in expr) return `(not ${compileFilter(expr.not, ctx, p, opts)})`;
  return compileLeaf(expr, ctx, p, opts);
}

/** Find the first `search match` leaf (for ts_rank ordering). */
function findSearchTerm(expr: FilterExpr | undefined, ctx: QueryContext): string | null {
  if (!expr) return null;
  if ('and' in expr) { for (const e of expr.and) { const t = findSearchTerm(e, ctx); if (t) return t; } return null; }
  if ('or' in expr) { for (const e of expr.or) { const t = findSearchTerm(e, ctx); if (t) return t; } return null; }
  if ('not' in expr) return null;
  if (expr.field === 'search' && (expr.op === 'match' || expr.op === 'contains')) {
    const q = String(resolveMacro(expr.value, ctx) ?? '').trim();
    return q || null;
  }
  return null;
}

function compileSort(sort: SortSpec[] | undefined, opts: CompileOptions): string[] {
  if (!sort || !sort.length) return ['w.sort_order asc', 'w.created_at desc'];
  return sort.map((s) => {
    const r = resolveField(s.field, opts.fieldDefs);
    const dir = s.dir === 'desc' ? 'desc' : 'asc';
    const nulls = s.nulls === 'first' ? 'first' : 'last';
    return `${sortExpr(r)} ${dir} nulls ${nulls}`;
  });
}

function baseWhere(spec: { include_archived?: boolean }, ctx: QueryContext, p: Params, opts: CompileOptions, filter: FilterExpr | undefined): string[] {
  const where: string[] = ['w.deleted_at is null'];
  if (!spec.include_archived) where.push('w.archived_at is null');
  if (ctx.visibleProjectIds && ctx.visibleProjectIds !== 'all') where.push(`w.project_id = any(${p.add(ctx.visibleProjectIds)}::uuid[])`);
  const f = compileFilter(filter, ctx, p, opts);
  if (f !== 'true') where.push(f);
  for (const frag of opts.extraWhere ?? []) {
    const offset = p.values.length;
    const text = frag.text.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
    p.values.push(...frag.values);
    where.push(`(${text})`);
  }
  return where;
}

/** Compile a QuerySpec to parameterized SQL over work_items_v. */
export function compileQuery(spec: QuerySpec, ctx: QueryContext, opts: CompileOptions = {}): CompiledQuery {
  const p = new Params();
  const from = opts.from ?? 'work_items_v w';
  let select = opts.select ?? 'w.*';
  const where = baseWhere(spec, ctx, p, opts, spec.filter);
  const order: string[] = [];
  if (spec.group_by) {
    const g = resolveField(spec.group_by, opts.fieldDefs);
    if (g.kind === 'builtin' && (g.name === 'labels' || g.name === 'search')) throw new Error(`cannot group by ${g.name}`);
    select += `, ${valueExpr(g)} as __group`;
    // order by the group's sort key, then by the group value itself so groups are contiguous
    // even when two values share a sort key (e.g. states of different workflows).
    order.push(`${sortExpr(g)} asc nulls last`);
    if (sortExpr(g) !== valueExpr(g)) order.push(`${valueExpr(g)} asc nulls last`);
  }
  if (!spec.sort || !spec.sort.length) {
    const term = findSearchTerm(spec.filter, ctx);
    if (term) order.push(`ts_rank(w.search, websearch_to_tsquery('english', ${p.add(term)}::text)) desc`);
  }
  order.push(...compileSort(spec.sort, opts), 'w.id asc');
  let text = `select ${select} from ${from} where ${where.join(' and ')} order by ${order.join(', ')}`;
  if (spec.limit !== undefined) text += ` limit ${p.add(spec.limit)}::int`;
  if (spec.offset) text += ` offset ${p.add(spec.offset)}::int`;
  return { text, values: p.values, isAggregate: false };
}

function measureExpr(widget: Widget, opts: CompileOptions): string {
  const numericField = () => {
    if (!widget.measure_field) throw new Error(`measure ${widget.measure} requires measure_field`);
    const r = resolveField(widget.measure_field, opts.fieldDefs);
    if (r.valueKind !== 'number') throw new Error(`measure_field ${widget.measure_field} is not numeric`);
    return valueExpr(r);
  };
  switch (widget.measure ?? 'count') {
    case 'count': return 'count(*)::int';
    case 'sum_estimate': return 'coalesce(sum(w.estimate), 0)::float';
    case 'avg_estimate': return 'avg(w.estimate)::float';
    case 'sum_field': return `coalesce(sum(${numericField()}), 0)::float`;
    case 'avg_field': return `avg(${numericField()})::float`;
    default: throw new Error(`unknown measure: ${String(widget.measure)}`);
  }
}

/** Compile a dashboard widget into an aggregate query (group_by + measure). */
export function compileWidget(widget: Widget, ctx: QueryContext, opts: CompileOptions = {}): CompiledQuery {
  const p = new Params();
  const from = opts.from ?? 'work_items_v w';
  const where = baseWhere(widget.query ?? {}, ctx, p, opts, widget.query?.filter);
  const measure = measureExpr(widget, opts);
  if (!widget.group_by) {
    return { text: `select null::text as key, ${measure} as value from ${from} where ${where.join(' and ')}`, values: p.values, isAggregate: true };
  }
  const g = resolveField(widget.group_by, opts.fieldDefs);
  if (g.kind === 'builtin' && (g.name === 'labels' || g.name === 'search')) throw new Error(`cannot group by ${g.name}`);
  let key: string;
  let order: string;
  if (widget.time_bucket) {
    if (g.valueKind !== 'date' && g.valueKind !== 'datetime') throw new Error(`time_bucket requires a date field, got ${widget.group_by}`);
    const bucket = widget.time_bucket === 'day' ? 'day' : widget.time_bucket === 'week' ? 'week' : 'month';
    const expr = g.valueKind === 'datetime' ? `(${valueExpr(g)} at time zone ${p.add(ctx.tz || 'UTC')}::text)` : `${valueExpr(g)}::timestamp`;
    key = `date_trunc('${bucket}', ${expr})::date::text`;
    order = '1 asc nulls last';
  } else {
    key = `(${valueExpr(g)})::text`;
    order = '2 desc, 1 asc nulls last';
  }
  const text = `select ${key} as key, ${measure} as value from ${from} where ${where.join(' and ')} group by 1 order by ${order}`;
  return { text, values: p.values, isAggregate: true };
}

/** Build the permission-scope WHERE fragment for a user (mirrors can_view_item). */
export function visibilityWhere(userId: string, paramOffset: number): { text: string; values: unknown[] } {
  return { text: `can_view_item($${paramOffset + 1}, w.id)`, values: [userId] };
}
