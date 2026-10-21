import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVENT_KINDS, FieldDef, FirmRole, Guard, Effect, StateCategory } from '@pm/core';
import { requireAuth, requireFirmAdmin } from '../auth/plugin.js';
import { isUuid, withTxn } from '../db.js';
import { notFound, validation } from '../errors.js';
import { writeEvents } from '../activity.js';
import { getWorkflowDef, resolveProjectId } from '../mutations/helpers.js';
import { sendWebhook } from '../webhooks/dispatcher.js';
import { actorOf, flag, intQuery, parse, paramsOf, projectIdQuery, queryOf, zUuid } from './util.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const db = app.db;

  // ---- item types -----------------------------------------------------------
  app.get('/types', async () => ({ types: await db`select * from item_types where deleted_at is null order by sort, key` }));

  app.put('/types/:key', async (request) => {
    const key = paramsOf(request).key!;
    const body = parse(z.object({
      id: zUuid.optional(), name: z.string().min(1), plural_name: z.string().nullable().optional(), icon: z.string().nullable().optional(), color: z.string().nullable().optional(),
      description: z.string().nullable().optional(), workflow_id: zUuid.optional(), workflow: z.string().optional(), field_defs: z.array(FieldDef),
      is_container: z.boolean().optional(), sort: z.number().int().optional(), is_active: z.boolean().optional(),
    }), request.body);
    const [existing] = await db`select id, workflow_id from item_types where key = ${key}`;
    let workflow_id = body.workflow_id ?? existing?.workflow_id ?? null;
    if (body.workflow && !body.workflow_id) {
      const [wf] = isUuid(body.workflow) ? await db`select id from workflows where id = ${body.workflow}` : await db`select id from workflows where key = ${body.workflow} and deleted_at is null`;
      if (!wf) throw notFound(`workflow ${body.workflow} not found`);
      workflow_id = wf.id;
    }
    if (!workflow_id) throw validation('workflow_id (or workflow key) is required');
    const { workflow, ...rest } = body;
    void workflow;
    return app.mutateFor(request, { name: 'upsertItemType', args: { ...rest, key, id: existing?.id ?? body.id ?? randomUUID(), workflow_id } }, { force: flag(queryOf(request).force) });
  });

  // ---- workflows ------------------------------------------------------------
  app.get('/workflows', async () => {
    const wfs = await db`select * from workflows where deleted_at is null order by key`;
    const out = [];
    for (const wf of wfs) {
      const def = await getWorkflowDef(db, wf.id);
      out.push({ ...wf, states: def.states, transitions: def.transitions });
    }
    return { workflows: out };
  });

  app.get('/workflows/:key', async (request) => {
    const ref = paramsOf(request).key!;
    const [wf] = isUuid(ref) ? await db`select * from workflows where id = ${ref} and deleted_at is null` : await db`select * from workflows where key = ${ref} and deleted_at is null`;
    if (!wf) throw notFound(`workflow ${ref} not found`);
    const def = await getWorkflowDef(db, wf.id);
    return { ...wf, states: def.states, transitions: def.transitions };
  });

  app.put('/workflows/:key', async (request) => {
    const key = paramsOf(request).key!;
    const body = parse(z.object({
      id: zUuid.optional(), name: z.string().min(1), description: z.string().nullable().optional(),
      states: z.array(z.object({ id: zUuid.optional(), key: z.string().min(1), name: z.string().min(1), category: StateCategory, color: z.string().nullable().optional(), sort: z.number().int().optional(), is_initial: z.boolean().optional() })).min(1),
      transitions: z.array(z.object({
        id: zUuid.optional(), key: z.string().min(1), name: z.string().min(1),
        from_state_id: zUuid.nullable().optional(), from: z.string().nullable().optional(), to_state_id: zUuid.optional(), to: z.string().optional(),
        guards: z.array(Guard).optional(), effects: z.array(Effect).optional(), sort: z.number().int().optional(),
      })),
    }), request.body);
    const [existing] = await db`select id from workflows where key = ${key}`;
    const existingStates = existing ? await db`select id, key from workflow_states where workflow_id = ${existing.id}` : [];
    const stateIdByKey = new Map<string, string>();
    const states = body.states.map((s, i) => {
      const id = s.id ?? existingStates.find((e) => e.key === s.key)?.id ?? randomUUID();
      stateIdByKey.set(s.key, id);
      return { id, key: s.key, name: s.name, category: s.category, color: s.color ?? null, sort: s.sort ?? i, is_initial: s.is_initial ?? false };
    });
    if (!states.some((s) => s.is_initial)) states[0]!.is_initial = true;
    const resolveState = (id: string | null | undefined, k: string | null | undefined, what: string) => {
      if (id) return id;
      if (k) {
        const r = stateIdByKey.get(k);
        if (!r) throw validation(`transition ${what}: unknown state key "${k}"`);
        return r;
      }
      return null;
    };
    const transitions = body.transitions.map((t, i) => {
      const to = resolveState(t.to_state_id, t.to, t.key);
      if (!to) throw validation(`transition ${t.key}: to_state_id or to is required`);
      return { id: t.id ?? randomUUID(), key: t.key, name: t.name, from_state_id: resolveState(t.from_state_id, t.from, t.key), to_state_id: to, guards: t.guards ?? [], effects: t.effects ?? [], sort: t.sort ?? i };
    });
    return app.mutateFor(request, { name: 'upsertWorkflow', args: { id: existing?.id ?? body.id ?? randomUUID(), key, name: body.name, description: body.description ?? null, states, transitions } });
  });

  // ---- labels ---------------------------------------------------------------
  app.get('/labels', async (request) => {
    const actor = actorOf(request);
    const projectId = await projectIdQuery(db, request);
    const labels = await db`
      select * from labels where deleted_at is null
        and (project_id is null or project_id in (select visible_project_ids(${actor.id})))
        and (${projectId}::uuid is null or project_id is null or project_id = ${projectId}::uuid)
      order by project_id nulls first, name`;
    return { labels };
  });

  app.post('/labels', async (request, reply) => {
    const body = parse(z.object({ id: zUuid.optional(), name: z.string().min(1), color: z.string().nullable().optional(), project_id: zUuid.nullable().optional(), project: z.string().nullable().optional() }), request.body);
    const project_id = body.project_id ?? (body.project ? await resolveProjectId(db, body.project) : null);
    const label = await app.mutateFor(request, { name: 'createLabel', args: { id: body.id ?? randomUUID(), project_id, name: body.name, color: body.color ?? null } });
    reply.code(201);
    return label;
  });

  // ---- users ----------------------------------------------------------------
  app.get('/users', async () => ({
    users: await db`select id, email, name, avatar_url, firm_role, is_active, is_service, created_at from users where deleted_at is null order by name`,
  }));

  app.patch('/users/:id', async (request) => {
    requireFirmAdmin(request);
    const id = paramsOf(request).id!;
    const body = parse(z.object({ firm_role: FirmRole.optional(), is_active: z.boolean().optional(), name: z.string().min(1).optional() }), request.body);
    const user = await withTxn(db, async (tx) => {
      const [before] = await tx`select * from users where id = ${id} and deleted_at is null`;
      if (!before) throw notFound('user not found');
      if (before.firm_role === 'owner' && body.firm_role && body.firm_role !== 'owner' && actorOf(request).firmRole !== 'owner') throw validation('only an owner can demote an owner');
      const updates: Record<string, unknown> = {};
      for (const k of ['firm_role', 'is_active', 'name'] as const) if (body[k] !== undefined) updates[k] = body[k];
      if (!Object.keys(updates).length) return before;
      const [after] = await tx`update users set ${tx(updates as any)} where id = ${id} returning *`;
      const meta = app.metaFor(request, 'updateUser');
      await writeEvents(tx, request.actor, meta, Object.keys(updates).map((k) => ({ entity_type: 'user', entity_id: id, action: 'update', field: k, old_value: before[k], new_value: after![k] })));
      if (updates.firm_role !== undefined || updates.is_active !== undefined) await tx`update sync_client_groups set resync_required = true where user_id = ${id}`;
      return after!;
    });
    return { user };
  });

  // ---- integrations ---------------------------------------------------------
  app.get('/integrations', async (request) => {
    const actor = actorOf(request);
    const rows = await db`select * from integration_configs order by kind`;
    const admin = actor.firmRole === 'owner' || actor.firmRole === 'admin';
    return { integrations: rows.map((r) => (admin ? r : { kind: r.kind, is_active: r.is_active, updated_at: r.updated_at })) };
  });

  app.put('/integrations/:kind', async (request) => {
    requireFirmAdmin(request);
    const kind = paramsOf(request).kind!;
    if (!['slack', 'github', 'email'].includes(kind)) throw validation('kind must be slack, github or email');
    const body = parse(z.object({ config: z.record(z.unknown()).optional(), is_active: z.boolean().optional() }), request.body);
    const [row] = await db`
      insert into integration_configs (kind, config, is_active, updated_by, updated_at)
      values (${kind}, ${db.json((body.config ?? {}) as any)}, ${body.is_active ?? false}, ${actorOf(request).id}, now())
      on conflict (kind) do update set config = coalesce(${body.config ? db.json(body.config as any) : null}, integration_configs.config),
        is_active = coalesce(${body.is_active ?? null}, integration_configs.is_active), updated_by = excluded.updated_by, updated_at = now()
      returning *`;
    if (app.refreshIntegrations) await app.refreshIntegrations();
    return row;
  });

  // ---- webhooks -------------------------------------------------------------
  const WebhookBody = z.object({
    name: z.string().min(1), url: z.string().url(), event_kinds: z.array(z.string()).min(1).optional(), secret: z.string().min(8).optional(),
    project_id: zUuid.nullable().optional(), project: z.string().nullable().optional(), is_active: z.boolean().optional(),
  });
  const checkKinds = (kinds: string[]) => {
    const bad = kinds.filter((k) => k !== '*' && !(EVENT_KINDS as readonly string[]).includes(k) && !/^project\.\*$/.test(k));
    if (bad.length) throw validation(`unknown event kinds: ${bad.join(', ')}`, { allowed: ['*', ...EVENT_KINDS] });
  };

  app.get('/webhooks', async (request) => {
    requireFirmAdmin(request);
    return { webhooks: await db`select * from webhook_endpoints where deleted_at is null order by created_at` };
  });

  app.post('/webhooks', async (request, reply) => {
    requireFirmAdmin(request);
    const body = parse(WebhookBody, request.body);
    const kinds = body.event_kinds ?? ['*'];
    checkKinds(kinds);
    const project_id = body.project_id ?? (body.project ? await resolveProjectId(db, body.project) : null);
    const [row] = await db`
      insert into webhook_endpoints (name, url, secret, event_kinds, project_id, is_active, created_by)
      values (${body.name}, ${body.url}, ${body.secret ?? randomBytes(32).toString('hex')}, ${kinds}, ${project_id}, ${body.is_active ?? true}, ${actorOf(request).id})
      returning *`;
    reply.code(201);
    return row;
  });

  app.patch('/webhooks/:id', async (request) => {
    requireFirmAdmin(request);
    const body = parse(WebhookBody.partial(), request.body);
    if (body.event_kinds) checkKinds(body.event_kinds);
    const updates: Record<string, unknown> = {};
    for (const k of ['name', 'url', 'event_kinds', 'secret', 'is_active'] as const) if (body[k] !== undefined) updates[k] = body[k];
    if (body.project_id !== undefined) updates.project_id = body.project_id;
    else if (body.project !== undefined) updates.project_id = body.project ? await resolveProjectId(db, body.project) : null;
    if (!Object.keys(updates).length) throw validation('nothing to update');
    updates.updated_at = new Date().toISOString();
    const [row] = await db`update webhook_endpoints set ${db(updates as any)} where id = ${paramsOf(request).id!} and deleted_at is null returning *`;
    if (!row) throw notFound('webhook not found');
    return row;
  });

  app.delete('/webhooks/:id', async (request) => {
    requireFirmAdmin(request);
    const rows = await db`update webhook_endpoints set deleted_at = now(), is_active = false where id = ${paramsOf(request).id!} and deleted_at is null returning id`;
    if (!rows.length) throw notFound('webhook not found');
    return { ok: true };
  });

  app.get('/webhooks/:id/deliveries', async (request) => {
    requireFirmAdmin(request);
    const limit = intQuery(queryOf(request).limit, 50, 500);
    const deliveries = await db`
      select id, endpoint_id, event_id, event_kind, status, attempts, next_attempt_at, last_attempt_at, response_status, left(response_body, 2000) as response_body, created_at, payload
      from webhook_deliveries where endpoint_id = ${paramsOf(request).id!} order by id desc limit ${limit}`;
    return { deliveries };
  });

  app.post('/webhooks/:id/test', async (request) => {
    requireFirmAdmin(request);
    const [ep] = await db`select * from webhook_endpoints where id = ${paramsOf(request).id!} and deleted_at is null`;
    if (!ep) throw notFound('webhook not found');
    const actor = request.user!;
    const payload = { id: randomUUID(), kind: 'ping', created_at: new Date().toISOString(), actor: { id: actor.id, name: actor.name, kind: 'user' }, project: null, item: null, changes: [], event_ids: [] };
    const res = await sendWebhook(ep, 'ping', payload, `test-${payload.id}`);
    return { ok: res.ok, status: res.status, body: res.body?.slice(0, 1000) ?? null, error: res.error ?? null };
  });
}
