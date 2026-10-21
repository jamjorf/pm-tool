import type { FastifyInstance } from 'fastify';
import { MutationArgs, NotifyChannel } from '@pm/core';
import { requireAuth } from '../auth/plugin.js';
import { DEFAULT_RULES } from '../notifications/rules.js';
import { validation } from '../errors.js';
import { actorOf, flag, intQuery, parse, paramsOf, queryOf } from './util.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  app.get('/notifications', async (request) => {
    const actor = actorOf(request);
    const qs = queryOf(request);
    const unread = flag(qs.unread);
    const limit = intQuery(qs.limit, 50, 500);
    const notifications = await db`
      select n.*, w.key as item_key, w.title as item_title, u.name as actor_name
      from notifications n left join work_items w on w.id = n.item_id left join users u on u.id = n.actor_id
      where n.user_id = ${actor.id} and n.deleted_at is null and n.archived_at is null and (${!unread} or n.read_at is null)
      order by n.created_at desc limit ${limit}`;
    const [c] = await db`select count(*) as unread from notifications where user_id = ${actor.id} and read_at is null and deleted_at is null`;
    return { notifications, unread_count: Number(c?.unread ?? 0) };
  });

  app.post('/notifications/read-all', async (request) => app.mutateFor(request, { name: 'markAllNotificationsRead', args: {} }));

  app.post('/notifications/:id/read', async (request) => app.mutateFor(request, { name: 'markNotificationRead', args: { id: paramsOf(request).id! } }));

  app.get('/notification-preferences', async (request) => {
    const actor = actorOf(request);
    const preferences = await db`select * from notification_preferences where user_id = ${actor.id} and deleted_at is null order by channel`;
    return { preferences, defaults: { rules: DEFAULT_RULES, cadence: 'immediate' } };
  });

  app.put('/notification-preferences/:channel', async (request) => {
    const channel = NotifyChannel.safeParse(paramsOf(request).channel);
    if (!channel.success) throw validation('channel must be in_app, email or slack');
    const body = parse(MutationArgs.updateNotificationPreference.omit({ channel: true }), request.body);
    return app.mutateFor(request, { name: 'updateNotificationPreference', args: { ...body, channel: channel.data } });
  });
}
