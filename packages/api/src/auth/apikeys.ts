import type { Q, Row } from '../db.js';
import { randomToken, sha256 } from './tokens.js';

export const API_KEY_PREFIX = 'pm_';

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomToken(32);
}

export async function createApiKey(q: Q, userId: string, name: string, scopes: string[] = ['read', 'write'], expiresAt?: string | null): Promise<Row & { key: string }> {
  const key = generateApiKey();
  const [row] = await q`
    insert into api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at)
    values (${userId}, ${name}, ${key.slice(0, 8)}, ${sha256(key)}, ${scopes}, ${expiresAt ?? null})
    returning id, name, key_prefix, scopes, expires_at, created_at`;
  return { ...(row as Row), key } as Row & { key: string };
}

export async function resolveApiKey(q: Q, key: string): Promise<{ id: string; user_id: string; name: string; scopes: string[] } | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const [row] = await q`
    update api_keys set last_used_at = now()
    where key_hash = ${sha256(key)} and revoked_at is null and (expires_at is null or expires_at > now())
    returning id, user_id, name, scopes`;
  return (row as any) ?? null;
}
