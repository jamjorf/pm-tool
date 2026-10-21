import { randomUUID } from 'node:crypto';
import type { MutationArgsOf } from '@pm/core';
import { nowIso, type Row } from '../db.js';
import { notFound, validation } from '../errors.js';
import type { MutationCtx } from './context.js';
import { assertItem, canViewItem, getItem, itemSnapshot, reload, touchItem } from './helpers.js';

export async function getRelation(ctx: MutationCtx, id: string): Promise<Row> {
  const [r] = await ctx.tx`select * from relations where id = ${id} and deleted_at is null`;
  if (!r) throw notFound(`relation ${id} not found`);
  return r;
}

async function relationType(ctx: MutationCtx, key: string): Promise<Row> {
  const [rt] = await ctx.tx`select * from relation_types where key = ${key}`;
  if (!rt) throw validation(`unknown relation type "${key}"`);
  return rt;
}

/** The identity of an external reference: its `id`, else its `url` (mirrors relations.external_key). */
const externalRefKey = (ref: unknown): string => {
  const r = (ref ?? {}) as Record<string, unknown>;
  return String(r.id ?? r.url ?? '');
};

export async function addRelation(ctx: MutationCtx, args: MutationArgsOf<'addRelation'>): Promise<Row> {
  const { tx, actor } = ctx;
  const from = await getItem(tx, args.from_item_id);
  await assertItem(ctx, 'relation.edit', from);
  const rt = await relationType(ctx, args.type);

  if (args.to_item_id) {
    if (args.to_item_id === from.id) throw validation('an item cannot relate to itself');
    const to = await getItem(tx, args.to_item_id);
    if (!(await canViewItem(tx, actor.id, to.id))) throw notFound(`item ${args.to_item_id} not found`);
    if (rt.is_hierarchy) {
      // parent_of from -> to: `from` becomes the (single) parent of `to`
      const rel = await setParentInternal(ctx, to, from.id, { relationId: args.id });
      return rel ?? (await getRelation(ctx, args.id));
    }
    const [dup] = await tx`select * from relations where type = ${args.type} and from_item_id = ${from.id} and to_item_id = ${to.id} and deleted_at is null`;
    if (dup) return dup;
    // Cycle / symmetric-duplicate checks are triggers (RAISE → 409 via toApiError).
    await tx`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${args.id}, ${args.type}, ${from.id}, ${to.id}, ${actor.id})`;
    const rel = await reload(tx, 'relations', args.id);
    await ctx.emit([{ entity_type: 'relation', entity_id: rel.id, item_id: from.id, project_id: from.project_id, action: 'relation_add', field: null, new_value: rel }]);
    if (rt.is_blocking) await touchItem(tx, to.id); // is_blocked is derived
    return rel;
  }

  if (!args.external_kind || !args.external_ref) throw validation('external_kind and external_ref are required when to_item_id is not given');
  const ref = args.external_ref as Record<string, unknown>;
  const refKey = externalRefKey(ref);
  const candidates = await tx`
    select * from relations where type = ${args.type} and from_item_id = ${from.id} and external_kind = ${args.external_kind} and deleted_at is null`;
  const dup = candidates.find((r) => externalRefKey(r.external_ref) === refKey);
  if (dup) return dup;
  await tx`
    insert into relations (id, type, from_item_id, external_kind, external_ref, created_by)
    values (${args.id}, ${args.type}, ${from.id}, ${args.external_kind}, ${tx.json(ref)}, ${actor.id})`;
  const rel = await reload(tx, 'relations', args.id);
  await ctx.emit([{ entity_type: 'relation', entity_id: rel.id, item_id: from.id, project_id: from.project_id, action: 'relation_add', field: null, new_value: rel }]);
  return rel;
}

export async function removeRelation(ctx: MutationCtx, args: MutationArgsOf<'removeRelation'>): Promise<Row> {
  const rel = await getRelation(ctx, args.id);
  const from = await getItem(ctx.tx, rel.from_item_id);
  await assertItem(ctx, 'relation.edit', from);
  await ctx.tx`update relations set deleted_at = ${nowIso()} where id = ${rel.id}`;
  await ctx.emit([{ entity_type: 'relation', entity_id: rel.id, item_id: from.id, project_id: from.project_id, action: 'relation_remove', field: null, old_value: rel }]);
  if (rel.to_item_id) await touchItem(ctx.tx, rel.to_item_id);
  return reload(ctx.tx, 'relations', rel.id);
}

/**
 * Make `parentId` the single parent of `child` (null = detach). Replacing an existing parent
 * soft-deletes the old parent_of edge. `silent` skips activity rows (used by createItem whose
 * `create` snapshot already carries parent_id).
 */
export async function setParentInternal(
  ctx: MutationCtx,
  child: Row,
  parentId: string | null,
  opts: { silent?: boolean; relationId?: string } = {},
): Promise<Row | null> {
  const { tx, actor } = ctx;
  const [current] = await tx`select * from relations where to_item_id = ${child.id} and type = 'parent_of' and deleted_at is null`;
  if (current && current.from_item_id === parentId) return current;
  if (current) {
    await tx`update relations set deleted_at = ${nowIso()} where id = ${current.id}`;
    if (!opts.silent) await ctx.emit([{ entity_type: 'relation', entity_id: current.id, item_id: child.id, project_id: child.project_id, action: 'relation_remove', field: null, old_value: current }]);
  }
  let rel: Row | null = null;
  if (parentId) {
    if (parentId === child.id) throw validation('an item cannot be its own parent');
    const parent = await getItem(tx, parentId);
    if (!(await canViewItem(tx, actor.id, parent.id))) throw notFound(`item ${parentId} not found`);
    const id = opts.relationId ?? randomUUID();
    await tx`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${id}, 'parent_of', ${parent.id}, ${child.id}, ${actor.id})`;
    rel = await reload(tx, 'relations', id);
    if (!opts.silent) await ctx.emit([{ entity_type: 'relation', entity_id: rel.id, item_id: child.id, project_id: child.project_id, action: 'relation_add', field: null, new_value: rel }]);
  }
  if (!opts.silent) await touchItem(tx, child.id); // parent_id is derived
  return rel;
}

export async function setParent(ctx: MutationCtx, args: MutationArgsOf<'setParent'>): Promise<Row> {
  const child = await getItem(ctx.tx, args.id);
  await assertItem(ctx, 'relation.edit', child);
  await setParentInternal(ctx, child, args.parent_id);
  return itemSnapshot(ctx.tx, child.id);
}
