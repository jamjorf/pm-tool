import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MutationArgs, QuerySpec, ViewSpec, type Widget } from '@pm/core';
import { requireAuth } from '../auth/plugin.js';
import { notFound } from '../errors.js';
import { resolveProjectId, visibleProjects } from '../mutations/helpers.js';
import { queryItems, runWidget } from '../query.js';
import { actorOf, parse, paramsOf, projectIdQuery, zUuid } from './util.js';

export async function viewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  app.get('/views', async (request) => {
    const actor = actorOf(request);
    const projectId = await projectIdQuery(db, request);
    const views = await db`
      select v.* from views v
      where v.deleted_at is null
        and (${projectId} is null or v.project_id = ${projectId})
        and (v.owner_id = ${actor.id} or (v.is_shared = 1 and (v.project_id is null or v.project_id in ${visibleProjects(db, actor.id)})))
      order by v.project_id nulls first, v.sort, v.name`;
    return { views };
  });

  app.post('/views', async (request, reply) => {
    const body = parse(MutationArgs.createView.extend({ id: zUuid.optional(), project_id: zUuid.nullable().optional(), project: z.string().nullable().optional() }), request.body);
    const project_id = body.project_id ?? (body.project ? await resolveProjectId(db, body.project) : null);
    const { project, ...rest } = body;
    void project;
    const view = await app.mutateFor(request, { name: 'createView', args: { ...rest, id: body.id ?? randomUUID(), project_id } });
    reply.code(201);
    return view;
  });

  app.patch('/views/:id', async (request) => {
    const patch = parse(MutationArgs.updateView.shape.patch, request.body);
    return app.mutateFor(request, { name: 'updateView', args: { id: paramsOf(request).id!, patch } });
  });

  app.delete('/views/:id', async (request) => {
    await app.mutateFor(request, { name: 'deleteView', args: { id: paramsOf(request).id! } });
    return { ok: true };
  });

  app.post('/views/:id/run', async (request) => {
    const actor = actorOf(request);
    const [view] = await db`
      select * from views where id = ${paramsOf(request).id!} and deleted_at is null
        and (owner_id = ${actor.id} or (is_shared = 1 and (project_id is null or project_id in ${visibleProjects(db, actor.id)})))`;
    if (!view) throw notFound('view not found');
    const body = parse(z.object({ spec: QuerySpec.partial().optional(), tz: z.string().optional() }), request.body);
    const spec = ViewSpec.parse(view.spec ?? {});
    if (view.kind === 'dashboard') {
      const widgets = (spec.dashboard?.widgets ?? []) as Widget[];
      const out = [];
      for (const w of widgets) out.push({ id: w.id, title: w.title, viz: w.viz, rows: await runWidget(db, actor, w, { tz: body.tz }) });
      return { widgets: out };
    }
    const merged: QuerySpec = {
      filter: body.spec?.filter ?? spec.filter, sort: body.spec?.sort ?? spec.sort, group_by: body.spec?.group_by !== undefined ? body.spec.group_by : (spec.group_by ?? (view.kind === 'board' ? spec.board?.column_field ?? 'state_id' : null)),
      limit: body.spec?.limit ?? spec.limit, offset: body.spec?.offset ?? spec.offset, include_archived: body.spec?.include_archived ?? spec.include_archived,
    };
    return queryItems(db, actor, merged, { tz: body.tz });
  });
}
