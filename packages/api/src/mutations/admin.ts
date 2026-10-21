import type { MutationArgsOf, WorkflowDefinition, WorkflowState, WorkflowTransition } from '@pm/core';
import type { Row } from '../db.js';
import { notFound, validation } from '../errors.js';
import { workflowEngine } from '../core-compat.js';
import type { MutationCtx } from './context.js';
import { assertCan, getWorkflowDef } from './helpers.js';

export async function upsertItemType(ctx: MutationCtx, args: MutationArgsOf<'upsertItemType'>): Promise<Row> {
  const { tx, actor, meta } = ctx;
  assertCan(actor, 'type.manage');
  const [wf] = await tx`select id from workflows where id = ${args.workflow_id} and deleted_at is null`;
  if (!wf) throw notFound(`workflow ${args.workflow_id} not found`);
  const [existing] = await tx`select * from item_types where key = ${args.key}`;

  if (existing) {
    const oldKeys = (existing.field_defs as { key: string }[]).map((d) => d.key);
    const newKeys = new Set(args.field_defs.map((d) => d.key));
    const removed = oldKeys.filter((k) => !newKeys.has(k));
    if (removed.length) {
      const n = (await tx`select count(*)::int as n from work_items where type_id = ${existing.id} and deleted_at is null and fields ?| ${removed}::text[]`)[0]!.n as number;
      if (n > 0 && !meta.force) {
        throw validation(`field keys still used by ${n} item(s): ${removed.join(', ')} (pass ?force=1 to drop them)`, { fields: removed, items: n });
      }
    }
    if (existing.workflow_id !== args.workflow_id) {
      const n = (await tx`select count(*)::int as n from work_items where type_id = ${existing.id} and deleted_at is null`)[0]!.n as number;
      if (n > 0 && !meta.force) throw validation(`cannot change the workflow of a type with ${n} item(s) (pass ?force=1 to remap states)`, { items: n });
    }
    const [after] = await tx`
      update item_types set name = ${args.name}, plural_name = ${args.plural_name ?? null}, icon = ${args.icon ?? null}, color = ${args.color ?? null},
        description = ${args.description ?? null}, workflow_id = ${args.workflow_id}, field_defs = ${tx.json(args.field_defs as any)},
        is_container = ${args.is_container ?? existing.is_container}, sort = ${args.sort ?? existing.sort}, is_active = ${args.is_active ?? existing.is_active}, deleted_at = null
      where id = ${existing.id} returning *`;
    if (existing.workflow_id !== args.workflow_id) await remapItemStates(ctx, existing.id, args.workflow_id);
    if (removed.length) await tx`update work_items set fields = fields - ${removed}::text[] where type_id = ${existing.id} and fields ?| ${removed}::text[]`;
    await ctx.emit([{ entity_type: 'item_type', entity_id: existing.id, action: 'update', field: null, old_value: existing, new_value: after }]);
    return after!;
  }
  const [created] = await tx`
    insert into item_types (id, key, name, plural_name, icon, color, description, workflow_id, field_defs, is_container, sort, is_active)
    values (${args.id}, ${args.key}, ${args.name}, ${args.plural_name ?? null}, ${args.icon ?? null}, ${args.color ?? null}, ${args.description ?? null},
            ${args.workflow_id}, ${tx.json(args.field_defs as any)}, ${args.is_container ?? false}, ${args.sort ?? 0}, ${args.is_active ?? true})
    returning *`;
  await ctx.emit([{ entity_type: 'item_type', entity_id: created!.id, action: 'create', field: null, new_value: created }]);
  return created!;
}

/** Move items of a type to the same-key state in the new workflow (or its initial state). */
async function remapItemStates(ctx: MutationCtx, typeId: string, workflowId: string) {
  const def = await getWorkflowDef(ctx.tx, workflowId);
  const initial = workflowEngine.initialState(def);
  const items = await ctx.tx`
    select w.id, s.key as state_key from work_items w join workflow_states s on s.id = w.state_id
    where w.type_id = ${typeId} and w.deleted_at is null and s.workflow_id <> ${workflowId}`;
  for (const it of items) {
    const target = def.states.find((s) => s.key === it.state_key) ?? initial;
    await ctx.tx`update work_items set state_id = ${target.id} where id = ${it.id}`;
  }
}

export async function upsertWorkflow(ctx: MutationCtx, args: MutationArgsOf<'upsertWorkflow'>): Promise<WorkflowDefinition> {
  const { tx, actor } = ctx;
  assertCan(actor, 'workflow.manage');
  const now = new Date().toISOString();
  const synced = { version: 0, created_at: now, updated_at: now, deleted_at: null };
  const def: WorkflowDefinition = {
    id: args.id, key: args.key,
    states: args.states.map((s) => ({ ...s, color: s.color ?? null, workflow_id: args.id, ...synced })) as WorkflowState[],
    transitions: args.transitions.map((t) => ({ ...t, workflow_id: args.id, ...synced })) as WorkflowTransition[],
  };
  const errors = workflowEngine.validateDefinition(def);
  if (errors.length) throw validation('invalid workflow definition', errors);

  const [existing] = await tx`select * from workflows where key = ${args.key}`;
  const wfId: string = existing?.id ?? args.id;
  if (existing) {
    await tx`update workflows set name = ${args.name}, description = ${args.description ?? null}, deleted_at = null where id = ${wfId}`;
  } else {
    await tx`insert into workflows (id, key, name, description) values (${wfId}, ${args.key}, ${args.name}, ${args.description ?? null})`;
  }

  // ---- states: match by id, then by key (unique(workflow_id,key) is not partial) ----
  const dbStates = await tx`select * from workflow_states where workflow_id = ${wfId}`;
  const stateId = new Map<string, string>(); // incoming id -> resolved id
  const kept = new Set<string>();
  for (const s of args.states) {
    const match = dbStates.find((d) => d.id === s.id) ?? dbStates.find((d) => d.key === s.key);
    stateId.set(s.id, match?.id ?? s.id);
    if (match) kept.add(match.id);
  }
  for (const d of dbStates) {
    if (kept.has(d.id) || d.deleted_at) continue;
    const n = (await tx`select count(*)::int as n from work_items where state_id = ${d.id} and deleted_at is null`)[0]!.n as number;
    if (n > 0) throw validation(`state "${d.key}" is still used by ${n} item(s) and cannot be removed`, { state: d.key, items: n });
  }
  const initialIncoming = args.states.find((s) => s.is_initial)!;
  await tx`update workflow_states set is_initial = false where workflow_id = ${wfId} and is_initial and id <> ${stateId.get(initialIncoming.id)!}`;
  for (const d of dbStates) {
    if (!kept.has(d.id) && !d.deleted_at) await tx`update workflow_states set deleted_at = now(), is_initial = false where id = ${d.id}`;
  }
  for (const s of args.states) {
    const rid = stateId.get(s.id)!;
    await tx`
      insert into workflow_states (id, workflow_id, key, name, category, color, sort, is_initial)
      values (${rid}, ${wfId}, ${s.key}, ${s.name}, ${s.category}, ${s.color ?? null}, ${s.sort}, ${s.is_initial})
      on conflict (id) do update set key = excluded.key, name = excluded.name, category = excluded.category, color = excluded.color,
        sort = excluded.sort, is_initial = excluded.is_initial, deleted_at = null`;
  }

  // ---- transitions ----
  const dbTransitions = await tx`select * from workflow_transitions where workflow_id = ${wfId}`;
  const keptT = new Set<string>();
  const resolvedT: { incoming: (typeof args.transitions)[number]; id: string }[] = [];
  for (const t of args.transitions) {
    const match = dbTransitions.find((d) => d.id === t.id) ?? dbTransitions.find((d) => d.key === t.key);
    const id = match?.id ?? t.id;
    if (match) keptT.add(match.id);
    resolvedT.push({ incoming: t, id });
  }
  for (const d of dbTransitions) {
    if (!keptT.has(d.id) && !d.deleted_at) await tx`update workflow_transitions set deleted_at = now() where id = ${d.id}`;
  }
  for (const { incoming: t, id } of resolvedT) {
    await tx`
      insert into workflow_transitions (id, workflow_id, key, name, from_state_id, to_state_id, guards, effects, sort)
      values (${id}, ${wfId}, ${t.key}, ${t.name}, ${t.from_state_id ? stateId.get(t.from_state_id) ?? t.from_state_id : null}, ${stateId.get(t.to_state_id) ?? t.to_state_id},
              ${tx.json(t.guards as any)}, ${tx.json(t.effects as any)}, ${t.sort})
      on conflict (id) do update set key = excluded.key, name = excluded.name, from_state_id = excluded.from_state_id, to_state_id = excluded.to_state_id,
        guards = excluded.guards, effects = excluded.effects, sort = excluded.sort, deleted_at = null`;
  }
  await ctx.emit([{ entity_type: 'workflow', entity_id: wfId, action: existing ? 'update' : 'create', field: null, new_value: { key: args.key, states: args.states.length, transitions: args.transitions.length } }]);
  return getWorkflowDef(tx, wfId);
}
