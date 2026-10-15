import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rowKey, type PatchOp, type PullRequest, type PullResponse, type SyncedTable } from '@pm/core';
import type { Row, Tx } from '../db.js';
import { ensureClientGroup } from './push.js';

function parseCookie(c: PullRequest['cookie']): number {
  if (c === null || c === undefined) return 0;
  if (typeof c === 'number') return Number.isFinite(c) ? c : 0;
  if (typeof c === 'string') return Number(c) || 0;
  if (typeof c === 'object' && typeof c.version === 'number') return c.version;
  return 0;
}

/**
 * Highest `version` visible in THIS snapshot across every synced table (+ sync_clients).
 * We deliberately do not use `sync_version_seq.last_value`: nextval() is non-transactional, so a
 * writer that holds the advisory lock may already have drawn a higher version it has not committed
 * yet; handing that out as the cookie would make the client skip those rows forever. max(version)
 * inside the snapshot is safe because writers serialize on pg_advisory_xact_lock(42): any row with
 * a version <= the max we can see was committed before the row carrying that max.
 */
async function snapshotVersion(tx: Tx): Promise<number> {
  const [r] = await tx`
    select greatest(
      (select coalesce(max(version),0) from users), (select coalesce(max(version),0) from teams),
      (select coalesce(max(version),0) from workflows), (select coalesce(max(version),0) from workflow_states),
      (select coalesce(max(version),0) from workflow_transitions), (select coalesce(max(version),0) from item_types),
      (select coalesce(max(version),0) from projects), (select coalesce(max(version),0) from project_members),
      (select coalesce(max(version),0) from work_items), (select coalesce(max(version),0) from labels),
      (select coalesce(max(version),0) from work_item_labels), (select coalesce(max(version),0) from comments),
      (select coalesce(max(version),0) from relations), (select coalesce(max(version),0) from views),
      (select coalesce(max(version),0) from item_watchers), (select coalesce(max(version),0) from notifications),
      (select coalesce(max(version),0) from notification_preferences), (select coalesce(max(version),0) from sync_clients)
    )::bigint as v`;
  return Number(r?.v ?? 0);
}

type Loader = (tx: Tx, userId: string, minVersion: number) => Promise<Row[]>;

/** Per-table loaders: every row with version > minVersion plus a `_visible` flag for this user. */
const LOADERS: Record<SyncedTable, Loader> = {
  users: (tx, _u, v) => tx`select t.*, true as _visible from users t where t.version > ${v}`,
  teams: (tx, _u, v) => tx`select t.*, true as _visible from teams t where t.version > ${v}`,
  workflows: (tx, _u, v) => tx`select t.*, true as _visible from workflows t where t.version > ${v}`,
  workflow_states: (tx, _u, v) => tx`select t.*, true as _visible from workflow_states t where t.version > ${v}`,
  workflow_transitions: (tx, _u, v) => tx`select t.*, true as _visible from workflow_transitions t where t.version > ${v}`,
  item_types: (tx, _u, v) => tx`select t.*, true as _visible from item_types t where t.version > ${v}`,
  labels: (tx, u, v) => tx`
    with vp as (select visible_project_ids(${u}) as id)
    select t.*, (t.project_id is null or t.project_id in (select id from vp)) as _visible from labels t where t.version > ${v}`,
  projects: (tx, u, v) => tx`
    with vp as (select visible_project_ids(${u}) as id)
    select t.*, (t.id in (select id from vp)) as _visible from projects t where t.version > ${v}`,
  project_members: (tx, u, v) => tx`
    with vp as (select visible_project_ids(${u}) as id)
    select t.*, (t.project_id in (select id from vp)) as _visible from project_members t where t.version > ${v}`,
  work_items: (tx, u, v) => tx`
    select w.*,
      coalesce((select array_agg(wl.label_id order by wl.created_at) from work_item_labels wl where wl.item_id = w.id and wl.deleted_at is null), '{}'::uuid[]) as label_ids,
      (select r.from_item_id from relations r where r.to_item_id = w.id and r.type = 'parent_of' and r.deleted_at is null) as parent_id,
      exists(select 1 from item_open_blockers(w.id)) as is_blocked,
      can_view_item(${u}, w.id) as _visible
    from work_items w where w.version > ${v}`,
  comments: (tx, u, v) => tx`select t.*, can_view_item(${u}, t.item_id) as _visible from comments t where t.version > ${v}`,
  relations: (tx, u, v) => tx`
    select t.*, (can_view_item(${u}, t.from_item_id) or (t.to_item_id is not null and can_view_item(${u}, t.to_item_id))) as _visible
    from relations t where t.version > ${v}`,
  work_item_labels: (tx, u, v) => tx`select t.*, can_view_item(${u}, t.item_id) as _visible from work_item_labels t where t.version > ${v}`,
  item_watchers: (tx, u, v) => tx`select t.*, can_view_item(${u}, t.item_id) as _visible from item_watchers t where t.version > ${v}`,
  views: (tx, u, v) => tx`
    with vp as (select visible_project_ids(${u}) as id)
    select t.*, (t.owner_id = ${u} or (t.is_shared and (t.project_id is null or t.project_id in (select id from vp)))) as _visible
    from views t where t.version > ${v}`,
  notifications: (tx, u, v) => tx`select t.*, true as _visible from notifications t where t.user_id = ${u} and t.version > ${v}`,
  notification_preferences: (tx, u, v) => tx`select t.*, true as _visible from notification_preferences t where t.user_id = ${u} and t.version > ${v}`,
};

const TABLE_ORDER = Object.keys(LOADERS) as SyncedTable[];

/** POST /sync/pull — see ARCHITECTURE "Sync protocol". */
export async function handlePull(app: FastifyInstance, request: FastifyRequest, body: PullRequest): Promise<PullResponse> {
  const userId = request.actor!.id;
  const sql = app.db;
  await ensureClientGroup(sql, body.clientGroupID, userId);
  const cookie = parseCookie(body.cookie);

  const run = () =>
    sql.begin('isolation level repeatable read', async (tx) => {
      const [g] = await tx`select resync_required from sync_client_groups where id = ${body.clientGroupID}`;
      const full = cookie <= 0 || !!g?.resync_required;
      const version = await snapshotVersion(tx);
      const minVersion = full ? -1 : cookie;
      const patch: PatchOp[] = [];
      if (full) patch.push({ op: 'clear' });
      for (const table of TABLE_ORDER) {
        const rows = await LOADERS[table](tx, userId, minVersion);
        for (const row of rows) {
          const visible = !!row._visible && row.deleted_at == null;
          delete row._visible;
          delete row.search;
          const key = rowKey(table, row);
          if (visible) patch.push({ op: 'put', key, value: row });
          else if (!full) patch.push({ op: 'del', key });
        }
      }
      const clients = await tx`
        select id, last_mutation_id from sync_clients where client_group_id = ${body.clientGroupID} and version > ${minVersion}`;
      const lastMutationIDChanges: Record<string, number> = {};
      for (const c of clients) lastMutationIDChanges[c.id] = c.last_mutation_id;
      if (full && g?.resync_required) await tx`update sync_client_groups set resync_required = false where id = ${body.clientGroupID}`;
      return { cookie: version, lastMutationIDChanges, patch } satisfies PullResponse;
    });

  try {
    return (await run()) as PullResponse;
  } catch (e) {
    if ((e as { code?: string }).code === '40001') return (await run()) as PullResponse; // serialization retry
    throw e;
  }
}
