import type { FastifyInstance } from 'fastify';
import { isoIn, nowIso, type Row, type Sql } from '../db.js';
import type { IntegrationsModule, OutboundNotificationLike } from '../integrations.js';

/** Build the outbound model for a notification row (+ its item summary). */
async function outbound(sql: Sql, appUrl: string, n: Row): Promise<OutboundNotificationLike> {
  let item = null;
  if (n.item_id) {
    const [w] = await sql`select * from work_items_v where id = ${n.item_id}`;
    if (w) {
      item = {
        id: w.id, key: w.key, title: w.title, description: w.description, type_key: w.type_key, project_id: w.project_id, project_key: w.project_key,
        state_name: w.state_name, state_category: w.state_category, priority: w.priority, assignee_name: w.assignee_name, assignee_id: w.assignee_id,
        due_date: w.due_date, url: `${appUrl}/i/${w.key}`,
      };
    }
  }
  const [actor] = n.actor_id ? await sql`select name from users where id = ${n.actor_id}` : [null];
  return { kind: n.kind, title: n.title, body: n.body, item, actorName: actor?.name ?? null, createdAt: n.created_at };
}

/**
 * One pass: send due email/slack deliveries through @pm/integrations (or log when unavailable).
 * Due rows are claimed (sent_at stamped) in one short write transaction, then sent with no
 * transaction open: the process is the single writer, so this replaces `for update skip locked`.
 */
export async function processNotificationDeliveries(app: FastifyInstance, integrations: IntegrationsModule | null, batch = 50): Promise<number> {
  const sql = app.db;
  const due: Row[] = await sql.begin(async (tx) => {
    const now = nowIso();
    const rows = await tx`
      select * from notification_deliveries
      where sent_at is null and scheduled_for <= ${now} and (error is null or created_at > ${isoIn(-86_400_000)})
      order by scheduled_for, id limit ${batch}`;
    if (rows.length) await tx`update notification_deliveries set sent_at = ${now} where id in ${tx(rows.map((r) => r.id))}`;
    return rows;
  });

  for (const d of due) {
    try {
      const ids: string[] = Array.isArray(d.notification_ids) ? d.notification_ids : [];
      const notes = ids.length ? await sql`select * from notifications where id in ${sql(ids)} and deleted_at is null order by created_at` : [];
      if (!notes.length) continue;
      const [user] = await sql`select id, email, name, settings from users where id = ${d.user_id} and deleted_at is null and is_active = 1`;
      if (!user) continue;
      const items = [];
      for (const n of notes) items.push(await outbound(sql, app.config.APP_URL, n));
      const rendered = items.length === 1 ? integrations?.renderNotification(items[0]!) : integrations?.renderDigest(items);
      if (!integrations || !rendered) {
        app.log.info({ delivery: d.id, user: user.email, channel: d.channel, count: items.length, titles: items.map((i) => i.title) }, 'notification delivery (no integrations module; logged only)');
        continue;
      }
      if (d.channel === 'email') {
        await integrations.sendEmail(app.integrationDeps!, { to: user.email, subject: rendered.subject, text: rendered.text, html: rendered.html });
      } else if (d.channel === 'slack') {
        const channel = (user.settings as Record<string, unknown> | null)?.slack_user_id as string | undefined;
        if (!channel) {
          app.log.info({ delivery: d.id, user: user.email }, 'slack delivery skipped: user has no slack_user_id');
          continue;
        }
        await integrations.sendSlackMessage(app.integrationDeps!, { channel, text: rendered.text, blocks: rendered.slackBlocks });
      }
    } catch (e) {
      app.log.warn({ err: e, delivery: d.id }, 'notification delivery failed');
      await sql`update notification_deliveries set sent_at = null, error = ${(e as Error).message}, scheduled_for = ${isoIn(10 * 60_000)} where id = ${d.id}`;
    }
  }
  return due.length;
}
