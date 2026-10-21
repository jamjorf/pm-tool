import type { MutationArgsOf } from '@pm/core';
import { nowIso, type Row } from '../db.js';
import { notFound, validation } from '../errors.js';
import { extractMentions, permissions } from '../core-compat.js';
import type { MutationCtx } from './context.js';
import { assertItem, ensureWatcher, getItem, getProject, itemCtx, projectCtx, reload } from './helpers.js';
import { actorName, snippet, watcherIds } from './notify-helpers.js';

const COMMENT_SOURCES = new Set(['app', 'api', 'mcp', 'slack', 'email', 'github']);

export async function getComment(ctx: MutationCtx, id: string): Promise<Row> {
  const [c] = await ctx.tx`select * from comments where id = ${id} and deleted_at is null`;
  if (!c) throw notFound(`comment ${id} not found`);
  return c;
}

export async function addComment(ctx: MutationCtx, args: MutationArgsOf<'addComment'>): Promise<Row> {
  const item = await getItem(ctx.tx, args.item_id);
  await assertItem(ctx, 'comment.create', item);
  return addCommentInternal(ctx, item, args);
}

/** Insert a comment on an already-authorized item; handles watchers + mention/reply/comment notifications. */
export async function addCommentInternal(
  ctx: MutationCtx,
  item: Row,
  args: { id: string; item_id?: string; body: string; parent_id?: string | null; external_ref?: Record<string, unknown> | null },
): Promise<Row> {
  const { tx, actor, meta } = ctx;
  let parent: Row | null = null;
  if (args.parent_id) {
    const [p] = await tx`select * from comments where id = ${args.parent_id} and item_id = ${item.id} and deleted_at is null`;
    if (!p) throw validation('parent comment not found on this item');
    parent = p;
  }
  const source = COMMENT_SOURCES.has(meta.source) ? meta.source : 'app';
  await tx`
    insert into comments (id, item_id, author_id, body, parent_id, source, external_ref)
    values (${args.id}, ${item.id}, ${actor.id}, ${args.body}, ${parent?.id ?? null}, ${source}, ${args.external_ref ? tx.json(args.external_ref) : null})`;
  const comment = await reload(tx, 'comments', args.id);
  await ctx.emit([{ entity_type: 'comment', entity_id: comment.id, item_id: item.id, project_id: item.project_id, action: 'create', field: null, new_value: comment }]);

  await ensureWatcher(ctx, item.id, actor.id, 'commenter');
  const who = await actorName(ctx);
  const notified = new Set<string>([actor.id]);
  for (const userId of extractMentions(args.body)) {
    if (notified.has(userId)) continue;
    const [u] = await tx`select id from users where id = ${userId} and deleted_at is null and is_active = 1`;
    if (!u) continue;
    await ensureWatcher(ctx, item.id, userId, 'mention');
    ctx.notify({ user_id: userId, item_id: item.id, kind: 'mention', title: `${who} mentioned you in ${item.key}: ${item.title}`, body: snippet(args.body), event_id: ctx.events.at(-1)?.id });
    notified.add(userId);
  }
  if (parent?.author_id && !notified.has(parent.author_id)) {
    ctx.notify({ user_id: parent.author_id, item_id: item.id, kind: 'reply', title: `${who} replied to your comment on ${item.key}`, body: snippet(args.body) });
    notified.add(parent.author_id);
  }
  for (const w of await watcherIds(ctx, item.id)) {
    if (notified.has(w)) continue;
    ctx.notify({ user_id: w, item_id: item.id, kind: 'comment', title: `${who} commented on ${item.key}: ${item.title}`, body: snippet(args.body) });
    notified.add(w);
  }
  return comment;
}

export async function editComment(ctx: MutationCtx, args: MutationArgsOf<'editComment'>): Promise<Row> {
  const comment = await getComment(ctx, args.id);
  const item = await getItem(ctx.tx, comment.item_id);
  const project = await getProject(ctx.tx, item.project_id);
  const resource = { item: itemCtx(item, project), project: projectCtx(project), ownerId: comment.author_id };
  if (comment.author_id === ctx.actor.id) permissions.assert(ctx.actor, 'comment.edit_own', resource);
  else permissions.assert(ctx.actor, 'comment.edit_any', resource);
  await ctx.tx`update comments set body = ${args.body}, edited_at = ${nowIso()} where id = ${comment.id}`;
  await ctx.emit([{ entity_type: 'comment', entity_id: comment.id, item_id: item.id, project_id: item.project_id, action: 'update', field: 'body', old_value: comment.body, new_value: args.body }]);
  return reload(ctx.tx, 'comments', comment.id);
}

export async function deleteComment(ctx: MutationCtx, args: MutationArgsOf<'deleteComment'>): Promise<Row> {
  const comment = await getComment(ctx, args.id);
  const item = await getItem(ctx.tx, comment.item_id);
  const project = await getProject(ctx.tx, item.project_id);
  const resource = { item: itemCtx(item, project), project: projectCtx(project), ownerId: comment.author_id };
  if (comment.author_id === ctx.actor.id) permissions.assert(ctx.actor, 'comment.edit_own', resource);
  else permissions.assert(ctx.actor, 'comment.delete_any', resource);
  await ctx.tx`update comments set deleted_at = ${nowIso()} where id = ${comment.id}`;
  await ctx.emit([{ entity_type: 'comment', entity_id: comment.id, item_id: item.id, project_id: item.project_id, action: 'delete', field: null, old_value: comment }]);
  return reload(ctx.tx, 'comments', comment.id);
}
