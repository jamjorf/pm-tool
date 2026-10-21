import type { MutationArgsOf } from '@pm/core';
import type { Row } from '../db.js';
import { conflict, notFound, validation } from '../errors.js';
import type { MutationCtx } from './context.js';
import { assertCan, getProject, projectCtx } from './helpers.js';

const PROJECT_FIELDS = ['name', 'description', 'status', 'visibility', 'lead_id', 'team_id', 'default_type_id', 'allowed_type_ids', 'start_date', 'target_date', 'settings'] as const;

export async function createProject(ctx: MutationCtx, args: MutationArgsOf<'createProject'>): Promise<Row> {
  assertCan(ctx.actor, 'project.create');
  const [dup] = await ctx.tx`select id from projects where upper(key) = upper(${args.key}) and deleted_at is null`;
  if (dup) throw conflict(`project key ${args.key} already exists`);
  const [p] = await ctx.tx`
    insert into projects (id, key, name, description, visibility, lead_id, team_id)
    values (${args.id}, ${args.key}, ${args.name}, ${args.description ?? null}, ${args.visibility ?? 'firm'}, ${args.lead_id ?? null}, ${args.team_id ?? null})
    returning *`;
  await ctx.tx`insert into project_members (project_id, user_id, role) values (${p!.id}, ${ctx.actor.id}, 'admin') on conflict do nothing`;
  await ctx.emit([{ entity_type: 'project', entity_id: p!.id, project_id: p!.id, action: 'create', field: null, new_value: p }]);
  ctx.requireResyncForUser(ctx.actor.id);
  return p!;
}

export async function updateProject(ctx: MutationCtx, args: MutationArgsOf<'updateProject'>): Promise<Row> {
  const project = await getProject(ctx.tx, args.id);
  assertCan(ctx.actor, 'project.edit', { project: projectCtx(project) });
  const updates: Record<string, unknown> = {};
  for (const k of PROJECT_FIELDS) {
    const v = (args.patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    updates[k] = k === 'settings' ? ctx.tx.json(v as any) : v;
  }
  if (args.patch.status === 'archived' && !project.archived_at) updates.archived_at = new Date().toISOString();
  if (args.patch.status && args.patch.status !== 'archived' && project.archived_at) updates.archived_at = null;
  if (args.patch.allowed_type_ids) {
    const n = await ctx.tx`select count(*)::int as n from item_types where id = any(${args.patch.allowed_type_ids}::uuid[]) and deleted_at is null`;
    if (n[0]!.n !== args.patch.allowed_type_ids.length) throw validation('allowed_type_ids contains unknown types');
  }
  if (!Object.keys(updates).length) return project;
  const [after] = await ctx.tx`update projects set ${ctx.tx(updates as any)} where id = ${project.id} returning *`;
  const changed = Object.keys(updates).filter((k) => JSON.stringify(project[k] ?? null) !== JSON.stringify(after![k] ?? null));
  await ctx.emit(changed.map((k) => ({ entity_type: 'project', entity_id: project.id, project_id: project.id, action: 'update', field: k, old_value: project[k] ?? null, new_value: after![k] ?? null })));
  if (changed.includes('visibility')) ctx.requireResyncForAll();
  return after!;
}

export async function setProjectMember(ctx: MutationCtx, args: MutationArgsOf<'setProjectMember'>): Promise<Row> {
  const project = await getProject(ctx.tx, args.project_id);
  assertCan(ctx.actor, 'project.admin', { project: projectCtx(project) });
  const [u] = await ctx.tx`select id from users where id = ${args.user_id} and deleted_at is null`;
  if (!u) throw notFound(`user ${args.user_id} not found`);
  const [before] = await ctx.tx`select * from project_members where project_id = ${project.id} and user_id = ${args.user_id}`;
  const [after] = await ctx.tx`
    insert into project_members (project_id, user_id, role) values (${project.id}, ${args.user_id}, ${args.role})
    on conflict (project_id, user_id) do update set role = excluded.role, deleted_at = null
    returning *`;
  await ctx.emit([{
    entity_type: 'project', entity_id: project.id, project_id: project.id, action: 'member_set', field: 'members',
    old_value: before && !before.deleted_at ? { user_id: args.user_id, role: before.role } : null, new_value: { user_id: args.user_id, role: args.role },
  }]);
  ctx.requireResyncForUser(args.user_id);
  return after!;
}

export async function removeProjectMember(ctx: MutationCtx, args: MutationArgsOf<'removeProjectMember'>): Promise<Row | null> {
  const project = await getProject(ctx.tx, args.project_id);
  assertCan(ctx.actor, 'project.admin', { project: projectCtx(project) });
  const [after] = await ctx.tx`
    update project_members set deleted_at = now() where project_id = ${project.id} and user_id = ${args.user_id} and deleted_at is null returning *`;
  if (!after) return null;
  await ctx.emit([{ entity_type: 'project', entity_id: project.id, project_id: project.id, action: 'member_remove', field: 'members', old_value: { user_id: args.user_id, role: after.role }, new_value: null }]);
  ctx.requireResyncForUser(args.user_id);
  return after;
}
