import type { Q } from '../db.js';
import { withTxn, type Sql } from '../db.js';
import type { UserRow } from '../actor.js';

/** Find a user by email, creating it when missing. The first (non-service) user becomes firm owner. */
export async function findOrCreateUser(sql: Sql, email: string, name?: string): Promise<UserRow> {
  const found = await findUserByEmail(sql, email);
  if (found) return found;
  return withTxn(sql, async (tx) => {
    const again = await findUserByEmail(tx, email);
    if (again) return again;
    const cnt = await tx`select count(*) as n from users where deleted_at is null and is_service = 0`;
    const role = Number(cnt[0]!.n) === 0 ? 'owner' : 'member';
    const displayName = name?.trim() || email.split('@')[0] || email;
    await tx`insert into users (email, name, firm_role) values (${email.trim()}, ${displayName}, ${role})`;
    return (await findUserByEmail(tx, email))!; // re-read: version is stamped by a trigger after insert
  });
}

export async function findUserByEmail(q: Q, email: string): Promise<UserRow | null> {
  const [u] = await q`select * from users where lower(email) = lower(${email.trim()}) and deleted_at is null`;
  return (u as UserRow) ?? null;
}
