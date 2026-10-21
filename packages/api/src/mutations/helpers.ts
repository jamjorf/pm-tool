import type { Actor, Action, ItemCtx, ProjectCtx, WorkflowDefinition, WorkItem, WatchReason } from '@pm/core';
import { isUuid, nowIso, type Fragment, type Q, type Row } from '../db.js';
import { notFound, validation } from '../errors.js';
import { permissions } from '../core-compat.js';
import type { MutationCtx } from './context.js';

export type ItemRow = WorkItem & Row;

/** Columns of work_items that may be patched (whitelist for dynamic UPDATEs). */
export const ITEM_COLUMNS = new Set([
  'title', 'description', 'type_id', 'state_id', 'priority', 'assignee_id', 'reporter_id', 'start_date', 'due_date',
  'estimate', 'fields', 'confidential', 'sort_order', 'archived_at', 'completed_at', 'canceled_at', 'project_id',
]);

/** The Postgres schema exposed a `search` tsvector on work_items; kept as a no-op guard for rows that still carry one. */
export function stripSearch<T extends Row>(row: T): T {
  if (row && 'search' in row) delete (row as any).search;
  return row;
}

// ---------------------------------------------------------------------------
// Permission predicates (SQL views replace the Postgres functions)
// ---------------------------------------------------------------------------

/** `exists (...)` fragment: can `userId` see the item whose id is `col` (a column reference or a bound value)? */
export function visibleItem(q: Q, userId: string, col: string | Fragment): Fragment {
  const ref = typeof col === 'string' ? q.raw(col) : col;
  return q`exists (select 1 from visible_items vi where vi.user_id = ${userId} and vi.item_id = ${ref})`.fragment;
}

/** `(select project_id ...)` fragment: the projects `userId` has an effective role in (use with `in`). */
export function visibleProjects(q: Q, userId: string): Fragment {
  return q`(select er.project_id from effective_roles er where er.user_id = ${userId})`.fragment;
}

/** `exists (...)` fragment: does `userId` have any role in the project `col`? */
export function hasProjectRole(q: Q, userId: string, col: string | Fragment): Fragment {
  const ref = typeof col === 'string' ? q.raw(col) : col;
  return q`exists (select 1 from effective_roles er where er.user_id = ${userId} and er.project_id = ${ref})`.fragment;
}

export async function effectiveRoleOf(q: Q, userId: string, projectId: string): Promise<string | null> {
  const [r] = await q`select role from effective_roles where user_id = ${userId} and project_id = ${projectId}`;
  return r?.role ?? null;
}

export async function canViewItem(q: Q, userId: string, itemId: string): Promise<boolean> {
  const [r] = await q`select exists (select 1 from visible_items vi where vi.user_id = ${userId} and vi.item_id = ${itemId}) as ok`;
  return !!r?.ok;
}

/** `label_ids` select-list fragment (JSON array of label ids in attach order; hydrated to a JS array). */
export function labelIdsSelect(q: Q, alias = 'w'): Fragment {
  return q.raw(
    `(select json_group_array(label_id) from (select wl.label_id from work_item_labels wl where wl.item_id = ${alias}.id and wl.deleted_at is null order by wl.created_at)) as label_ids`,
  );
}

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------
const RELOADABLE = new Set([
  'users', 'teams', 'workflows', 'workflow_states', 'workflow_transitions', 'item_types', 'projects', 'work_items', 'labels',
  'comments', 'attachments', 'relations', 'views', 'notifications', 'webhook_endpoints',
]);

/** Re-read a row by id. Needed after INSERT/UPDATE because the version/number/key triggers run after RETURNING. */
export async function reload(q: Q, table: string, id: string): Promise<Row> {
  if (!RELOADABLE.has(table)) throw new Error(`reload: unknown table ${table}`);
  const [row] = await q`select * from ${q.raw(table)} where id = ${id}`;
  if (!row) throw notFound(`${table} ${id} not found`);
  return row;
}

export async function getItem(q: Q, id: string, opts: { includeDeleted?: boolean } = {}): Promise<ItemRow> {
  const [row] = opts.includeDeleted
    ? await q`select * from work_items where id = ${id}`
    : await q`select * from work_items where id = ${id} and deleted_at is null`;
  if (!row) throw notFound(`item ${id} not found`);
  return stripSearch(row) as ItemRow;
}

/** Resolve "RATES-12" or a uuid to the item id (404 if unknown). */
export async function resolveItemId(q: Q, keyOrId: string, opts: { includeDeleted?: boolean } = {}): Promise<string> {
  const rows = isUuid(keyOrId)
    ? await q`select id, deleted_at from work_items where id = ${keyOrId}`
    : await q`select id, deleted_at from work_items where upper(key) = upper(${keyOrId})`;
  const row = rows[0];
  if (!row || (row.deleted_at && !opts.includeDeleted)) throw notFound(`item ${keyOrId} not found`);
  return row.id;
}

export async function resolveProjectId(q: Q, keyOrId: string): Promise<string> {
  const rows = isUuid(keyOrId)
    ? await q`select id from projects where id = ${keyOrId} and deleted_at is null`
    : await q`select id from projects where upper(key) = upper(${keyOrId}) and deleted_at is null`;
  if (!rows[0]) throw notFound(`project ${keyOrId} not found`);
  return rows[0].id;
}

export async function getProject(q: Q, id: string): Promise<Row> {
  const [p] = await q`select * from projects where id = ${id} and deleted_at is null`;
  if (!p) throw notFound(`project ${id} not found`);
  return p;
}

export async function getType(q: Q, id: string): Promise<Row> {
  const [t] = await q`select * from item_types where id = ${id} and deleted_at is null`;
  if (!t) throw notFound(`item type ${id} not found`);
  return t;
}

export async function getWorkflowDef(q: Q, workflowId: string): Promise<WorkflowDefinition> {
  const [wf] = await q`select id, key from workflows where id = ${workflowId} and deleted_at is null`;
  if (!wf) throw notFound(`workflow ${workflowId} not found`);
  const states = await q`select * from workflow_states where workflow_id = ${workflowId} and deleted_at is null order by sort`;
  const transitions = await q`select * from workflow_transitions where workflow_id = ${workflowId} and deleted_at is null order by sort`;
  return { id: wf.id, key: wf.key, states: states as any, transitions: transitions as any };
}

export const projectCtx = (p: Row): ProjectCtx => ({ id: p.id, visibility: p.visibility });
export const itemCtx = (item: Row, p: Row): ItemCtx => ({
  project: projectCtx(p),
  confidential: !!item.confidential,
  assignee_id: item.assignee_id ?? null,
  reporter_id: item.reporter_id ?? null,
  created_by: item.created_by ?? null,
});

export function assertCan(actor: Actor, action: Action, resource?: Parameters<typeof permissions.assert>[2]) {
  permissions.assert(actor, action, resource);
}

/** Load the project and check `action` against the item (throws 403/404). */
export async function assertItem(ctx: MutationCtx, action: Action, item: Row): Promise<Row> {
  const project = await getProject(ctx.tx, item.project_id);
  assertCan(ctx.actor, action, { item: itemCtx(item, project), project: projectCtx(project) });
  return project;
}

/** Insert or revive a watcher row (no-op when it already exists, so no version churn). */
export async function ensureWatcher(ctx: MutationCtx, itemId: string, userId: string, reason: WatchReason) {
  await ctx.tx`
    insert into item_watchers (item_id, user_id, reason) values (${itemId}, ${userId}, ${reason})
    on conflict (item_id, user_id) do update set deleted_at = null, reason = excluded.reason
    where deleted_at is not null`;
}

export async function userName(q: Q, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [u] = await q`select name from users where id = ${userId}`;
  return u?.name ?? null;
}

export async function labelIdsOf(q: Q, itemId: string): Promise<string[]> {
  const rows = await q`select label_id from work_item_labels where item_id = ${itemId} and deleted_at is null order by created_at`;
  return rows.map((r) => r.label_id);
}

export async function labelNamesOf(q: Q, itemId: string): Promise<string[]> {
  const rows = await q`
    select l.name from work_item_labels wl join labels l on l.id = wl.label_id
    where wl.item_id = ${itemId} and wl.deleted_at is null and l.deleted_at is null order by l.name`;
  return rows.map((r) => r.name);
}

export async function parentIdOf(q: Q, itemId: string): Promise<string | null> {
  const [r] = await q`select from_item_id from relations where to_item_id = ${itemId} and type = 'parent_of' and deleted_at is null`;
  return r?.from_item_id ?? null;
}

/** Full item row plus the derived columns clients need (label_ids, parent_id, is_blocked). */
export async function itemSnapshot(q: Q, itemId: string): Promise<Row> {
  const [row] = await q`
    select w.*,
      ${labelIdsSelect(q)},
      (select r.from_item_id from relations r where r.to_item_id = w.id and r.type = 'parent_of' and r.deleted_at is null) as parent_id,
      exists (select 1 from open_blockers ob where ob.item_id = w.id) as is_blocked
    from work_items w where w.id = ${itemId}`;
  if (!row) throw notFound(`item ${itemId} not found`);
  return stripSearch(row);
}

/** work_items_v row (display columns) plus label_ids. */
export async function itemView(q: Q, itemId: string): Promise<Row | null> {
  const [row] = await q`select w.*, ${labelIdsSelect(q)} from work_items_v w where w.id = ${itemId}`;
  return row ? stripSearch(row) : null;
}

/** Bump a row's version (and updated_at) so sync clients re-pull derived columns (is_blocked, parent_id, label_ids). */
export async function touchItem(q: Q, itemId: string) {
  await q`update work_items set updated_at = ${nowIso()} where id = ${itemId}`;
}

/** Re-version child rows of an item so deletes/restores propagate to sync clients. */
export async function touchItemChildren(q: Q, itemId: string) {
  const now = nowIso();
  await q`update comments set updated_at = ${now} where item_id = ${itemId}`;
  await q`update relations set updated_at = ${now} where from_item_id = ${itemId} or to_item_id = ${itemId}`;
  await q`update work_item_labels set updated_at = ${now} where item_id = ${itemId}`;
  await q`update item_watchers set updated_at = ${now} where item_id = ${itemId}`;
}

export function requireUuid(v: unknown, what: string): string {
  if (!isUuid(v)) throw validation(`${what} must be a uuid`);
  return v;
}
