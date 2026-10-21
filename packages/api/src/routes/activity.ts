import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { isUuid } from '../db.js';
import { validation } from '../errors.js';
import { hasProjectRole, resolveItemId, visibleItem, visibleProjects } from '../mutations/helpers.js';
import { actorOf, intQuery, projectIdQuery, queryOf } from './util.js';

export async function activityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  /** Firm/project feed. Visible = project visible (or firm-level event) and item visible (or deleted, non-confidential). */
  app.get('/activity', async (request) => {
    const actor = actorOf(request);
    const qs = queryOf(request);
    const projectId = await projectIdQuery(db, request);
    const itemId = qs.item ? await resolveItemId(db, qs.item, { includeDeleted: true }) : null;
    const actorId = qs.actor ? (isUuid(qs.actor) ? qs.actor : null) : null;
    if (qs.actor && !actorId) throw validation('actor must be a uuid');
    const since = qs.since ? Number(qs.since) : null;
    const before = qs.before ? Number(qs.before) : null;
    const limit = intQuery(qs.limit, 50, 500);
    const u = actor.id;
    const events = await db`
      select e.*, a.name as actor_name, w.key as item_key, w.title as item_title, p.key as project_key
      from activity_events e
      left join users a on a.id = e.actor_id
      left join work_items w on w.id = e.item_id
      left join projects p on p.id = e.project_id
      where (e.project_id is null or e.project_id in ${visibleProjects(db, u)})
        and (e.item_id is null or ${visibleItem(db, u, 'e.item_id')}
             or exists (select 1 from work_items d where d.id = e.item_id and d.deleted_at is not null and d.confidential = 0 and ${hasProjectRole(db, u, 'd.project_id')}))
        and (${projectId} is null or e.project_id = ${projectId})
        and (${itemId} is null or e.item_id = ${itemId})
        and (${actorId} is null or e.actor_id = ${actorId})
        and (${since} is null or e.id > ${since})
        and (${before} is null or e.id < ${before})
      order by e.id ${since !== null ? db.raw('asc') : db.raw('desc')}
      limit ${limit}`;
    return { events, cursor: events.length ? (since !== null ? events.at(-1)!.id : events[0]!.id) : (since ?? null) };
  });
}
