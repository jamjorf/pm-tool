import { createHmac } from 'node:crypto';
import type { Row, Sql } from '../db.js';

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

/** One dispatcher pass: claim due deliveries (skip locked), send, record outcome/backoff. Returns the number processed. */
export async function dispatchPendingWebhooks(sql: Sql, log: { info: Function; warn: Function; error: Function }, batch = 25): Promise<number> {
  const claimed: Row[] = await sql.begin(async (tx) => {
    const rows = await tx`
      select d.id, d.endpoint_id, d.event_kind, d.payload, d.attempts, e.url, e.secret, e.name
      from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
      where d.status in ('pending','failed') and d.next_attempt_at <= now() and e.is_active and e.deleted_at is null
      order by d.next_attempt_at, d.id limit ${batch} for update of d skip locked`;
    if (rows.length) await tx`update webhook_deliveries set last_attempt_at = now() where id = any(${rows.map((r) => r.id)}::bigint[])`;
    return rows as unknown as Row[];
  }) as unknown as Row[];
  // Also expire deliveries whose endpoint was deactivated/deleted
  await sql`update webhook_deliveries d set status = 'dead' from webhook_endpoints e
            where e.id = d.endpoint_id and d.status in ('pending','failed') and (not e.is_active or e.deleted_at is not null)`;

  for (const d of claimed) {
    const res = await sendWebhook({ url: d.url, secret: d.secret }, d.event_kind, d.payload, String(d.id));
    const attempts = (d.attempts as number) + 1;
    if (res.ok) {
      await sql`update webhook_deliveries set status = 'delivered', attempts = ${attempts}, response_status = ${res.status}, response_body = ${res.body} where id = ${d.id}`;
    } else {
      const dead = attempts >= MAX_ATTEMPTS;
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
      await sql`
        update webhook_deliveries set status = ${dead ? 'dead' : 'failed'}, attempts = ${attempts}, response_status = ${res.status},
          response_body = ${res.body ?? res.error ?? null}, next_attempt_at = now() + (${delay} || ' milliseconds')::interval
        where id = ${d.id}`;
      log.warn({ delivery: d.id, endpoint: d.name, status: res.status, error: res.error, attempts, dead }, 'webhook delivery failed');
    }
  }
  return claimed.length;
}
