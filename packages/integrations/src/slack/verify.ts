import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_MAX_SKEW_SECONDS = 5 * 60;

/**
 * Slack "v0" request signature: HMAC-SHA256(signingSecret, `v0:${timestamp}:${rawBody}`),
 * compared (constant time) against the `X-Slack-Signature` header. Rejects
 * timestamps more than 5 minutes away from `now` (replay protection).
 */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | number | undefined,
  signature: string | undefined,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signingSecret || timestamp === undefined || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SLACK_MAX_SKEW_SECONDS) return false;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Produce the header value Slack would send (handy for tests and local tooling). */
export function signSlackRequest(signingSecret: string, rawBody: string, timestamp: number): string {
  return 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}
