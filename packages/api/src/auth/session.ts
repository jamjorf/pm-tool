import { nowIso, type Q } from '../db.js';
import { randomToken, sha256 } from './tokens.js';

export const SESSION_COOKIE = 'pm_session';

export async function createSession(q: Q, userId: string, ttlDays: number): Promise<{ token: string; expires_at: string }> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + ttlDays * 86_400_000);
  await q`insert into sessions (user_id, token_hash, expires_at) values (${userId}, ${sha256(token)}, ${expires.toISOString()})`;
  return { token, expires_at: expires.toISOString() };
}

/** Resolve a raw session token to a user id (null if unknown/expired). */
export async function resolveSession(q: Q, token: string): Promise<string | null> {
  const now = nowIso();
  const [s] = await q`
    update sessions set last_seen_at = ${now}
    where token_hash = ${sha256(token)} and expires_at > ${now}
    returning user_id`;
  return s?.user_id ?? null;
}

export async function destroySession(q: Q, token: string): Promise<void> {
  await q`delete from sessions where token_hash = ${sha256(token)}`;
}
