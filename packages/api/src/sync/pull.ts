import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rowKey, type PatchOp, type PullRequest, type PullResponse, type SyncedTable } from '@pm/core';
import { sqliteErrorKind, type Row, type Tx } from '../db.js';
import { labelIdsSelect, visibleItem, visibleProjects } from '../mutations/helpers.js';
import { ensureClientGroup } from './push.js';

function parseCookie(c: PullRequest['cookie']): number {
  if (c === null || c === undefined) return 0;
  if (typeof c === 'number') return Number.isFinite(c) ? c : 0;
  if (typeof c === 'string') return Number(c) || 0;
  if (typeof c === 'object' && typeof c.version === 'number') return c.version;
  return 0;
}

type Loader = (tx: Tx, userId: string, minVersion: number) => Promise<Row[]>;

/** Per-table loaders: every row with version > minVersion plus a `_visible` flag (0/1) for this user. */
const LOADERS: Record<SyncedTable, Loader> = {
  users: (tx, _u, v) => tx`select t.*, 1 as _visible from users t where t.version > ${v}`,
  teams: (tx, _u, v) => tx`select t.*, 1 as _visible from teams t where t.version > ${v}`,
  workflows: (tx, _u, v) => tx`select t.*, 1 as _visible from workflows t where t.version > ${v}`,
  workflow_states: (tx, _u, v) => tx`select t.*, 1 as _visible from workflow_states t where t.version > ${v}`,
  workflow_transitions: (tx, _u, v) => tx`select t.*, 1 as _visible from workflow_transitions t where t.version > ${v}`,
  item_types: (tx, _u, v) => tx`select t.*, 1 as _visible from item_types t where t.version > ${v}`,
  labels: (tx, u, v) => tx`
    select t.*, (t.project_id is null or t.project_id in ${visibleProjects(tx, u)}) as _visible from labels t where t.version > ${v}`,
  projects: (tx, u, v) => tx`
    select t.*, (t.id in ${visibleProjects(tx, u)}) as _visible from projects t where t.version > ${v}`,
  project_members: (tx, u, v) => tx`
    select t.*, (t.project_id in ${visibleProjects(tx, u)}) as _visible from project_members t where t.version > ${v}`,
  work_items: (tx, u, v) => tx`
    select w.*,
      ${labelIdsSelect(tx)},
      (select r.from_item_id from relations r where r.to_item_id = w.id and r.type = 'parent_of' and r.deleted_at is null) as parent_id,
      exists (select 1 from open_blockers ob where ob.item_id = w.id) as is_blocked,
      ${visibleItem(tx, u, 'w.id')} as _visible
    from work_items w where w.version > ${v}`,
  comments: (tx, u, v) => tx`select t.*, ${visibleItem(tx, u, 't.item_id')} as _visible from comments t where t.version > ${v}`,
  relations: (tx, u, v) => tx`
    select t.*, (${visibleItem(tx, u, 't.from_item_id')} or (t.to_item_id is not null and ${visibleItem(tx, u, 't.to_item_id')})) as _visible
    from relations t where t.version > ${v}`,
  work_item_labels: (tx, u, v) => tx`select t.*, ${visibleItem(tx, u, 't.item_id')} as _visible from work_item_labels t where t.version > ${v}`,
  item_watchers: (tx, u, v) => tx`select t.*, ${visibleItem(tx, u, 't.item_id')} as _visible from item_watchers t where t.version > ${v}`,
  views: (tx, u, v) => tx`
    select t.*, (t.owner_id = ${u} or (t.is_shared = 1 and (t.project_id is null or t.project_id in ${visibleProjects(tx, u)}))) as _visible
    from views t where t.version > ${v}`,
  notifications: (tx, u, v) => tx`select t.*, 1 as _visible from notifications t where t.user_id = ${u} and t.version > ${v}`,
  notification_preferences: (tx, u, v) => tx`select t.*, 1 as _visible from notification_preferences t where t.user_id = ${u} and t.version > ${v}`,
};

const TABLE_ORDER = Object.keys(LOADERS) as SyncedTable[];

/**
 * POST /sync/pull — see ARCHITECTURE "Sync protocol".
 *
 * Runs in a read snapshot (deferred transaction under WAL). The cookie is `sync_state.version`
 * read inside that snapshot: writers are serialised (BEGIN IMMEDIATE) and stamp every row with
 * the counter inside their own transaction, so every row with version <= cookie is visible here
 * and nothing can be skipped. The resync flag is cleared inside the same transaction.
 */
export async function handlePull(app: FastifyInstance, request: FastifyRequest, body: PullRequest): Promise<PullResponse> {
  const userId = request.actor!.id;
  const sql = app.db;
  await ensureClientGroup(sql, body.clientGroupID, userId);
  const cookie = parseCookie(body.cookie);

  const run = () =>
    sql.snapshot(async (tx) => {
      const [g] = await tx`select resync_required from sync_client_groups where id = ${body.clientGroupID}`;
      const full = cookie <= 0 || !!g?.resync_required;
      const version = tx.currentVersion();
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
      for (const c of clients) lastMutationIDChanges[c.id] = Number(c.last_mutation_id);
      if (full && g?.resync_required) await tx`update sync_client_groups set resync_required = 0 where id = ${body.clientGroupID}`;
      return { cookie: version, lastMutationIDChanges, patch } satisfies PullResponse;
    });

  try {
    return await run();
  } catch (e) {
    // A writer in another process committed between our snapshot and the flag update (SQLITE_BUSY_SNAPSHOT): retry once.
    if (sqliteErrorKind(e) === 'busy') return run();
    throw e;
  }
}
