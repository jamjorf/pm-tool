import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseMutation, type PushRequest } from '@pm/core';
import { isUuid, nowIso, withTxn, type Sql } from '../db.js';
import { conflict, forbidden, toApiError } from '../errors.js';
import { applyMutation } from '../mutations/index.js';
import { createNotification } from '../notifications/rules.js';
import { pokeAfterCommit } from './poke.js';

/** Insert the client group for this user (403 when it belongs to someone else). */
export async function ensureClientGroup(sql: Sql, groupId: string, userId: string) {
  const [g] = await sql`
    insert into sync_client_groups (id, user_id) values (${groupId}, ${userId})
    on conflict (id) do update set last_seen_at = ${nowIso()}
    returning user_id`;
  if (g && g.user_id !== userId) throw forbidden('client group belongs to another user');
}

function itemIdOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const id = a.item_id ?? a.id;
  return isUuid(id) ? id : null;
}

/**
 * POST /sync/push. Each mutation runs in its own write transaction (writers are serialised, so the
 * plain select of last_mutation_id is exact). Replays (id <= last) are skipped, gaps (id > last+1)
 * are rejected, failures are logged, still marked applied and surfaced to the user as a
 * `mutation_rejected` notification.
 */
export async function handlePush(app: FastifyInstance, request: FastifyRequest, body: PushRequest): Promise<Record<string, never>> {
  const actor = request.actor!;
  const sql = app.db;
  await ensureClientGroup(sql, body.clientGroupID, actor.id);
  let applied = 0;
  for (const m of body.mutations) {
    const meta = app.metaFor(request, m.name);
    const outcome = await withTxn(sql, async (tx) => {
      const [client] = await tx`select last_mutation_id from sync_clients where id = ${m.clientID}`;
      const last: number = Number(client?.last_mutation_id ?? 0);
      if (!client) await tx`insert into sync_clients (id, client_group_id, last_mutation_id) values (${m.clientID}, ${body.clientGroupID}, 0)`;
      if (m.id <= last) return 'skip' as const;
      if (m.id > last + 1) throw conflict(`mutation ${m.id} from client ${m.clientID} is out of order (expected ${last + 1})`);
      try {
        const mutation = parseMutation(m.name, m.args);
        await tx.savepoint(async (sp) => {
          await applyMutation(sp, actor, mutation, { ...meta, txnId: randomUUID() });
        });
      } catch (err) {
        const e = toApiError(err);
        request.log.warn({ err, mutation: m.name, mutationId: m.id, clientID: m.clientID }, 'sync mutation rejected');
        let itemId = itemIdOf(m.args);
        if (itemId) {
          const [exists] = await tx`select id from work_items where id = ${itemId}`;
          if (!exists) itemId = null;
        }
        await createNotification(tx, {
          user_id: actor.id, item_id: itemId, kind: 'mutation_rejected', explicit: true, actor_id: actor.id,
          title: `Change rejected: ${m.name}`,
          body: e.details !== undefined ? `${e.message}\n${JSON.stringify(e.details)}` : e.message,
        });
      }
      // sync_clients.version = the global version at which last_mutation_id changed (nextval in Postgres).
      await tx`update sync_clients set last_mutation_id = ${m.id}, version = ${tx.nextVersion()}, last_seen_at = ${nowIso()} where id = ${m.clientID}`;
      return 'applied' as const;
    });
    if (outcome === 'applied') applied++;
  }
  if (applied) await pokeAfterCommit(sql);
  return {};
}
