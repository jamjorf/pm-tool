import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { visibleItem } from '../mutations/helpers.js';
import { actorOf, projectIdQuery } from './util.js';

const COLUMNS = ['key', 'title', 'type_key', 'state_name', 'state_category', 'priority', 'assignee_name', 'reporter', 'start_date', 'due_date', 'estimate', 'labels', 'parent_key', 'is_blocked', 'confidential', 'created_at', 'updated_at', 'completed_at', 'fields', 'description'];

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  app.get('/export/items.csv', async (request, reply) => {
    const actor = actorOf(request);
    const projectId = await projectIdQuery(db, request);
    const rows = await db`
      select w.key, w.title, w.type_key, w.state_name, w.state_category, w.priority, w.assignee_name, r.name as reporter, w.start_date, w.due_date, w.estimate,
             w.label_names, p.key as parent_key, w.is_blocked, w.confidential, w.created_at, w.updated_at, w.completed_at, w.fields, w.description
      from work_items_v w left join users r on r.id = w.reporter_id left join work_items p on p.id = w.parent_id
      where w.deleted_at is null and ${visibleItem(db, actor.id, 'w.id')} and (${projectId} is null or w.project_id = ${projectId})
      order by w.project_key, w.number`;
    const lines = [COLUMNS.join(',')];
    for (const r of rows) {
      r.labels = (Array.isArray(r.label_names) ? r.label_names : []).join('|'); // array_to_string(label_names, '|')
      lines.push(COLUMNS.map((c) => cell(r[c])).join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="items${projectId ? '-' + projectId.slice(0, 8) : ''}.csv"`);
    return lines.join('\r\n') + '\r\n';
  });
}
