import { createHmac } from 'node:crypto';
import { isoIn, nowIso, type Row, type Sql } from '../db.js';

/** Retry backoff: 1m → 5m → 30m → 2h → 12h, then dead. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export const signBody = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

export interface SendResult { ok: boolean; status: number | null; body: string | null; error?: string }

/** Deliver one payload with the documented headers (X-PM-Event / X-PM-Delivery / X-PM-Signature). */
export async function sendWebhook(endpoint: Row, kind: string, payload: unknown, deliveryId: string, timeoutMs = 10_000): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'pm-tool-webhooks/1',
        'X-PM-Event': kind,
        'X-PM-Delivery': deliveryId,
        'X-PM-Signature': signBody(endpoint.secret, body),
      },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text.slice(0, 4000) };
  } catch (e) {
    return { ok: false, status: null, body: null, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** A row claimed less than this long ago is in flight in another pass (send timeout + slack); skip it. */
const IN_FLIGHT_MS = 15_000;

/**
 * One dispatcher pass: claim due deliveries, send, record outcome/backoff. Returns the number processed.
 * The claim (select + stamp last_attempt_at) is one short write transaction and the HTTP calls happen
 * with no transaction open — the process is the single writer, so this replaces `for update skip locked`.
 */
export async function dispatchPendingWebhooks(sql: Sql, log: { info: Function; warn: Function; error: Function }, batch = 25): Promise<number> {
  const claimed: Row[] = await sql.begin(async (tx) => {
    const now = nowIso();
    const rows = await tx`
      select d.id, d.endpoint_id, d.event_kind, d.payload, d.attempts, e.url, e.secret, e.name
      from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
      where d.status in ('pending','failed') and d.next_attempt_at <= ${now} and e.is_active = 1 and e.deleted_at is null
        and (d.last_attempt_at is null or d.last_attempt_at <= ${isoIn(-IN_FLIGHT_MS)})
      order by d.next_attempt_at, d.id limit ${batch}`;
    if (rows.length) await tx`update webhook_deliveries set last_attempt_at = ${now} where id in ${tx(rows.map((r) => r.id))}`;
    return rows;
  });
  // Also expire deliveries whose endpoint was deactivated/deleted
  await sql`update webhook_deliveries set status = 'dead'
            where status in ('pending','failed')
              and endpoint_id in (select id from webhook_endpoints where is_active = 0 or deleted_at is not null)`;

  for (const d of claimed) {
    const res = await sendWebhook({ url: d.url, secret: d.secret }, d.event_kind, d.payload, String(d.id));
    const attempts = Number(d.attempts) + 1;
    if (res.ok) {
      await sql`update webhook_deliveries set status = 'delivered', attempts = ${attempts}, response_status = ${res.status}, response_body = ${res.body} where id = ${d.id}`;
    } else {
      const dead = attempts >= MAX_ATTEMPTS;
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
      await sql`
        update webhook_deliveries set status = ${dead ? 'dead' : 'failed'}, attempts = ${attempts}, response_status = ${res.status},
          response_body = ${res.body ?? res.error ?? null}, next_attempt_at = ${isoIn(delay)}
        where id = ${d.id}`;
      log.warn({ delivery: d.id, endpoint: d.name, status: res.status, error: res.error, attempts, dead }, 'webhook delivery failed');
    }
  }
  return claimed.length;
}
