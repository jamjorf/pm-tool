import type { Actor, Mutation, MutationArgsOf, MutationName } from '@pm/core';
import type { Tx } from '../db.js';
import type { MutationMeta } from '../activity.js';
import { MutationCtx } from './context.js';
import * as items from './items.js';
import * as relations from './relations.js';
import * as comments from './comments.js';
import * as views from './views.js';
import * as projects from './projects.js';
import * as admin from './admin.js';
import * as notif from './notifications.js';
import { flushNotifications } from '../notifications/rules.js';
import { enqueueWebhooks } from '../webhooks/enqueue.js';

export type { MutationMeta };
export { MutationCtx };

type Handler<N extends MutationName> = (ctx: MutationCtx, args: MutationArgsOf<N>) => Promise<unknown>;
const handlers: { [N in MutationName]: Handler<N> } = {
  createItem: items.createItem,
  updateItem: items.updateItem,
  bulkUpdateItems: items.bulkUpdateItems,
  transitionItem: items.transitionItem,
  bulkTransitionItems: items.bulkTransitionItems,
  deleteItem: items.deleteItem,
  restoreItem: items.restoreItem,
  moveItem: items.moveItem,
  reorderItem: items.reorderItem,
  addLabel: items.addLabel,
  removeLabel: items.removeLabel,
  createLabel: items.createLabel,
  addRelation: relations.addRelation,
  removeRelation: relations.removeRelation,
  setParent: relations.setParent,
  addComment: comments.addComment,
  editComment: comments.editComment,
  deleteComment: comments.deleteComment,
  watchItem: notif.watchItem,
  unwatchItem: notif.unwatchItem,
  markNotificationRead: notif.markNotificationRead,
  markAllNotificationsRead: notif.markAllNotificationsRead,
  createView: views.createView,
  updateView: views.updateView,
  deleteView: views.deleteView,
  createProject: projects.createProject,
  updateProject: projects.updateProject,
  setProjectMember: projects.setProjectMember,
  removeProjectMember: projects.removeProjectMember,
  upsertItemType: admin.upsertItemType,
  upsertWorkflow: admin.upsertWorkflow,
  updateNotificationPreference: notif.updateNotificationPreference,
};

/**
 * THE write path. Runs inside a transaction that already holds the sync advisory lock.
 * Checks permissions, validates, writes rows + activity events, maintains watchers,
 * produces notifications, enqueues webhooks and flags sync resyncs.
 */
export async function applyMutation(tx: Tx, actor: Actor, mutation: Mutation, meta: MutationMeta): Promise<unknown> {
  const handler = handlers[mutation.name] as Handler<MutationName> | undefined;
  if (!handler) throw new Error(`unknown mutation ${mutation.name}`);
  const ctx = new MutationCtx(tx, actor, { ...meta, mutationName: meta.mutationName || mutation.name });
  const result = await handler(ctx, mutation.args as never);
  await flushNotifications(ctx);
  await enqueueWebhooks(ctx);
  await applyResyncFlags(ctx);
  return result;
}

async function applyResyncFlags(ctx: MutationCtx) {
  if (ctx.resyncUsers === 'all') {
    await ctx.tx`update sync_client_groups set resync_required = true where not resync_required`;
    return;
  }
  if (ctx.resyncUsers.size) {
    await ctx.tx`update sync_client_groups set resync_required = true where user_id = any(${[...ctx.resyncUsers]}::uuid[]) and not resync_required`;
  }
  for (const pid of ctx.resyncProjects) {
    await ctx.tx`update sync_client_groups g set resync_required = true where not resync_required and effective_project_role(g.user_id, ${pid}) is not null`;
  }
}
