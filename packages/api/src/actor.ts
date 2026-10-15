import type { Actor, ProjectRole, FirmRole } from '@pm/core';
import type { Q, Row } from './db.js';
import { unauthorized } from './errors.js';

export interface UserRow extends Row {
  id: string;
  email: string;
  name: string;
  firm_role: FirmRole;
  is_active: boolean;
  is_service: boolean;
  settings: Record<string, unknown>;
}

export async function loadUser(q: Q, userId: string): Promise<UserRow | null> {
  const [u] = await q`select * from users where id = ${userId} and deleted_at is null`;
  return (u as UserRow) ?? null;
}

/** Build the permission Actor for a user: firm role + explicit memberships (+ API key scopes). */
export async function loadActor(q: Q, userId: string, opts: { scopes?: string[] } = {}): Promise<Actor> {
  const user = await loadUser(q, userId);
  if (!user || !user.is_active) throw unauthorized('user not found or inactive');
  const rows = await q`select project_id, role from project_members where user_id = ${userId} and deleted_at is null`;
  const memberships: Record<string, ProjectRole> = {};
  for (const r of rows) memberships[r.project_id] = r.role as ProjectRole;
  const actor: Actor = { id: user.id, firmRole: user.firm_role, memberships, isService: user.is_service };
  if (opts.scopes) actor.scopes = opts.scopes;
  return actor;
}

/** Service user used for system-originated writes (schedulers, integrations without a resolved user). */
export async function ensureServiceUser(q: Q, label: string): Promise<UserRow> {
  const email = `${label}@system.local`;
  const [existing] = await q`select * from users where lower(email) = lower(${email}) and deleted_at is null`;
  if (existing) return existing as UserRow;
  const [created] = await q`
    insert into users (email, name, firm_role, is_service) values (${email}, ${label}, 'admin', true) returning *`;
  return created as UserRow;
}
