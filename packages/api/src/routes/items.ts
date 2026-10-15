import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ItemPatch, QuerySpec, type Actor } from '@pm/core';
import { requireAuth } from '../auth/plugin.js';
import { isUuid, type Q, type Row } from '../db.js';
import { notFound, validation } from '../errors.js';
import { workflowEngine } from '../core-compat.js';
import { canViewItem, getItem, getProject, getType, getWorkflowDef, itemView, resolveItemId, resolveProjectId, stripSearch } from '../mutations/helpers.js';
import { loadGuardContext } from '../mutations/items.js';
import { queryItems } from '../query.js';
import { actorOf, csv, flag, intQuery, itemIdParam, parse, paramsOf, queryOf, resolveIds, zKeys, zUuid } from './util.js';

const ItemCreateBody = z.object({
  id: zUuid.optional(),
  project_id: zUuid.optional(), project_key: z.string().optional(), project: z.string().optional(),
  type_id: zUuid.optional(), type_key: z.string().optional(), type: z.string().optional(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  state_id: zUuid.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignee_id: zUuid.nullable().optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  estimate: z.number().nullable().optional(),
  fields: z.record(z.unknown()).optional(),
  label_ids: z.array(zUuid).optional(),
  labels: z.array(z.string()).optional(),
  parent_id: zUuid.nullable().optional(),
  parent: z.string().nullable().optional(),
  confidential: z.boolean().optional(),
});

async function resolveTypeId(q: Q, ref: string): Promise<string> {
  const rows = isUuid(ref) ? await q`select id from item_types where id = ${ref} and deleted_at is null` : await q`select id from item_types where key = ${ref} and deleted_at is null`;
  if (!rows[0]) throw notFound(`item type ${ref} not found`);
  return rows[0].id;
}

async function resolveLabelId(q: Q, projectId: string, ref: string): Promise<string> {
  const rows = isUuid(ref)
    ? await q`select id from labels where id = ${ref} and deleted_at is null and (project_id is null or project_id = ${projectId})`
    : await q`select id from labels where lower(name) = lower(${ref}) and deleted_at is null and (project_id is null or project_id = ${projectId}) order by project_id nulls last limit 1`;
  if (!rows[0]) throw notFound(`label ${ref} not found`);
  return rows[0].id;
}

async function visibleItemId(app: FastifyInstance, request: FastifyRequest, opts: { includeDeleted?: boolean } = {}): Promise<string> {
  const id = await itemIdParam(app.db, request, 'key', opts);
  const actor = actorOf(request);
  const [row] = await app.db`
    select can_view_item(${actor.id}, ${id}) as ok,
           (select effective_project_role(${actor.id}, w.project_id) is not null and not w.confidential from work_items w where w.id = ${id}) as deleted_ok`;
  if (!row?.ok && !(opts.includeDeleted && row?.deleted_ok)) throw notFound('item not found');
  return id;
}

export async function availableTransitions(q: Q, actor: Actor, item: Row) {
  const project = await getProject(q, item.project_id);
  const type = await getType(q, item.type_id);
  const def = await getWorkflowDef(q, type.workflow_id);
  const gctx = await loadGuardContext({ tx: q as any, actor }, item, project);
  return workflowEngine.availableTransitions(def, item).map((t) => {
    const r = workflowEngine.evaluate(def, item as any, t.key, gctx);
    const to = def.states.find((s) => s.id === t.to_state_id)!;
    return { key: t.key, name: t.name, to_state: { id: to.id, key: to.key, name: to.name, category: to.category }, allowed: r.ok, failures: r.failures };
  });
}

export async function itemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  // ---- list -----------------------------------------------------------------
  app.get('/items', async (request) => {
    const actor = actorOf(request);
    const qs = queryOf(request);
    const limit = intQuery(qs.limit, 50, 500);
    const projectId = qs.project ? await resolveProjectId(db, qs.project) : null;
    const typeRef = qs.type ?? null;
    const categories = csv(qs.state_category) ?? null;
    const assignee = qs.assignee === 'me' ? actor.id : qs.assignee && isUuid(qs.assignee) ? qs.assignee : null;
    const label = qs.label ?? null;
    const text = qs.q?.trim() || null;
    const since = qs.updated_since || null;
    const includeArchived = flag(qs.include_archived);
    let cursorAt: string | null = null, cursorId: string | null = null;
    if (qs.cursor) {
      try {
        const c = JSON.parse(Buffer.from(qs.cursor, 'base64url').toString('utf8'));
        cursorAt = c.u; cursorId = c.i;
      } catch { throw validation('invalid cursor'); }
    }
    const rows: Row[] = await db`
      select w.*, coalesce((select array_agg(wl.label_id order by wl.created_at) from work_item_labels wl where wl.item_id = w.id and wl.deleted_at is null), '{}'::uuid[]) as label_ids
      from work_items_v w
      where w.deleted_at is null and can_view_item(${actor.id}, w.id)
        and (${projectId}::uuid is null or w.project_id = ${projectId}::uuid)
        and (${typeRef}::text is null or w.type_key = ${typeRef}::text or w.type_id::text = ${typeRef}::text)
        and (${categories}::text[] is null or w.state_category::text = any(${categories}::text[]))
        and (${assignee}::uuid is null or w.assignee_id = ${assignee}::uuid)
        and (${label}::text is null or exists (select 1 from work_item_labels wl join labels l on l.id = wl.label_id where wl.item_id = w.id and wl.deleted_at is null and (lower(l.name) = lower(${label}::text) or l.id::text = ${label}::text)))
        and (${text}::text is null or w.search @@ websearch_to_tsquery('english', ${text}::text) or w.title ilike ${'%' + (text ?? '') + '%'} or w.key ilike ${'%' + (text ?? '') + '%'})
        and (${since}::timestamptz is null or w.updated_at > ${since}::timestamptz)
        and (${includeArchived} or w.archived_at is null)
        and (${cursorAt}::timestamptz is null or (w.updated_at, w.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
      order by w.updated_at desc, w.id desc
      limit ${limit + 1}`;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => stripSearch(r));
    const last = items.at(-1);
    const next_cursor = more && last ? Buffer.from(JSON.stringify({ u: last.updated_at, i: last.id })).toString('base64url') : null;
    return { items, next_cursor };
  });

  app.post('/items/query', async (request) => {
    const body = parse(z.object({ spec: QuerySpec }), request.body);
    return queryItems(db, actorOf(request), body.spec);
  });

  // ---- create ---------------------------------------------------------------
  app.post('/items', async (request, reply) => {
    const body = parse(ItemCreateBody, request.body);
    const projectRef = body.project_id ?? body.project_key ?? body.project;
    if (!projectRef) throw validation('project_id (or project_key) is required');
    const project_id = await resolveProjectId(db, projectRef);
    const project = await getProject(db, project_id);
    const typeRef = body.type_id ?? body.type_key ?? body.type ?? project.default_type_id ?? 'task';
    const type_id = await resolveTypeId(db, typeRef);
    const label_ids = [...(body.label_ids ?? [])];
    for (const l of body.labels ?? []) label_ids.push(await resolveLabelId(db, project_id, l));
    const parent_id = body.parent_id ?? (body.parent ? await resolveItemId(db, body.parent) : body.parent === null ? null : undefined);
    const args = {
      id: body.id ?? randomUUID(), project_id, type_id, title: body.title, description: body.description, state_id: body.state_id, priority: body.priority,
      assignee_id: body.assignee_id, start_date: body.start_date, due_date: body.due_date, estimate: body.estimate, fields: body.fields,
      label_ids: label_ids.length ? label_ids : undefined, parent_id, confidential: body.confidential,
    };
    const item = await app.mutateFor(request, { name: 'createItem', args: args as any });
    reply.code(201);
    return item;
  });

  // ---- bulk -----------------------------------------------------------------
  app.post('/items/bulk', async (request) => {
    const body = parse(zKeys.extend({ patch: ItemPatch }), request.body);
    const ids = await resolveIds(db, body);
    const items = await app.mutateFor(request, { name: 'bulkUpdateItems', args: { ids, patch: body.patch } });
    return { items };
  });

  app.post('/items/bulk-transition', async (request) => {
    const body = parse(zKeys.extend({ transition_key: z.string().min(1) }), request.body);
    const ids = await resolveIds(db, body);
    return app.mutateFor(request, { name: 'bulkTransitionItems', args: { ids, transition_key: body.transition_key } });
  });

  // ---- detail ---------------------------------------------------------------
  app.get('/items/:key', async (request) => {
    const actor = actorOf(request);
    const id = await visibleItemId(app, request);
    const item = (await itemView(db, id))!;
    const labels = await db`select l.* from labels l join work_item_labels wl on wl.label_id = l.id where wl.item_id = ${id} and wl.deleted_at is null and l.deleted_at is null order by l.name`;
    const rels = await db`
      select r.*, rt.name as type_name, rt.inverse_name as type_inverse_name,
        o.id as o_id, o.key as o_key, o.title as o_title, o.state_name as o_state, o.state_category as o_state_category, o.assignee_id as o_assignee_id,
        (o.id is null or can_view_item(${actor.id}, o.id)) as o_visible
      from relations r join relation_types rt on rt.key = r.type
      left join work_items_v o on o.id = case when r.from_item_id = ${id} then r.to_item_id else r.from_item_id end
      where (r.from_item_id = ${id} or r.to_item_id = ${id}) and r.deleted_at is null
      order by r.created_at`;
    const relations = rels.filter((r) => r.o_visible).map((r) => {
      const direction = r.from_item_id === id ? 'out' : 'in';
      const { o_id, o_key, o_title, o_state, o_state_category, o_assignee_id, o_visible, type_name, type_inverse_name, ...rel } = r;
      void o_visible;
      return {
        ...rel, direction, label: direction === 'out' ? type_name : type_inverse_name,
        other_item: o_id ? { id: o_id, key: o_key, title: o_title, state: o_state, state_category: o_state_category, assignee_id: o_assignee_id } : null,
      };
    });
    const [parent] = await db`
      select w.id, w.key, w.title, w.state_name as state, w.state_category from relations r join work_items_v w on w.id = r.from_item_id
      where r.to_item_id = ${id} and r.type = 'parent_of' and r.deleted_at is null and w.deleted_at is null and can_view_item(${actor.id}, w.id)`;
    const children = await db`
      select w.id, w.key, w.title, w.state_name as state, w.state_category, w.assignee_id, w.priority, w.type_key from relations r join work_items_v w on w.id = r.to_item_id
      where r.from_item_id = ${id} and r.type = 'parent_of' and r.deleted_at is null and w.deleted_at is null and can_view_item(${actor.id}, w.id)
      order by w.sort_order, w.number`;
    const [rollup] = await db`select * from item_rollup(${id})`;
    const watchers = await db`select w.user_id, u.name, w.reason, w.muted from item_watchers w join users u on u.id = w.user_id where w.item_id = ${id} and w.deleted_at is null`;
    const available_transitions = await availableTransitions(db, actor, item);
    return { item, labels, relations, parent: parent ?? null, children, rollup: rollup ?? null, available_transitions, watchers };
  });

  app.patch('/items/:key', async (request) => {
    const id = await visibleItemId(app, request);
    const patch = parse(ItemPatch, request.body);
    return app.mutateFor(request, { name: 'updateItem', args: { id, patch } });
  });

  app.delete('/items/:key', async (request) => {
    const id = await visibleItemId(app, request);
    const row = await app.mutateFor(request, { name: 'deleteItem', args: { id } });
    return { ok: true, item: row };
  });

  app.post('/items/:key/restore', async (request) => {
    const id = await visibleItemId(app, request, { includeDeleted: true });
    return app.mutateFor(request, { name: 'restoreItem', args: { id } });
  });

  // ---- transitions ----------------------------------------------------------
  app.get('/items/:key/transitions', async (request) => {
    const id = await visibleItemId(app, request);
    const item = await getItem(db, id);
    return { transitions: await availableTransitions(db, actorOf(request), item) };
  });

  app.post('/items/:key/transitions/:transitionKey', async (request) => {
    const id = await visibleItemId(app, request);
    const body = parse(z.object({ comment: z.string().optional() }), request.body);
    return app.mutateFor(request, { name: 'transitionItem', args: { id, transition_key: paramsOf(request).transitionKey!, comment: body.comment } });
  });

  // ---- activity / comments --------------------------------------------------
  app.get('/items/:key/activity', async (request) => {
    const id = await visibleItemId(app, request, { includeDeleted: true });
    const qs = queryOf(request);
    const limit = intQuery(qs.limit, 100, 500);
    const before = qs.before ? Number(qs.before) : null;
    const events = await db`
      select e.*, u.name as actor_name from activity_events e left join users u on u.id = e.actor_id
      where (e.item_id = ${id} or (e.entity_type = 'relation' and e.entity_id in (select id from relations where to_item_id = ${id})))
        and (${before}::bigint is null or e.id < ${before}::bigint)
      order by e.id desc limit ${limit}`;
    return { events, next_before: events.length === limit ? events.at(-1)!.id : null };
  });

  app.get('/items/:key/comments', async (request) => {
    const id = await visibleItemId(app, request);
    const comments = await db`
      select c.*, u.name as author_name from comments c left join users u on u.id = c.author_id
      where c.item_id = ${id} and c.deleted_at is null order by c.created_at`;
    return { comments };
  });

  app.post('/items/:key/comments', async (request, reply) => {
    const id = await visibleItemId(app, request);
    const body = parse(z.object({ id: zUuid.optional(), body: z.string().min(1), parent_id: zUuid.nullable().optional() }), request.body);
    const comment = await app.mutateFor(request, { name: 'addComment', args: { id: body.id ?? randomUUID(), item_id: id, body: body.body, parent_id: body.parent_id ?? null } });
    reply.code(201);
    return comment;
  });

  // ---- relations / parent ---------------------------------------------------
  app.get('/items/:key/relations', async (request) => {
    const actor = actorOf(request);
    const id = await visibleItemId(app, request);
    const relations = await db`
      select r.*, o.key as other_key, o.title as other_title, o.state_name as other_state
      from relations r left join work_items_v o on o.id = case when r.from_item_id = ${id} then r.to_item_id else r.from_item_id end
      where (r.from_item_id = ${id} or r.to_item_id = ${id}) and r.deleted_at is null and (o.id is null or can_view_item(${actor.id}, o.id))
      order by r.created_at`;
    return { relations };
  });

  app.post('/items/:key/relations', async (request, reply) => {
    const id = await visibleItemId(app, request);
    const body = parse(z.object({
      id: zUuid.optional(), type: z.string().min(1), to_item: z.string().optional(), to_item_id: zUuid.optional(),
      external_kind: z.string().optional(), external_ref: z.record(z.unknown()).optional(),
    }), request.body);
    const to_item_id = body.to_item_id ?? (body.to_item ? await resolveItemId(db, body.to_item) : null);
    const rel = await app.mutateFor(request, { name: 'addRelation', args: { id: body.id ?? randomUUID(), type: body.type, from_item_id: id, to_item_id, external_kind: body.external_kind ?? null, external_ref: body.external_ref ?? null } });
    reply.code(201);
    return rel;
  });

  app.put('/items/:key/parent', async (request) => {
    const id = await visibleItemId(app, request);
    const body = parse(z.object({ parent: z.string().nullable() }), request.body);
    const parent_id = body.parent ? await resolveItemId(db, body.parent) : null;
    return app.mutateFor(request, { name: 'setParent', args: { id, parent_id } });
  });

  // ---- labels / watch -------------------------------------------------------
  app.post('/items/:key/labels', async (request) => {
    const id = await visibleItemId(app, request);
    const body = parse(z.object({ label: z.string().min(1) }), request.body);
    const item = await getItem(db, id);
    let labelId: string;
    try {
      labelId = await resolveLabelId(db, item.project_id, body.label);
    } catch (e) {
      if (isUuid(body.label)) throw e;
      const created = (await app.mutateFor(request, { name: 'createLabel', args: { id: randomUUID(), project_id: item.project_id, name: body.label } })) as Row;
      labelId = created.id;
    }
    return app.mutateFor(request, { name: 'addLabel', args: { item_id: id, label_id: labelId } });
  });

  app.delete('/items/:key/labels/:labelId', async (request) => {
    const id = await visibleItemId(app, request);
    const item = await getItem(db, id);
    const labelId = await resolveLabelId(db, item.project_id, paramsOf(request).labelId!);
    return app.mutateFor(request, { name: 'removeLabel', args: { item_id: id, label_id: labelId } });
  });

  app.post('/items/:key/watch', async (request) => {
    const id = await visibleItemId(app, request);
    return app.mutateFor(request, { name: 'watchItem', args: { item_id: id } });
  });

  app.delete('/items/:key/watch', async (request) => {
    const id = await visibleItemId(app, request);
    return app.mutateFor(request, { name: 'unwatchItem', args: { item_id: id } });
  });

  void canViewItem;
}
