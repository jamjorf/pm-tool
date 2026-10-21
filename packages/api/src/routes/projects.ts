import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MutationArgs, ProjectRole } from '@pm/core';
import { requireAuth } from '../auth/plugin.js';
import { notFound } from '../errors.js';
import { permissions } from '../core-compat.js';
import { getProject, projectCtx } from '../mutations/helpers.js';
import { actorOf, flag, parse, paramsOf, projectIdParam, queryOf, zUuid } from './util.js';

export async function projectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  app.get('/projects', async (request) => {
    const actor = actorOf(request);
    const includeArchived = flag(queryOf(request).include_archived);
    const projects = await db`
      select p.*, u.name as lead_name,
        (select count(*)::int from work_items w join workflow_states s on s.id = w.state_id where w.project_id = p.id and w.deleted_at is null and s.category not in ('done','canceled')) as open_count
      from projects p left join users u on u.id = p.lead_id
      where p.deleted_at is null and p.id in (select visible_project_ids(${actor.id}))
        and (${includeArchived} or p.archived_at is null)
      order by p.key`;
    return { projects };
  });

  app.post('/projects', async (request, reply) => {
    const body = parse(MutationArgs.createProject.extend({ id: zUuid.optional() }), request.body);
    const project = await app.mutateFor(request, { name: 'createProject', args: { ...body, id: body.id ?? randomUUID() } });
    reply.code(201);
    return project;
  });

  async function visibleProject(request: Parameters<typeof actorOf>[0]) {
    const actor = actorOf(request);
    const id = await projectIdParam(db, request);
    const project = await getProject(db, id);
    if (!permissions.can(actor, 'project.view', { project: projectCtx(project) })) throw notFound('project not found');
    return { actor, project };
  }

  app.get('/projects/:key', async (request) => {
    const { actor, project } = await visibleProject(request);
    const members = await db`
      select m.user_id, m.role, u.name, u.email, u.avatar_url from project_members m join users u on u.id = m.user_id
      where m.project_id = ${project.id} and m.deleted_at is null and u.deleted_at is null order by u.name`;
    const counts = await db`
      select s.category, count(*)::int as count from work_items w join workflow_states s on s.id = w.state_id
      where w.project_id = ${project.id} and w.deleted_at is null and can_view_item(${actor.id}, w.id) group by s.category`;
    const views = await db`
      select * from views where project_id = ${project.id} and deleted_at is null and (owner_id = ${actor.id} or is_shared) order by sort, name`;
    const item_counts: Record<string, number> = {};
    for (const c of counts) item_counts[c.category] = c.count;
    return { ...project, members, item_counts, views, effective_role: permissions.effectiveRole(actor, projectCtx(project)) };
  });

  app.patch('/projects/:key', async (request) => {
    const { project } = await visibleProject(request);
    const patch = parse(MutationArgs.updateProject.shape.patch, request.body);
    return app.mutateFor(request, { name: 'updateProject', args: { id: project.id, patch } });
  });

  app.get('/projects/:key/members', async (request) => {
    const { project } = await visibleProject(request);
    const members = await db`
      select m.user_id, m.role, u.name, u.email from project_members m join users u on u.id = m.user_id
      where m.project_id = ${project.id} and m.deleted_at is null order by u.name`;
    return { members };
  });

  app.put('/projects/:key/members/:userId', async (request) => {
    const { project } = await visibleProject(request);
    const body = parse(z.object({ role: ProjectRole }), request.body);
    return app.mutateFor(request, { name: 'setProjectMember', args: { project_id: project.id, user_id: paramsOf(request).userId!, role: body.role } });
  });

  app.delete('/projects/:key/members/:userId', async (request) => {
    const { project } = await visibleProject(request);
    await app.mutateFor(request, { name: 'removeProjectMember', args: { project_id: project.id, user_id: paramsOf(request).userId! } });
    return { ok: true };
  });
}
