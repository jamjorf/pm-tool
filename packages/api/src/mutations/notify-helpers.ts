import type { MutationCtx } from './context.js';
import { userName } from './helpers.js';

const nameCache = new WeakMap<MutationCtx, Promise<string>>();
/** Display name of the acting user (cached per mutation). */
export function actorName(ctx: MutationCtx): Promise<string> {
  let p = nameCache.get(ctx);
  if (!p) nameCache.set(ctx, (p = userName(ctx.tx, ctx.actor.id).then((n) => n ?? 'Someone')));
  return p;
}

export const snippet = (s: string | null | undefined, n = 200) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null);

export async function watcherIds(ctx: MutationCtx, itemId: string): Promise<string[]> {
  const rows = await ctx.tx`select user_id from item_watchers where item_id = ${itemId} and deleted_at is null and muted = 0`;
  return rows.map((r) => r.user_id);
}
