import type { MutationArgsOf } from '@pm/core';
import { nowIso, setOf, type Row } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { permissions } from '../core-compat.js';
import type { MutationCtx } from './context.js';
import { assertCan, getProject, projectCtx, reload } from './helpers.js';

export async function getView(ctx: MutationCtx, id: string): Promise<Row> {
  const [v] = await ctx.tx`select * from views where id = ${id} and deleted_at is null`;
  if (!v) throw notFound(`view ${id} not found`);
  return v;
}

export async function createView(ctx: MutationCtx, args: MutationArgsOf<'createView'>): Promise<Row> {
  const project = args.project_id ? await getProject(ctx.tx, args.project_id) : null;
  assertCan(ctx.actor, 'view.create', project ? { project: projectCtx(project) } : undefined);
  if (args.is_shared && project) assertCan(ctx.actor, 'view.edit_shared', { project: projectCtx(project) });
  await ctx.tx`
    insert into views (id, project_id, owner_id, name, kind, spec, is_shared, icon)
    values (${args.id}, ${args.project_id}, ${ctx.actor.id}, ${args.name}, ${args.kind}, ${ctx.tx.json(args.spec)}, ${args.is_shared ?? false}, ${args.icon ?? null})`;
  const v = await reload(ctx.tx, 'views', args.id);
  await ctx.emit([{ entity_type: 'view', entity_id: v.id, project_id: args.project_id, action: 'create', field: null, new_value: v }]);
  return v;
}

async function assertViewEditable(ctx: MutationCtx, view: Row) {
  const project = view.project_id ? await getProject(ctx.tx, view.project_id) : null;
  const resource = { ...(project ? { project: projectCtx(project) } : {}), ownerId: view.owner_id };
  if (view.owner_id === ctx.actor.id) return permissions.assert(ctx.actor, 'view.edit_own', resource);
  if (view.is_shared) return permissions.assert(ctx.actor, 'view.edit_shared', resource);
  if (ctx.actor.firmRole === 'owner' || ctx.actor.firmRole === 'admin') return;
  throw forbidden('cannot edit a private view you do not own');
}

export async function updateView(ctx: MutationCtx, args: MutationArgsOf<'updateView'>): Promise<Row> {
  const view = await getView(ctx, args.id);
  await assertViewEditable(ctx, view);
  const p = args.patch;
  const updates: Record<string, unknown> = {};
  if (p.name !== undefined) updates.name = p.name;
  if (p.kind !== undefined) updates.kind = p.kind;
  if (p.spec !== undefined) updates.spec = ctx.tx.json(p.spec);
  if (p.is_shared !== undefined) updates.is_shared = p.is_shared;
  if (p.is_default !== undefined) updates.is_default = p.is_default;
  if (p.icon !== undefined) updates.icon = p.icon;
  if (p.sort !== undefined) updates.sort = p.sort;
  if (!Object.keys(updates).length) return view;
  await ctx.tx`update views set ${setOf(ctx.tx, updates)} where id = ${view.id}`;
  const after = await reload(ctx.tx, 'views', view.id);
  const events = Object.keys(updates).map((k) => ({
    entity_type: 'view', entity_id: view.id, project_id: view.project_id, action: 'update', field: k, old_value: view[k] ?? null, new_value: after[k] ?? null,
  }));
  await ctx.emit(events);
  return after;
}

export async function deleteView(ctx: MutationCtx, args: MutationArgsOf<'deleteView'>): Promise<Row> {
  const view = await getView(ctx, args.id);
  await assertViewEditable(ctx, view);
  await ctx.tx`update views set deleted_at = ${nowIso()} where id = ${view.id}`;
  await ctx.emit([{ entity_type: 'view', entity_id: view.id, project_id: view.project_id, action: 'delete', field: null, old_value: view }]);
  return reload(ctx.tx, 'views', view.id);
}
