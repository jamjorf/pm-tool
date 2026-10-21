import type { EventRow } from '../activity.js';
import { eventKindOf } from '../core-compat.js';
import type { MutationCtx } from '../mutations/context.js';
import { itemView, userName } from '../mutations/helpers.js';

/** When several kinds happen in one txn for one item, the delivery carries the most specific one. */
export const KIND_PRIORITY = [
  'item.completed', 'item.created', 'item.deleted', 'item.restored', 'item.transitioned', 'item.updated',
  'comment.created', 'comment.updated', 'comment.deleted', 'relation.added', 'relation.removed', 'project.created', 'project.updated',
];
export const pickPrimaryKind = (kinds: string[]): string =>
  [...kinds].sort((a, b) => (KIND_PRIORITY.indexOf(a) + 1 || 99) - (KIND_PRIORITY.indexOf(b) + 1 || 99))[0]!;

interface Group { itemId: string | null; projectId: string | null; events: EventRow[]; kinds: Set<string> }

/** Enqueue webhook_deliveries for this mutation: one delivery per (endpoint, txn, item). */
export async function enqueueWebhooks(ctx: MutationCtx): Promise<number> {
  if (!ctx.events.length) return 0;
  const endpoints = await ctx.tx`select * from webhook_endpoints where is_active and deleted_at is null`;
  if (!endpoints.length) return 0;

  const groups = new Map<string, Group>();
  const groupFor = (key: string, itemId: string | null, projectId: string | null) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { itemId, projectId, events: [], kinds: new Set() }));
    if (!g.projectId && projectId) g.projectId = projectId;
    return g;
  };
  for (const e of ctx.events) {
    const g = groupFor(e.item_id ?? `${e.entity_type}:${e.entity_id}`, e.item_id, e.project_id);
    g.events.push(e);
    const kind = eventKindOf(e);
    if (kind) g.kinds.add(kind);
  }
  for (const [itemId, kinds] of ctx.forcedWebhookKinds) {
    const g = groups.get(itemId);
    if (g) for (const k of kinds) g.kinds.add(k);
  }

  const actor = { id: ctx.actor.id, name: await userName(ctx.tx, ctx.actor.id), kind: ctx.meta.actorKind };
  let count = 0;
  for (const g of groups.values()) {
    if (!g.kinds.size || !g.events.length) continue;
    const matching = endpoints.filter(
      (ep) => (!ep.project_id || ep.project_id === g.projectId) && ((ep.event_kinds as string[]).includes('*') || (ep.event_kinds as string[]).some((k) => g.kinds.has(k))),
    );
    if (!matching.length) continue;
    const item = g.itemId ? await itemView(ctx.tx, g.itemId) : null;
    const [project] = g.projectId ? await ctx.tx`select id, key, name from projects where id = ${g.projectId}` : [null];
    const changes = g.events.filter((e) => e.field).map((e) => ({ field: e.field, old: e.old_value ?? null, new: e.new_value ?? null }));
    const eventIds = g.events.map((e) => e.id);
    for (const ep of matching) {
      const allowed = (ep.event_kinds as string[]).includes('*') ? [...g.kinds] : [...g.kinds].filter((k) => (ep.event_kinds as string[]).includes(k));
      const kind = pickPrimaryKind(allowed);
      const payload = { id: null as string | null, kind, created_at: new Date().toISOString(), actor, project: project ?? null, item, changes, event_ids: eventIds };
      const [d] = await ctx.tx`
        insert into webhook_deliveries (endpoint_id, event_id, event_kind, payload) values (${ep.id}, ${eventIds[0]!}, ${kind}, ${ctx.tx.json(payload as any)}) returning id`;
      await ctx.tx`update webhook_deliveries set payload = payload || jsonb_build_object('id', ${String(d!.id)}::text) where id = ${d!.id}`;
      count++;
    }
  }
  return count;
}
