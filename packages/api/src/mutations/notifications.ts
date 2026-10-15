import type { MutationArgsOf } from '@pm/core';
import type { Row } from '../db.js';
import { notFound } from '../errors.js';
import type { MutationCtx } from './context.js';
import { assertItem, ensureWatcher, getItem, itemSnapshot } from './helpers.js';

export async function watchItem(ctx: MutationCtx, args: MutationArgsOf<'watchItem'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.item_id);
  await assertItem(ctx, 'item.view', item);
  await ctx.tx`
    insert into item_watchers (item_id, user_id, reason) values (${item.id}, ${ctx.actor.id}, 'manual')
    on conflict (item_id, user_id) do update set deleted_at = null, muted = false, reason = 'manual'
    where item_watchers.deleted_at is not null or item_watchers.muted`;
  return itemSnapshot(ctx.tx, item.id);
}

export async function unwatchItem(ctx: MutationCtx, args: MutationArgsOf<'unwatchItem'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.item_id);
  await assertItem(ctx, 'item.view', item);
  await ctx.tx`update item_watchers set deleted_at = now() where item_id = ${item.id} and user_id = ${ctx.actor.id} and deleted_at is null`;
  return itemSnapshot(ctx.tx, item.id);
}

export async function markNotificationRead(ctx: MutationCtx, args: MutationArgsOf<'markNotificationRead'>): Promise<Row> {
  const [n] = await ctx.tx`
    update notifications set read_at = coalesce(read_at, now()) where id = ${args.id} and user_id = ${ctx.actor.id} and deleted_at is null returning *`;
  if (!n) throw notFound(`notification ${args.id} not found`);
  return n;
}

export async function markAllNotificationsRead(ctx: MutationCtx, _args: MutationArgsOf<'markAllNotificationsRead'>): Promise<{ count: number }> {
  const rows = await ctx.tx`update notifications set read_at = now() where user_id = ${ctx.actor.id} and read_at is null and deleted_at is null returning id`;
  return { count: rows.length };
}

export async function updateNotificationPreference(ctx: MutationCtx, args: MutationArgsOf<'updateNotificationPreference'>): Promise<Row> {
  const [existing] = await ctx.tx`select * from notification_preferences where user_id = ${ctx.actor.id} and channel = ${args.channel}`;
  const rules = { ...(existing?.rules ?? {}), ...(args.rules ?? {}) };
  const cadence = args.cadence ?? existing?.cadence ?? 'immediate';
  const quiet = args.quiet_hours === undefined ? (existing?.quiet_hours ?? null) : args.quiet_hours;
  const [row] = existing
    ? await ctx.tx`
        update notification_preferences set cadence = ${cadence}, rules = ${ctx.tx.json(rules as any)}, quiet_hours = ${quiet ? ctx.tx.json(quiet as any) : null}, deleted_at = null
        where user_id = ${ctx.actor.id} and channel = ${args.channel} returning *`
    : await ctx.tx`
        insert into notification_preferences (user_id, channel, cadence, rules, quiet_hours)
        values (${ctx.actor.id}, ${args.channel}, ${cadence}, ${args.rules ? ctx.tx.json({ ...DEFAULT_RULES, ...rules } as any) : ctx.tx.json(DEFAULT_RULES as any)}, ${quiet ? ctx.tx.json(quiet as any) : null})
        returning *`;
  return row!;
}

export const DEFAULT_RULES: Record<string, boolean> = {
  mention: true, assigned: true, reply: true, state_change_assigned: true, state_change_watching: false, comment_watching: false, due_soon: true,
};
