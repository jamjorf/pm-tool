import type { Actor, QueryContext, QuerySpec, Widget, FieldDef } from '@pm/core';
import { compileQuery, compileWidget, visibilityWhere, PRIORITY_LABELS } from '@pm/core';
import type { Q, Row } from './db.js';
import { validation } from './errors.js';
import { stripSearch } from './mutations/helpers.js';

export interface QueryResult {
  items: Row[];
  groups: { key: string; label: string; items: Row[] }[] | null;
  total: number;
}

/** Field defs by item type key (for typed JSONB filters/sorts). */
export async function loadFieldDefs(q: Q): Promise<Record<string, FieldDef[]>> {
  const rows = await q`select key, field_defs from item_types where deleted_at is null`;
  const out: Record<string, FieldDef[]> = {};
  for (const r of rows) out[r.key] = r.field_defs;
  return out;
}

function queryCtx(actor: Actor, tz?: string): QueryContext {
  return { userId: actor.id, tz: tz ?? 'UTC', now: new Date() };
}

/** Compile a spec with the permission scope attached. extraWhere values are numbered first ($1..). */
function compileItems(spec: QuerySpec, actor: Actor, fieldDefs: Record<string, FieldDef[]>, opts: { select?: string; tz?: string } = {}) {
  const ctx = queryCtx(actor, opts.tz);
  const scope = visibilityWhere(actor.id, 0);
  return compileQuery(spec, ctx, { fieldDefs, extraWhere: [scope], ...(opts.select ? { select: opts.select } : {}) });
}

/** Run a QuerySpec: rows from work_items_v (+label_ids), optional JS grouping, total count. */
export async function queryItems(q: Q, actor: Actor, spec: QuerySpec, opts: { tz?: string } = {}): Promise<QueryResult> {
  const fieldDefs = await loadFieldDefs(q);
  const rowSpec: QuerySpec = { ...spec, group_by: null };
  const compiled = compileItems(rowSpec, actor, fieldDefs, { tz: opts.tz });
  let rows: Row[];
  try {
    rows = (await q.unsafe(compiled.text, compiled.values as any[])) as unknown as Row[];
  } catch (e) {
    throw validation(`query failed: ${(e as Error).message}`, { sql: compiled.text });
  }
  rows = rows.map((r) => stripSearch(r));
  await attachLabelIds(q, rows);

  let total = rows.length;
  if (spec.limit !== undefined || spec.offset !== undefined) {
    // The compiler always emits ORDER BY, so count through a subquery rather than a custom select.
    const countSpec: QuerySpec = { ...spec, group_by: null, sort: undefined, limit: undefined, offset: undefined };
    const c = compileItems(countSpec, actor, fieldDefs, { tz: opts.tz, select: 'w.id' });
    const [r] = (await q.unsafe(`select count(*)::int as total from (${c.text}) sub`, c.values as any[])) as unknown as Row[];
    total = Number(r?.total ?? rows.length);
  }
  const groups = spec.group_by ? await groupRows(q, rows, spec.group_by) : null;
  return { items: rows, groups, total };
}

export async function attachLabelIds(q: Q, rows: Row[]) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const labels = await q`select item_id, label_id from work_item_labels where item_id = any(${ids}::uuid[]) and deleted_at is null order by created_at`;
  const by = new Map<string, string[]>();
  for (const l of labels) (by.get(l.item_id) ?? by.set(l.item_id, []).get(l.item_id)!).push(l.label_id);
  for (const r of rows) r.label_ids = by.get(r.id) ?? [];
}

/** Resolve a field ref on a work_items_v row (dotted refs map to the view's display columns). */
export function rowField(row: Row, field: string): unknown {
  if (field.startsWith('fields.')) return row.fields?.[field.slice(7)] ?? null;
  switch (field) {
    case 'state.category': return row.state_category ?? null;
    case 'state.key': return row.state_key ?? null;
    case 'type.key': return row.type_key ?? null;
    case 'project.key': return row.project_key ?? null;
    case 'labels': return row.label_ids ?? row.label_names ?? [];
    default: return row[field] ?? null;
  }
}

/** Group rows in JS by a field ref; labels resolved through lookups (state/user/type/project names). */
export async function groupRows(q: Q, rows: Row[], groupBy: string) {
  const buckets = new Map<string, { key: string; label: string; items: Row[] }>();
  const order: string[] = [];
  for (const r of rows) {
    const raw = rowField(r, groupBy);
    const values = Array.isArray(raw) ? (raw.length ? raw : [null]) : [raw];
    for (const v of values) {
      const key = v === null || v === undefined ? '' : String(v);
      let b = buckets.get(key);
      if (!b) {
        buckets.set(key, (b = { key, label: key || '(none)', items: [] }));
        order.push(key);
      }
      b.items.push(r);
    }
  }
  const labels = await resolveLabels(q, groupBy, order.filter((k) => k));
  for (const b of buckets.values()) if (labels.has(b.key)) b.label = labels.get(b.key)!;
  return order.map((k) => buckets.get(k)!);
}

async function resolveLabels(q: Q, field: string, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  let rows: Row[] = [];
  switch (field) {
    case 'state_id': rows = await q`select id::text as k, name as label from workflow_states where id = any(${keys}::uuid[])`; break;
    case 'assignee_id': case 'reporter_id': case 'created_by': rows = await q`select id::text as k, name as label from users where id = any(${keys}::uuid[])`; break;
    case 'type_id': rows = await q`select id::text as k, name as label from item_types where id = any(${keys}::uuid[])`; break;
    case 'project_id': rows = await q`select id::text as k, key as label from projects where id = any(${keys}::uuid[])`; break;
    case 'parent_id': rows = await q`select id::text as k, key || ' ' || title as label from work_items where id = any(${keys}::uuid[])`; break;
    case 'labels': rows = await q`select id::text as k, name as label from labels where id = any(${keys}::uuid[])`; break;
    case 'priority': for (const k of keys) out.set(k, PRIORITY_LABELS[Number(k)] ?? k); return out;
    default: return out;
  }
  for (const r of rows) out.set(r.k, r.label);
  return out;
}

/** Run a dashboard widget: rows of {key,label,value}. */
export async function runWidget(q: Q, actor: Actor, widget: Widget, opts: { tz?: string } = {}) {
  const fieldDefs = await loadFieldDefs(q);
  const ctx = queryCtx(actor, opts.tz);
  const compiled = compileWidget(widget, ctx, { fieldDefs, extraWhere: [visibilityWhere(actor.id, 0)] });
  let rows: Row[];
  try {
    rows = (await q.unsafe(compiled.text, compiled.values as any[])) as unknown as Row[];
  } catch (e) {
    throw validation(`widget ${widget.id} failed: ${(e as Error).message}`, { sql: compiled.text });
  }
  const out = rows.map((r) => {
    const cols = Object.keys(r);
    const valueCol = cols.find((c) => /^(value|count|measure|sum|avg|total)$/i.test(c)) ?? cols.filter((c) => typeof r[c] === 'number').at(-1) ?? cols.at(-1)!;
    const keyCol = cols.find((c) => c !== valueCol) ?? valueCol;
    const key = r[keyCol] === null || r[keyCol] === undefined ? '' : String(r[keyCol]);
    return { key, label: key || '(none)', value: Number(r[valueCol] ?? 0) };
  });
  if (widget.group_by) {
    const labels = await resolveLabels(q, widget.group_by, out.map((o) => o.key).filter(Boolean));
    for (const o of out) if (labels.has(o.key)) o.label = labels.get(o.key)!;
  }
  return out;
}
