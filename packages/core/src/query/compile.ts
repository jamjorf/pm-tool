// ============================================================================
// QuerySpec -> parameterized SQLite SQL over `work_items_v w`.
//
// Safety: field names only ever come from the BUILTIN_FIELDS allowlist or a
// regex-validated `fields.<key>`; every user-supplied VALUE goes into `values`
// as a positional `?` parameter, never into the text. `values` holds plain
// SQLite scalars only (booleans are passed as 1/0, Dates as ISO text), so the
// same text/values pair works with `sql.unsafe(text, values)` from @pm/db or
// a raw `node:sqlite` statement.
//
// Storage conventions relied on (see packages/db/migrations/0001_init.sql):
//   * booleans are 0/1 integers (confidential; is_blocked from the view)
//   * dates are 'YYYY-MM-DD' text; timestamps are ISO-8601 UTC text with
//     milliseconds and 'Z' — both compare and sort correctly as text, so
//     temporal values are passed as text in the same representation
//   * custom fields live in the JSON text column `fields`: json_extract(w.fields,
//     '$.key') yields text, integer/real, 1/0 for true/false, NULL for a JSON null
//     or a missing key, and the JSON text of an array
//   * full-text search is the FTS5 table work_items_fts (porter unicode61)
//   * the permission scope is the visible_items(user_id, item_id) view
//
// Semantics (mirrored by query/evaluate.ts; see query/parity.test.ts):
//   eq/neq       neq includes NULLs (`expr is not ?`); value null = is_null/not_null
//   in/nin       nin includes NULLs; a null inside the array matches NULL rows
//   lt/lte/gt/gte  NULL never matches; state.category compares by lifecycle order
//                (backlog < todo < in_progress < done < canceled); text compares
//                `collate nocase`
//   contains/starts_with  case-insensitive: lower(expr) like lower(?) escape '\'
//   is_empty/not_empty    text: null or ''; arrays: missing, null or []; others: null
//   has/has_any/has_all   labels: EXISTS over work_item_labels (value = label id OR
//                         name, case-insensitive); multi JSON fields: EXISTS over
//                         json_each(w.fields, '$.key'); scalars: eq / in / all-eq
//   match        field `search`: w.id in (select id from work_items_fts where … match ?).
//                The user text is split on whitespace and every token is quoted as an
//                FTS phrase ("tok1" "tok2" = implicit AND), so FTS syntax can never leak
//                in or error. Without an explicit sort, rows are ordered by bm25 (the
//                first weight is for the unindexed `id` column; key > title > description).
//                On other text fields `match` behaves like `contains`.
//   before/after date comparison (< / >); within_days N: [today, today+N] (N<0: [today+N, today]);
//                for datetime columns the window is [local midnight, midnight after the last day)
//   macros       $me $today $now $start_of_week $end_of_week $start_of_month (resolved in TS)
//   sort         nulls last by default; state_id/type_id sort by workflow/type order;
//                state.category by lifecycle order; text columns `collate nocase`;
//                default `sort_order asc, created_at desc`; `w.id` is always the final tiebreaker
//   group_by     adds `__group` (the raw group value; booleans as 'true'/'false') and
//                orders by its sort key, then the value, first
//   time_bucket  day / week (Monday) / month, computed on the UTC calendar date
//                (substr(col, 1, 10)) on both the SQL and the client side (common.timeBucket)
//   always       deleted_at is null; archived_at is null unless include_archived
// ============================================================================
import type { QuerySpec, QueryContext, CompiledQuery, Widget, FilterExpr, SortSpec, FieldRef } from './spec.js';
import { STATE_CATEGORY_ORDER } from './spec.js';
import type { FieldDef } from '../schema/entities.js';
import {
  resolveField, resolveValueMacro as resolveMacro, coerceScalar, withinDaysBounds, escapeLike, toArray,
  type ResolvedField, type ValueKind,
} from './common.js';

export interface CompileOptions {
  /** Base relation; default "work_items_v w" (has state_category, type_key, label_names, parent_id, is_blocked …) */
  from?: string;
  /** Field defs by item type key, to type JSON fields (fields.<key>) correctly */
  fieldDefs?: Record<string, FieldDef[]>;
  /**
   * Extra WHERE fragments already parameterized with positional `?` placeholders,
   * e.g. permission scope. They are AND-ed in order and their values appended in
   * order, so `visibilityWhere(userId)` can be passed as-is.
   */
  extraWhere?: { text: string; values: unknown[] }[];
  select?: string; // default "w.*"
}

/** Normalize a JS value to a SQLite-bindable scalar (booleans → 1/0, Date → ISO text, objects → JSON text). */
export function toSqlParam(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(toSqlParam(v)); return '?'; }
  /** `(?, ?, ?)` for a non-empty list. */
  list(vals: unknown[]): string { return `(${vals.map((v) => this.add(v)).join(', ')})`; }
}

const COLUMN: Record<string, string> = {
  id: 'w.id', key: 'w.key', number: 'w.number', title: 'w.title', description: 'w.description',
  project_id: 'w.project_id', type_id: 'w.type_id', state_id: 'w.state_id', priority: 'w.priority',
  assignee_id: 'w.assignee_id', reporter_id: 'w.reporter_id', created_by: 'w.created_by',
  start_date: 'w.start_date', due_date: 'w.due_date', estimate: 'w.estimate', confidential: 'w.confidential',
  sort_order: 'w.sort_order', created_at: 'w.created_at', updated_at: 'w.updated_at',
  completed_at: 'w.completed_at', canceled_at: 'w.canceled_at', archived_at: 'w.archived_at',
  'state.category': 'w.state_category', 'state.key': 'w.state_key', 'type.key': 'w.type_key',
  'project.key': 'w.project_key', parent_id: 'w.parent_id', is_blocked: 'w.is_blocked',
};

/** Lifecycle rank of w.state_category (the enum order the client sorts by). */
const CATEGORY_RANK = `case w.state_category ${STATE_CATEGORY_ORDER.map((c, i) => `when '${c}' then ${i}`).join(' ')} end`;

/** JSON path literal for a validated custom-field key (^[a-z][a-z0-9_]*$, so no quoting issues). */
const jsonPath = (key: string) => `'$.${key}'`;

/** SQL expression for comparing a field (JSON fields extracted and cast by kind). */
function valueExpr(r: ResolvedField): string {
  if (r.kind === 'builtin') {
    const col = COLUMN[r.name];
    if (!col) throw new Error(`field ${r.name} cannot be used here`);
    return col;
  }
  const extract = `json_extract(w.fields, ${jsonPath(r.key)})`;
  return r.valueKind === 'number' ? `cast(${extract} as real)` : extract;
}

/** SQL expression used for ORDER BY (state/type sort by their declared order; categories by lifecycle; text case-insensitively). */
function sortExpr(r: ResolvedField): string {
  if (r.kind === 'builtin') {
    if (r.name === 'state_id') return '(select s.sort from workflow_states s where s.id = w.state_id)';
    if (r.name === 'type_id') return '(select t.sort from item_types t where t.id = w.type_id)';
    if (r.name === 'state.category') return CATEGORY_RANK;
    if (r.name === 'labels' || r.name === 'search' || !r.sortable) throw new Error(`field ${r.name} is not sortable`);
  }
  const e = valueExpr(r);
  return r.valueKind === 'text' ? `${e} collate nocase` : e;
}

/** Expression used as a group key: the raw value, except booleans become 'true'/'false' like the client's group keys. */
function groupKeyExpr(r: ResolvedField): string {
  const e = valueExpr(r);
  return r.valueKind === 'bool' ? `case when ${e} is null then null when ${e} then 'true' else 'false' end` : e;
}

/** Build a safe FTS5 MATCH expression from free text: each whitespace token becomes a quoted phrase (implicit AND). */
export function ftsQuery(text: string): string {
  return text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;

/** A value as json_each() would yield it, so `e.value = ?` compares like for like. */
function jsonScalar(v: unknown): unknown {
  if (isNil(v)) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function labelsWhere(op: string, value: unknown, p: Params): string {
  const exists = (cond: string) =>
    `exists (select 1 from work_item_labels wl join labels l on l.id = wl.label_id and l.deleted_at is null where wl.item_id = w.id and wl.deleted_at is null and ${cond})`;
  const one = (v: unknown) => { const s = String(v).toLowerCase(); return exists(`(l.id = ${p.add(s)} or lower(l.name) = ${p.add(s)})`); };
  const any = (vals: unknown[]) => {
    if (!vals.length) return 'false';
    const lows = vals.map((v) => String(v).toLowerCase());
    return exists(`(l.id in ${p.list(lows)} or lower(l.name) in ${p.list(lows)})`);
  };
  switch (op) {
    case 'has': case 'eq': return one(value);
    case 'neq': return `not ${one(value)}`;
    case 'has_any': case 'in': return any(toArray(value));
    case 'nin': return `not ${any(toArray(value))}`;
    case 'has_all': { const vals = toArray(value); return vals.length ? `(${vals.map(one).join(' and ')})` : 'true'; }
    case 'is_null': case 'is_empty': return `not ${exists('true')}`;
    case 'not_null': case 'not_empty': return exists('true');
    default: throw new Error(`op ${op} is not supported on labels`);
  }
}

function jsonArrayWhere(key: string, op: string, value: unknown, p: Params): string {
  const path = jsonPath(key);
  const expr = `json_extract(w.fields, ${path})`;
  const each = `json_each(w.fields, ${path})`; // elements of an array; a lone scalar yields one row; missing/null yields none
  const present = `(${expr} is not null and (json_type(w.fields, ${path}) <> 'array' or json_array_length(w.fields, ${path}) > 0))`;
  const has = (v: unknown) => `exists (select 1 from ${each} e where e.value = ${p.add(jsonScalar(v))})`;
  const anyOf = (vals: unknown[]) => vals.length ? `exists (select 1 from ${each} e where e.value in ${p.list(vals.map(jsonScalar))})` : 'false';
  switch (op) {
    case 'has': case 'eq': return has(value);
    case 'neq': return `not ${has(value)}`;
    case 'has_any': case 'in': return anyOf(toArray(value));
    case 'nin': return `not ${anyOf(toArray(value))}`;
    case 'has_all': {
      const vals = toArray(value);
      if (!vals.length) return 'true';
      return `not exists (select 1 from json_each(${p.add(JSON.stringify(vals))}) req where not exists (select 1 from ${each} e where e.value = req.value))`;
    }
    case 'is_null': case 'is_empty': return `not ${present}`;
    case 'not_null': case 'not_empty': return present;
    case 'contains': return `(${present} and lower(${expr}) like lower(${p.add(`%${escapeLike(String(value ?? ''))}%`)}) escape '\\')`;
    case 'starts_with': return `(${present} and exists (select 1 from ${each} e where lower(e.value) like lower(${p.add(`${escapeLike(String(value ?? ''))}%`)}) escape '\\'))`;
    default: throw new Error(`op ${op} is not supported on array fields`);
  }
}

function compileLeaf(leaf: { field: FieldRef; op: string; value?: unknown }, ctx: QueryContext, p: Params, opts: CompileOptions): string {
  const { field, op } = leaf;
  const value = resolveMacro(leaf.value, ctx);
  if (field === 'labels') return labelsWhere(op, value, p);
  if (field === 'search') {
    if (op !== 'match' && op !== 'contains') throw new Error(`op ${op} is not supported on search`);
    const q = ftsQuery(String(value ?? ''));
    if (!q) return 'true';
    return `w.id in (select f.id from work_items_fts f where f.work_items_fts match ${p.add(q)})`;
  }
  const r = resolveField(field, opts.fieldDefs);
  if (r.valueKind === 'array') {
    if (r.kind !== 'json') throw new Error(`field ${field} cannot be used here`);
    return jsonArrayWhere(r.key, op, value, p);
  }
  const expr = valueExpr(r);
  const kind: ValueKind = r.valueKind;
  const cv = (v: unknown) => coerceScalar(kind, v, ctx);
  const param = (v: unknown) => p.add(cv(v));
  const inList = (vals: unknown[], negate: boolean) => {
    const nonNull = vals.filter((v) => !isNil(v)).map(cv);
    const hasNull = nonNull.length !== vals.length;
    const parts: string[] = [];
    if (nonNull.length) parts.push(`${expr} in ${p.list(nonNull)}`);
    if (hasNull) parts.push(`${expr} is null`);
    const pos = parts.length ? `(${parts.join(' or ')})` : 'false';
    if (!negate) return pos;
    // nin: rows with NULL match unless null was in the list
    return hasNull ? `not ${pos}` : `(${expr} is null or not ${pos})`;
  };
  /** Ordering comparison: categories by lifecycle rank (when the value is a known category), text case-insensitively. */
  const ordered = (sqlOp: string, v: unknown) => {
    if (kind === 'enum') {
      const rank = STATE_CATEGORY_ORDER.indexOf(String(v) as never);
      if (rank >= 0) return `${CATEGORY_RANK} ${sqlOp} ${p.add(rank)}`;
    }
    if (kind === 'text') return `${expr} collate nocase ${sqlOp} ${param(v)}`;
    return `${expr} ${sqlOp} ${param(v)}`;
  };
  const like = (pattern: string) => `lower(${expr}) like lower(${p.add(pattern)}) escape '\\'`;
  switch (op) {
    case 'eq': case 'has': return isNil(value) ? `${expr} is null` : `${expr} = ${param(value)}`;
    case 'neq': return isNil(value) ? `${expr} is not null` : `${expr} is not ${param(value)}`;
    case 'in': case 'has_any': return inList(toArray(value), false);
    case 'nin': return inList(toArray(value), true);
    case 'has_all': { const vals = toArray(value); if (!vals.length) return 'false'; return `(${vals.map((v) => (isNil(v) ? 'false' : `${expr} = ${param(v)}`)).join(' and ')})`; }
    case 'lt': case 'before': return ordered('<', value);
    case 'lte': return ordered('<=', value);
    case 'gt': case 'after': return ordered('>', value);
    case 'gte': return ordered('>=', value);
    case 'contains': case 'match': return like(`%${escapeLike(String(value ?? ''))}%`);
    case 'starts_with': return like(`${escapeLike(String(value ?? ''))}%`);
    case 'is_null': return `${expr} is null`;
    case 'not_null': return `${expr} is not null`;
    case 'is_empty': return kind === 'text' ? `(${expr} is null or ${expr} = '')` : `${expr} is null`;
    case 'not_empty': return kind === 'text' ? `(${expr} is not null and ${expr} <> '')` : `${expr} is not null`;
    case 'within_days': {
      const tk = kind === 'datetime' ? 'datetime' : 'date';
      const { start, end } = withinDaysBounds(tk, Number(value), ctx);
      if (tk === 'date') return `(${expr} >= ${p.add(start)} and ${expr} <= ${p.add(end)})`;
      return `(${expr} >= ${p.add(start)} and ${expr} < ${p.add(end)})`;
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

/** Find the first `search match` leaf and return its FTS query (for bm25 ordering). */
function findSearchTerm(expr: FilterExpr | undefined, ctx: QueryContext): string | null {
  if (!expr) return null;
  if ('and' in expr) { for (const e of expr.and) { const t = findSearchTerm(e, ctx); if (t) return t; } return null; }
  if ('or' in expr) { for (const e of expr.or) { const t = findSearchTerm(e, ctx); if (t) return t; } return null; }
  if ('not' in expr) return null;
  if (expr.field === 'search' && (expr.op === 'match' || expr.op === 'contains')) {
    return ftsQuery(String(resolveMacro(expr.value, ctx) ?? '')) || null;
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
  if (ctx.visibleProjectIds && ctx.visibleProjectIds !== 'all') {
    where.push(ctx.visibleProjectIds.length ? `w.project_id in ${p.list(ctx.visibleProjectIds)}` : 'false');
  }
  const f = compileFilter(filter, ctx, p, opts);
  if (f !== 'true') where.push(f);
  for (const frag of opts.extraWhere ?? []) {
    p.values.push(...frag.values.map(toSqlParam));
    where.push(`(${frag.text})`);
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
    select += `, ${groupKeyExpr(g)} as __group`;
    // order by the group's sort key, then by the group value itself so groups are contiguous
    // even when two values share a sort key (e.g. states of different workflows).
    const bySort = sortExpr(g), byValue = valueExpr(g);
    order.push(`${bySort} asc nulls last`);
    if (bySort !== byValue) order.push(`${byValue} asc nulls last`);
  }
  if (!spec.sort || !spec.sort.length) {
    const term = findSearchTerm(spec.filter, ctx);
    if (term) order.push(`(select bm25(f.work_items_fts, 0.0, 10.0, 5.0, 1.0) from work_items_fts f where f.work_items_fts match ${p.add(term)} and f.id = w.id) asc nulls last`);
  }
  order.push(...compileSort(spec.sort, opts), 'w.id asc');
  let text = `select ${select} from ${from} where ${where.join(' and ')} order by ${order.join(', ')}`;
  if (spec.limit !== undefined) text += ` limit ${p.add(spec.limit)}`;
  else if (spec.offset) text += ' limit -1'; // SQLite needs a LIMIT before OFFSET
  if (spec.offset) text += ` offset ${p.add(spec.offset)}`;
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
    case 'count': return 'count(*)';
    case 'sum_estimate': return 'coalesce(sum(w.estimate), 0)';
    case 'avg_estimate': return 'avg(w.estimate)';
    case 'sum_field': return `coalesce(sum(${numericField()}), 0)`;
    case 'avg_field': return `avg(${numericField()})`;
    default: throw new Error(`unknown measure: ${String(widget.measure)}`);
  }
}

/** SQL for a UTC calendar bucket of a date/datetime text column (mirrors common.timeBucket). */
function timeBucketExpr(col: string, bucket: 'day' | 'week' | 'month'): string {
  const day = `substr(${col}, 1, 10)`;
  switch (bucket) {
    case 'day': return day;
    case 'month': return `(substr(${col}, 1, 7) || '-01')`;
    case 'week': return `date(${day}, '-' || ((cast(strftime('%w', ${day}) as integer) + 6) % 7) || ' days')`;
  }
}

/** Compile a dashboard widget into an aggregate query (group_by + measure). */
export function compileWidget(widget: Widget, ctx: QueryContext, opts: CompileOptions = {}): CompiledQuery {
  const p = new Params();
  const from = opts.from ?? 'work_items_v w';
  const where = baseWhere(widget.query ?? {}, ctx, p, opts, widget.query?.filter);
  const measure = measureExpr(widget, opts);
  if (!widget.group_by) {
    return { text: `select null as key, ${measure} as value from ${from} where ${where.join(' and ')}`, values: p.values, isAggregate: true };
  }
  const g = resolveField(widget.group_by, opts.fieldDefs);
  if (g.kind === 'builtin' && (g.name === 'labels' || g.name === 'search')) throw new Error(`cannot group by ${g.name}`);
  let key: string;
  let order: string;
  if (widget.time_bucket) {
    if (g.valueKind !== 'date' && g.valueKind !== 'datetime') throw new Error(`time_bucket requires a date field, got ${widget.group_by}`);
    const bucket = widget.time_bucket === 'day' ? 'day' : widget.time_bucket === 'week' ? 'week' : 'month';
    key = timeBucketExpr(valueExpr(g), bucket);
    order = '1 asc nulls last';
  } else {
    key = groupKeyExpr(g);
    order = '2 desc, 1 asc nulls last';
  }
  const text = `select ${key} as key, ${measure} as value from ${from} where ${where.join(' and ')} group by 1 order by ${order}`;
  return { text, values: p.values, isAggregate: true };
}

/**
 * Permission-scope WHERE fragment for a user (the visible_items view: project access +
 * the confidential rule). Uses a positional `?`; the offset argument is ignored and
 * only kept for call-site compatibility.
 */
export function visibilityWhere(userId: string, _paramOffset = 0): { text: string; values: unknown[] } {
  return { text: 'exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id)', values: [userId] };
}
