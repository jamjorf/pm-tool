import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { dateIn } from '../db.js';
import { stripSearch, visibleItem } from '../mutations/helpers.js';
import { searchItems } from '../search.js';
import { actorOf, intQuery, projectIdQuery, queryOf } from './util.js';

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  app.get('/search', async (request) => {
    const actor = actorOf(request);
    const qs = queryOf(request);
    const projectId = await projectIdQuery(db, request);
    const items = await searchItems(db, actor.id, qs.q ?? '', { projectId, limit: intQuery(qs.limit, 20, 200) });
    return { items, q: qs.q ?? '' };
  });

  app.get('/my-work', async (request) => {
    const u = actorOf(request).id;
    // `is not` is SQLite's null-safe inequality (Postgres: is distinct from)
    const open = db`w.deleted_at is null and w.state_category not in ('done','canceled') and ${visibleItem(db, u, 'w.id')}`;
    const order = db`order by case when w.priority = 0 then 9 else w.priority end, w.due_date nulls last, w.updated_at desc limit 100`;
    const assigned = await db`select w.* from work_items_v w where ${open} and w.assignee_id = ${u} ${order}`;
    const created = await db`select w.* from work_items_v w where ${open} and (w.reporter_id = ${u} or w.created_by = ${u}) and w.assignee_id is not ${u} ${order}`;
    const watching = await db`
      select w.* from work_items_v w join item_watchers iw on iw.item_id = w.id and iw.user_id = ${u} and iw.deleted_at is null and iw.muted = 0
      where ${open} and w.assignee_id is not ${u} and w.reporter_id is not ${u} ${order}`;
    const due_soon = await db`
      select w.* from work_items_v w where ${open} and w.due_date is not null and w.due_date <= ${dateIn(7)}
        and (w.assignee_id = ${u} or w.reporter_id = ${u} or exists (select 1 from item_watchers iw where iw.item_id = w.id and iw.user_id = ${u} and iw.deleted_at is null and iw.muted = 0))
      order by w.due_date, case when w.priority = 0 then 9 else w.priority end limit 100`;
    const mentions = await db`
      select n.*, w.key as item_key, w.title as item_title, a.name as actor_name from notifications n
      left join work_items w on w.id = n.item_id left join users a on a.id = n.actor_id
      where n.user_id = ${u} and n.kind = 'mention' and n.read_at is null and n.deleted_at is null order by n.created_at desc limit 100`;
    const clean = (rows: any[]) => rows.map((r) => stripSearch(r));
    return { assigned: clean(assigned), created: clean(created), watching: clean(watching), due_soon: clean(due_soon), mentions };
  });
}
