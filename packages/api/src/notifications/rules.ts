import type { Q, Row, Tx } from '../db.js';
import type { MutationCtx, NotificationKind, PendingNotification } from '../mutations/context.js';
import { DEFAULT_RULES } from '../mutations/notifications.js';

export { DEFAULT_RULES };

/** Preference rule that gates a notification kind (null = always delivered). */
export function ruleKey(kind: NotificationKind, isAssignee?: boolean): string | null {
  switch (kind) {
    case 'mention': return 'mention';
    case 'assigned': return 'assigned';
    case 'reply': return 'reply';
    case 'state_change': return isAssignee ? 'state_change_assigned' : 'state_change_watching';
    case 'comment': return 'comment_watching';
    case 'due_soon': return 'due_soon';
    default: return null;
  }
}

type Prefs = Record<string, Row>; // channel -> notification_preferences row

async function loadPrefs(q: Q, userIds: string[]): Promise<Map<string, Prefs>> {
  const out = new Map<string, Prefs>();
  if (!userIds.length) return out;
  const rows = await q`select * from notification_preferences where user_id = any(${userIds}::uuid[]) and deleted_at is null`;
  for (const r of rows) {
    const p = out.get(r.user_id) ?? {};
    p[r.channel] = r;
    out.set(r.user_id, p);
  }
  return out;
}

function ruleOn(pref: Row | undefined, n: PendingNotification): boolean {
  if (n.explicit || n.kind === 'mutation_rejected') return true;
  const key = ruleKey(n.kind, n.isAssignee);
  if (!key) return true;
  const rules = { ...DEFAULT_RULES, ...((pref?.rules as Record<string, boolean> | undefined) ?? {}) };
  return rules[key] !== false;
}

// ---- scheduling ---------------------------------------------------------------
function localHM(date: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}
const parseHM = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** When to send for a cadence, honouring quiet hours ({start,end,tz}). */
export function scheduleFor(cadence: string, quiet: Record<string, unknown> | null, now = new Date()): Date {
  const tz = (quiet?.tz as string | undefined) ?? 'UTC';
  let t = new Date(now);
  if (cadence === 'hourly') {
    t = new Date(Math.ceil(t.getTime() / 3_600_000) * 3_600_000);
  } else if (cadence === 'daily') {
    const cur = localHM(t, tz);
    const target = 9 * 60;
    const delta = ((target - cur) % 1440 + 1440) % 1440 || 1440;
    t = new Date(t.getTime() + delta * 60_000);
    t.setUTCSeconds(0, 0);
  }
  const qs = parseHM(quiet?.start), qe = parseHM(quiet?.end);
  if (qs !== null && qe !== null && qs !== qe) {
    const cur = localHM(t, tz);
    const inWindow = qs < qe ? cur >= qs && cur < qe : cur >= qs || cur < qe;
    if (inWindow) {
      const delta = ((qe - cur) % 1440 + 1440) % 1440;
      t = new Date(t.getTime() + delta * 60_000);
      t.setUTCSeconds(0, 0);
    }
  }
  return t;
}

async function scheduleDelivery(q: Q, userId: string, channel: string, notificationId: string, cadence: string, quiet: Record<string, unknown> | null) {
  const at = scheduleFor(cadence, quiet).toISOString();
  const [pending] = await q`
    select id from notification_deliveries where user_id = ${userId} and channel = ${channel} and sent_at is null and scheduled_for > now()
    order by scheduled_for limit 1`;
  if (pending && cadence !== 'immediate') {
    await q`update notification_deliveries set notification_ids = array_append(notification_ids, ${notificationId}) where id = ${pending.id}`;
  } else {
    await q`insert into notification_deliveries (user_id, channel, notification_ids, scheduled_for) values (${userId}, ${channel}, ${[notificationId]}::uuid[], ${at})`;
  }
}

/** Create (or collapse into an unread) in-app notification and schedule outbound deliveries. Returns the row id or null when filtered. */
export async function deliverNotification(q: Q, n: PendingNotification & { actor_id?: string | null }, prefs: Prefs): Promise<string | null> {
  const inApp = prefs.in_app;
  if (inApp?.cadence === 'off' && n.kind !== 'mutation_rejected') return null;
  if (!ruleOn(inApp, n)) return null;

  const [existing] = n.item_id
    ? await q`select id from notifications where user_id = ${n.user_id} and item_id = ${n.item_id} and kind = ${n.kind} and read_at is null and deleted_at is null limit 1`
    : [];
  let id: string;
  if (existing) {
    await q`update notifications set title = ${n.title}, body = ${n.body ?? null}, actor_id = ${n.actor_id ?? null}, event_id = ${n.event_id ?? null} where id = ${existing.id}`;
    id = existing.id;
  } else {
    const [row] = await q`
      insert into notifications (user_id, item_id, event_id, kind, title, body, actor_id)
      values (${n.user_id}, ${n.item_id}, ${n.event_id ?? null}, ${n.kind}, ${n.title}, ${n.body ?? null}, ${n.actor_id ?? null}) returning id`;
    id = row!.id;
  }
  for (const channel of ['email', 'slack'] as const) {
    const pref = prefs[channel];
    if (!pref || pref.cadence === 'off') continue;
    if (!ruleOn(pref, n)) continue;
    await scheduleDelivery(q, n.user_id, channel, id, pref.cadence, pref.quiet_hours ?? null);
  }
  return id;
}

/** Called once per mutation: dedupe per (user,item,kind), apply rules, collapse unread, schedule deliveries. */
export async function flushNotifications(ctx: MutationCtx): Promise<string[]> {
  if (!ctx.notifications.length) return [];
  const seen = new Set<string>();
  const unique: PendingNotification[] = [];
  for (const n of ctx.notifications) {
    const k = `${n.user_id}|${n.item_id ?? ''}|${n.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(n);
  }
  const prefs = await loadPrefs(ctx.tx, [...new Set(unique.map((n) => n.user_id))]);
  const ids: string[] = [];
  for (const n of unique) {
    const eventId = n.event_id ?? ctx.events[0]?.id ?? null;
    const id = await deliverNotification(ctx.tx, { ...n, event_id: eventId, actor_id: ctx.actor.id }, prefs.get(n.user_id) ?? {});
    if (id) ids.push(id);
  }
  return ids;
}

/** Standalone notification outside a mutation (mutation_rejected, due_soon scheduler). */
export async function createNotification(q: Tx | Q, n: PendingNotification & { actor_id?: string | null }): Promise<string | null> {
  const prefs = await loadPrefs(q, [n.user_id]);
  return deliverNotification(q, n, prefs.get(n.user_id) ?? {});
}
