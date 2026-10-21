import { randomUUID } from 'node:crypto';
import type { Effect, GuardContext, ItemPatch, MutationArgsOf, TransitionResult, WorkItem, WorkflowDefinition } from '@pm/core';
import type { Row } from '../db.js';
import { ApiError, guardFailed, notFound, validation } from '../errors.js';
import { diffItem, extractMentions, permissions, validateFields, workflowEngine } from '../core-compat.js';
import type { MutationCtx } from './context.js';
import {
  ITEM_COLUMNS, assertCan, assertItem, canViewItem, ensureWatcher, getItem, getProject, getType, getWorkflowDef, itemSnapshot,
  labelIdsOf, labelNamesOf, parentIdOf, projectCtx, stripSearch, touchItem, touchItemChildren, type ItemRow,
} from './helpers.js';
import { addCommentInternal } from './comments.js';
import { setParentInternal } from './relations.js';
import { actorName, snippet, watcherIds } from './notify-helpers.js';

const PATCH_COLUMNS = ['title', 'description', 'priority', 'assignee_id', 'reporter_id', 'start_date', 'due_date', 'estimate', 'confidential', 'sort_order', 'archived_at'] as const;


// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
export async function createItem(ctx: MutationCtx, args: MutationArgsOf<'createItem'>): Promise<Row> {
  const { tx, actor } = ctx;
  const project = await getProject(tx, args.project_id);
  assertCan(actor, 'item.create', { project: projectCtx(project) });
  const type = await getType(tx, args.type_id);
  if (!type.is_active) throw validation(`item type ${type.key} is inactive`);
  if (project.allowed_type_ids && !project.allowed_type_ids.includes(type.id)) {
    throw validation(`type ${type.key} is not allowed in project ${project.key}`, { allowed_type_ids: project.allowed_type_ids });
  }
  const def = await getWorkflowDef(tx, type.workflow_id);
  let stateId = args.state_id ?? null;
  if (stateId) {
    if (!def.states.some((s) => s.id === stateId)) throw validation('state_id does not belong to the workflow of this type');
  } else {
    stateId = workflowEngine.initialState(def).id;
  }
  const fv = validateFields(type.field_defs, args.fields ?? {});
  if (!fv.ok) throw validation('invalid fields', fv.errors);

  const [row] = await tx`
    insert into work_items (id, project_id, type_id, title, description, state_id, priority, assignee_id, reporter_id, start_date, due_date, estimate, fields, confidential, created_by)
    values (${args.id}, ${project.id}, ${type.id}, ${args.title}, ${args.description ?? ''}, ${stateId}, ${args.priority ?? 0}, ${args.assignee_id ?? null},
            ${actor.id}, ${args.start_date ?? null}, ${args.due_date ?? null}, ${args.estimate ?? null}, ${tx.json(fv.value as any)}, ${args.confidential ?? false}, ${actor.id})
    returning *`;
  const item = stripSearch(row!) as ItemRow;

  for (const labelId of args.label_ids ?? []) await attachLabel(ctx, item, labelId);
  if (args.parent_id) await setParentInternal(ctx, item, args.parent_id, { silent: true });

  await ensureWatcher(ctx, item.id, actor.id, 'reporter');
  if (item.assignee_id) {
    await ensureWatcher(ctx, item.id, item.assignee_id, 'assignee');
    ctx.notify({ user_id: item.assignee_id, item_id: item.id, kind: 'assigned', title: `${await actorName(ctx)} assigned you ${item.key}: ${item.title}`, body: snippet(item.description) });
  }
  await notifyMentions(ctx, item, item.description, []);

  const snap = await itemSnapshot(tx, item.id);
  await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: item.project_id, action: 'create', field: null, old_value: null, new_value: snap }]);
  return snap;
}

async function notifyMentions(ctx: MutationCtx, item: Row, text: string | null | undefined, previouslyMentioned: string[]) {
  if (!text) return;
  const prev = new Set(previouslyMentioned);
  for (const userId of extractMentions(text)) {
    if (prev.has(userId) || userId === ctx.actor.id) continue;
    const [u] = await ctx.tx`select id from users where id = ${userId} and deleted_at is null and is_active`;
    if (!u) continue;
    await ensureWatcher(ctx, item.id, userId, 'mention');
    ctx.notify({ user_id: userId, item_id: item.id, kind: 'mention', title: `${await actorName(ctx)} mentioned you in ${item.key}: ${item.title}`, body: snippet(text) });
  }
}

// ---------------------------------------------------------------------------
// update / bulk
// ---------------------------------------------------------------------------
export async function updateItem(ctx: MutationCtx, args: MutationArgsOf<'updateItem'>): Promise<Row> {
  const before = await getItem(ctx.tx, args.id);
  return patchItem(ctx, before, args.patch);
}

export async function bulkUpdateItems(ctx: MutationCtx, args: MutationArgsOf<'bulkUpdateItems'>): Promise<Row[]> {
  const out: Row[] = [];
  for (const id of args.ids) out.push(await patchItem(ctx, await getItem(ctx.tx, id), args.patch));
  return out;
}

export async function patchItem(ctx: MutationCtx, before: ItemRow, patch: ItemPatch): Promise<Row> {
  const { tx, actor } = ctx;
  const project = await assertItem(ctx, 'item.edit', before);
  const updates: Record<string, unknown> = {};
  let type = await getType(tx, before.type_id);

  if (patch.type_id && patch.type_id !== before.type_id) {
    type = await getType(tx, patch.type_id);
    if (!type.is_active) throw validation(`item type ${type.key} is inactive`);
    if (project.allowed_type_ids && !project.allowed_type_ids.includes(type.id)) throw validation(`type ${type.key} is not allowed in project ${project.key}`);
    updates.type_id = type.id;
    const def = await getWorkflowDef(tx, type.workflow_id);
    if (!def.states.some((s) => s.id === before.state_id)) {
      // Keep a same-key state when the new workflow has one, else start at its initial state.
      const [old] = await tx`select key from workflow_states where id = ${before.state_id}`;
      const match = def.states.find((s) => s.key === old?.key);
      updates.state_id = (match ?? workflowEngine.initialState(def)).id;
    }
  }

  if (patch.fields !== undefined || updates.type_id) {
    const merged: Record<string, unknown> = { ...(before.fields ?? {}), ...(patch.fields ?? {}) };
    const allowed = new Set((type.field_defs as { key: string }[]).map((d) => d.key));
    const cleaned = updates.type_id ? Object.fromEntries(Object.entries(merged).filter(([k]) => allowed.has(k))) : merged;
    for (const k of Object.keys(cleaned)) if (cleaned[k] === null || cleaned[k] === undefined) delete cleaned[k];
    const fv = validateFields(type.field_defs, cleaned);
    if (!fv.ok) throw validation('invalid fields', fv.errors);
    updates.fields = tx.json(fv.value as any);
  }
  for (const k of PATCH_COLUMNS) if (patch[k] !== undefined) updates[k] = patch[k];
  if (updates.assignee_id) {
    const [u] = await tx`select id from users where id = ${updates.assignee_id as string} and deleted_at is null`;
    if (!u) throw validation('assignee not found');
  }

  if (!Object.keys(updates).length) return itemSnapshot(tx, before.id);
  const [afterRow] = await tx`update work_items set ${tx(updates as any)} where id = ${before.id} returning *`;
  const after = stripSearch(afterRow!) as ItemRow;
  await recordItemDiff(ctx, before, after, 'update');
  await afterItemChange(ctx, before, after);
  return itemSnapshot(tx, before.id);
}

/** One activity row per changed field (fields.<key> for JSONB), all sharing the mutation txn_id. */
async function recordItemDiff(ctx: MutationCtx, before: Row, after: Row, action: 'update' | 'transition') {
  const changes = diffItem(before as Partial<WorkItem>, after as Partial<WorkItem>);
  return ctx.emit(
    changes.map((c) => ({
      entity_type: 'work_item', entity_id: after.id, item_id: after.id, project_id: after.project_id,
      action: c.field === 'state_id' && action === 'transition' ? 'transition' : 'update',
      field: c.field, old_value: c.old ?? null, new_value: c.new ?? null,
    })),
  );
}

async function afterItemChange(ctx: MutationCtx, before: Row, after: Row) {
  if (after.assignee_id && after.assignee_id !== before.assignee_id) {
    await ensureWatcher(ctx, after.id, after.assignee_id, 'assignee');
    ctx.notify({ user_id: after.assignee_id, item_id: after.id, kind: 'assigned', title: `${await actorName(ctx)} assigned you ${after.key}: ${after.title}`, body: snippet(after.description) });
  }
  if (after.description !== before.description) await notifyMentions(ctx, after, after.description, extractMentions(before.description ?? ''));
  if (after.state_id !== before.state_id) {
    const [s] = await ctx.tx`select name from workflow_states where id = ${after.state_id}`;
    await notifyStateChange(ctx, after, s?.name ?? 'a new state');
  }
  if (!!after.confidential !== !!before.confidential) {
    ctx.requireResyncForProject(after.project_id);
    await touchItemChildren(ctx.tx, after.id);
  }
}

async function notifyStateChange(ctx: MutationCtx, item: Row, stateName: string) {
  const who = await actorName(ctx);
  const title = `${who} moved ${item.key} to ${stateName}: ${item.title}`;
  if (item.assignee_id) ctx.notify({ user_id: item.assignee_id, item_id: item.id, kind: 'state_change', title, isAssignee: true });
  for (const w of await watcherIds(ctx, item.id)) {
    if (w !== item.assignee_id) ctx.notify({ user_id: w, item_id: item.id, kind: 'state_change', title, isAssignee: false });
  }
}


// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------
export async function loadGuardContext(ctx: { tx: MutationCtx['tx']; actor: MutationCtx['actor'] }, item: Row, project: Row): Promise<GuardContext> {
  const n = (await ctx.tx`select count(*)::int as n from item_open_blockers(${item.id})`)[0]!.n as number;
  const cats = await ctx.tx`
    select s.category from relations r
    join work_items c on c.id = r.to_item_id and c.deleted_at is null
    join workflow_states s on s.id = c.state_id
    where r.from_item_id = ${item.id} and r.type = 'parent_of' and r.deleted_at is null`;
  return {
    actorId: ctx.actor.id,
    actorRole: permissions.effectiveRole(ctx.actor, projectCtx(project)),
    now: new Date(),
    openBlockerCount: n,
    childrenCategories: cats.map((c) => c.category),
    labelNames: await labelNamesOf(ctx.tx, item.id),
  };
}

export async function transitionItem(ctx: MutationCtx, args: MutationArgsOf<'transitionItem'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.id);
  return transition(ctx, item, args.transition_key, args.comment);
}

export async function bulkTransitionItems(ctx: MutationCtx, args: MutationArgsOf<'bulkTransitionItems'>) {
  const ok: string[] = [];
  const failed: { id: string; failures: unknown }[] = [];
  for (const id of args.ids) {
    try {
      await transition(ctx, await getItem(ctx.tx, id), args.transition_key);
      ok.push(id);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'guard_failed' || e.code === 'forbidden' || e.code === 'validation' || e.code === 'not_found')) {
        failed.push({ id, failures: (e.details as any)?.failures ?? [{ reason: e.message }] });
      } else throw e;
    }
  }
  return { ok, failed };
}

function resolveMacro(v: unknown, ctx: MutationCtx): unknown {
  if (v === '$now') return new Date().toISOString();
  if (v === '$today') return new Date().toISOString().slice(0, 10);
  if (v === '$actor') return ctx.actor.id;
  return v;
}

export async function transition(ctx: MutationCtx, item: ItemRow, transitionKey: string, comment?: string): Promise<Row> {
  const { tx } = ctx;
  const project = await assertItem(ctx, 'item.transition', item);
  const type = await getType(tx, item.type_id);
  const def = await getWorkflowDef(tx, type.workflow_id);
  if (!def.transitions.some((t) => t.key === transitionKey)) throw notFound(`transition "${transitionKey}" not found in workflow ${def.key}`);
  const gctx = await loadGuardContext(ctx, item, project);
  let result: TransitionResult;
  try {
    result = workflowEngine.evaluate(def, item as WorkItem, transitionKey, gctx);
  } catch (e) {
    throw validation((e as Error).message);
  }
  if (!result.ok) throw guardFailed(result.failures);

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result.patch)) {
    if (k === 'fields') updates.fields = tx.json({ ...(item.fields ?? {}), ...((v as Record<string, unknown>) ?? {}) } as any);
    else if (ITEM_COLUMNS.has(k)) updates[k] = resolveMacro(v, ctx);
  }
  updates.state_id = result.toState.id;
  const [afterRow] = await tx`update work_items set ${tx(updates as any)} where id = ${item.id} returning *`;
  const after = stripSearch(afterRow!) as ItemRow;

  await recordItemDiff(ctx, item, after, 'transition');
  await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: item.project_id, action: 'transition', field: 'transition_key', old_value: null, new_value: transitionKey }]);

  if (comment && comment.trim()) await addCommentInternal(ctx, after, { id: randomUUID(), item_id: after.id, body: comment });
  if (after.assignee_id && after.assignee_id !== item.assignee_id) await ensureWatcher(ctx, after.id, after.assignee_id, 'assignee');
  await notifyStateChange(ctx, after, result.toState.name);
  await runDeferredEffects(ctx, after, project, result);
  return itemSnapshot(tx, item.id);
}

async function runDeferredEffects(ctx: MutationCtx, item: ItemRow, project: Row, result: TransitionResult) {
  for (const e of result.deferredEffects as Effect[]) {
    switch (e.type) {
      case 'notify': {
        const recipients = new Set<string>();
        for (const a of e.audience) {
          if (a === 'watchers') for (const w of await watcherIds(ctx, item.id)) recipients.add(w);
          if (a === 'assignee' && item.assignee_id) recipients.add(item.assignee_id);
          if (a === 'reporter' && item.reporter_id) recipients.add(item.reporter_id);
          if (a === 'project_admins') {
            const admins = await ctx.tx`select user_id from project_members where project_id = ${project.id} and role = 'admin' and deleted_at is null`;
            for (const r of admins) recipients.add(r.user_id);
          }
        }
        const who = await actorName(ctx);
        for (const u of recipients) {
          ctx.notify({ user_id: u, item_id: item.id, kind: 'state_change', explicit: true, title: `${who} moved ${item.key} to ${result.toState.name}: ${item.title}`, body: e.template });
        }
        break;
      }
      case 'webhook':
        ctx.forceWebhook(item.id, e.event);
        break;
      case 'add_label': {
        const label = await findOrCreateLabel(ctx, project, e.label);
        await attachLabel(ctx, item, label.id, { record: true });
        break;
      }
      case 'remove_label': {
        const label = await findLabel(ctx, project.id, e.label);
        if (label) await detachLabel(ctx, item, label.id);
        break;
      }
      case 'transition_parent_if': {
        const parentId = await parentIdOf(ctx.tx, item.id);
        if (!parentId) break;
        const cats = await ctx.tx`
          select s.category from relations r join work_items c on c.id = r.to_item_id and c.deleted_at is null
          join workflow_states s on s.id = c.state_id where r.from_item_id = ${parentId} and r.type = 'parent_of' and r.deleted_at is null`;
        if (cats.length && cats.every((c) => e.all_children_category.includes(c.category))) {
          await transitionToStateKey(ctx, parentId, e.to);
        }
        break;
      }
      case 'transition_children': {
        const kids = await ctx.tx`select to_item_id from relations where from_item_id = ${item.id} and type = 'parent_of' and deleted_at is null`;
        for (const k of kids) await transitionToStateKey(ctx, k.to_item_id, e.to);
        break;
      }
    }
  }
}

/** Find a transition into the state with `stateKey` that is allowed from the item's current state and passes its guards. */
async function transitionToStateKey(ctx: MutationCtx, itemId: string, stateKey: string) {
  if (ctx.depth >= 5) return;
  const [row] = await ctx.tx`select * from work_items where id = ${itemId} and deleted_at is null`;
  if (!row) return;
  const item = stripSearch(row) as ItemRow;
  const type = await getType(ctx.tx, item.type_id);
  const def = await getWorkflowDef(ctx.tx, type.workflow_id);
  const target = def.states.find((s) => s.key === stateKey);
  if (!target || target.id === item.state_id) return;
  const candidates = def.transitions.filter((t) => t.to_state_id === target.id && (t.from_state_id === null || t.from_state_id === item.state_id));
  for (const t of candidates) {
    ctx.depth++;
    try {
      await transition(ctx, item, t.key);
      return;
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'guard_failed' || e.code === 'forbidden')) continue;
      throw e;
    } finally {
      ctx.depth--;
    }
  }
}

// ---------------------------------------------------------------------------
// delete / restore / move / reorder
// ---------------------------------------------------------------------------
export async function deleteItem(ctx: MutationCtx, args: MutationArgsOf<'deleteItem'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.id);
  await assertItem(ctx, 'item.delete', item);
  const [after] = await ctx.tx`update work_items set deleted_at = now() where id = ${item.id} returning *`;
  await touchItemChildren(ctx.tx, item.id);
  await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: item.project_id, action: 'delete', field: null, old_value: item, new_value: null }]);
  return stripSearch(after!);
}

export async function restoreItem(ctx: MutationCtx, args: MutationArgsOf<'restoreItem'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.id, { includeDeleted: true });
  if (!item.deleted_at) return itemSnapshot(ctx.tx, item.id);
  await assertItem(ctx, 'item.delete', item);
  await ctx.tx`update work_items set deleted_at = null where id = ${item.id}`;
  await touchItemChildren(ctx.tx, item.id);
  const snap = await itemSnapshot(ctx.tx, item.id);
  await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: item.project_id, action: 'restore', field: null, old_value: null, new_value: snap }]);
  return snap;
}

export async function moveItem(ctx: MutationCtx, args: MutationArgsOf<'moveItem'>): Promise<Row> {
  const { tx, actor } = ctx;
  const item = await getItem(tx, args.id);
  await assertItem(ctx, 'item.edit', item);
  const target = await getProject(tx, args.project_id);
  assertCan(actor, 'item.create', { project: projectCtx(target) });
  if (target.id === item.project_id) return itemSnapshot(tx, item.id);
  if (target.allowed_type_ids && !target.allowed_type_ids.includes(item.type_id)) throw validation(`item type is not allowed in project ${target.key}`);
  const item_seq = (await tx`update projects set item_seq = item_seq + 1 where id = ${target.id} returning item_seq`)[0]!.item_seq as number;
  const newKey = `${target.key}-${item_seq}`;
  const [afterRow] = await tx`update work_items set project_id = ${target.id}, number = ${item_seq}, key = ${newKey} where id = ${item.id} returning *`;
  const after = stripSearch(afterRow!) as ItemRow;
  // project-scoped labels of the old project no longer apply
  await tx`update work_item_labels wl set deleted_at = now() from labels l
           where l.id = wl.label_id and wl.item_id = ${item.id} and wl.deleted_at is null and l.project_id = ${item.project_id}`;
  await touchItemChildren(tx, item.id);
  await recordItemDiff(ctx, item, after, 'update');
  await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: after.project_id, action: 'update', field: 'key', old_value: item.key, new_value: newKey }]);
  return itemSnapshot(tx, item.id);
}

export async function reorderItem(ctx: MutationCtx, args: MutationArgsOf<'reorderItem'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.id);
  return patchItem(ctx, item, { sort_order: args.sort_order });
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------
export async function findLabel(ctx: MutationCtx, projectId: string, name: string): Promise<Row | null> {
  const [l] = await ctx.tx`
    select * from labels where lower(name) = lower(${name}) and (project_id = ${projectId} or project_id is null) and deleted_at is null
    order by project_id nulls last limit 1`;
  return l ?? null;
}

export async function findOrCreateLabel(ctx: MutationCtx, project: Row, name: string): Promise<Row> {
  const existing = await findLabel(ctx, project.id, name);
  if (existing) return existing;
  const [l] = await ctx.tx`insert into labels (project_id, name) values (${project.id}, ${name}) returning *`;
  await ctx.emit([{ entity_type: 'label', entity_id: l!.id, project_id: project.id, action: 'create', field: null, new_value: l }]);
  return l!;
}

async function attachLabel(ctx: MutationCtx, item: Row, labelId: string, opts: { record?: boolean } = {}) {
  const [label] = await ctx.tx`select * from labels where id = ${labelId} and deleted_at is null`;
  if (!label) throw notFound(`label ${labelId} not found`);
  if (label.project_id && label.project_id !== item.project_id) throw validation(`label ${label.name} belongs to another project`);
  const beforeIds = opts.record ? await labelIdsOf(ctx.tx, item.id) : [];
  const res = await ctx.tx`
    insert into work_item_labels (item_id, label_id) values (${item.id}, ${labelId})
    on conflict (item_id, label_id) do update set deleted_at = null where work_item_labels.deleted_at is not null
    returning item_id`;
  if (res.length && opts.record) {
    await touchItem(ctx.tx, item.id);
    await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: item.project_id, action: 'update', field: 'labels', old_value: beforeIds, new_value: [...beforeIds, labelId] }]);
  }
}

async function detachLabel(ctx: MutationCtx, item: Row, labelId: string) {
  const beforeIds = await labelIdsOf(ctx.tx, item.id);
  const res = await ctx.tx`update work_item_labels set deleted_at = now() where item_id = ${item.id} and label_id = ${labelId} and deleted_at is null returning item_id`;
  if (res.length) {
    await touchItem(ctx.tx, item.id);
    await ctx.emit([{ entity_type: 'work_item', entity_id: item.id, item_id: item.id, project_id: item.project_id, action: 'update', field: 'labels', old_value: beforeIds, new_value: beforeIds.filter((x) => x !== labelId) }]);
  }
}

export async function addLabel(ctx: MutationCtx, args: MutationArgsOf<'addLabel'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.item_id);
  await assertItem(ctx, 'item.edit', item);
  await attachLabel(ctx, item, args.label_id, { record: true });
  return itemSnapshot(ctx.tx, item.id);
}

export async function removeLabel(ctx: MutationCtx, args: MutationArgsOf<'removeLabel'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.item_id);
  await assertItem(ctx, 'item.edit', item);
  await detachLabel(ctx, item, args.label_id);
  return itemSnapshot(ctx.tx, item.id);
}

export async function createLabel(ctx: MutationCtx, args: MutationArgsOf<'createLabel'>): Promise<Row> {
  if (args.project_id) {
    const project = await getProject(ctx.tx, args.project_id);
    assertCan(ctx.actor, 'label.manage', { project: projectCtx(project) });
  } else if (ctx.actor.firmRole === 'guest') {
    throw new ApiError(403, 'forbidden', 'guests cannot create firm-wide labels');
  }
  const [existing] = await ctx.tx`
    select * from labels where lower(name) = lower(${args.name}) and project_id is not distinct from ${args.project_id} and deleted_at is null`;
  if (existing) return existing;
  const [l] = await ctx.tx`insert into labels (id, project_id, name, color) values (${args.id}, ${args.project_id}, ${args.name}, ${args.color ?? null}) returning *`;
  await ctx.emit([{ entity_type: 'label', entity_id: l!.id, project_id: args.project_id, action: 'create', field: null, new_value: l }]);
  return l!;
}

/** Can the actor see the item at all (used by routes before 404-ing). */
export async function assertVisible(ctx: { tx: MutationCtx['tx']; actor: MutationCtx['actor'] }, itemId: string) {
  if (!(await canViewItem(ctx.tx, ctx.actor.id, itemId))) throw notFound(`item ${itemId} not found`);
}

export type { WorkflowDefinition };
