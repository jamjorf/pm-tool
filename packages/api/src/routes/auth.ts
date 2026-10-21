import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createApiKey } from '../auth/apikeys.js';
import { consumeMagicToken, issueMagicToken } from '../auth/magic.js';
import { requireAuth } from '../auth/plugin.js';
import { createSession, destroySession, SESSION_COOKIE } from '../auth/session.js';
import { findOrCreateUser } from '../auth/users.js';
import { forbidden, notFound } from '../errors.js';
import { parse, paramsOf, queryOf } from './util.js';
import { withTxn } from '../db.js';
import { writeEvents } from '../activity.js';

export async function authRoutes(app: FastifyInstance) {
  const cookieOpts = () => ({
    path: '/', httpOnly: true, sameSite: 'lax' as const, signed: true,
    secure: app.config.APP_URL.startsWith('https://'), maxAge: app.config.SESSION_TTL_DAYS * 86_400,
  });

  async function startSession(reply: import('fastify').FastifyReply, userId: string) {
    const { token } = await createSession(app.db, userId, app.config.SESSION_TTL_DAYS);
    reply.setCookie(SESSION_COOKIE, token, cookieOpts());
  }

  app.post('/auth/dev-login', async (request, reply) => {
    if (app.config.AUTH_MODE !== 'dev') throw forbidden('dev-login is disabled (AUTH_MODE != dev)');
    const body = parse(z.object({ email: z.string().email(), name: z.string().min(1).optional() }), request.body);
    const user = await findOrCreateUser(app.db, body.email, body.name);
    if (!user.is_active) throw forbidden('user is inactive');
    await startSession(reply, user.id);
    return { user };
  });

  app.post('/auth/magic-link', async (request) => {
    const body = parse(z.object({ email: z.string().email() }), request.body);
    const token = issueMagicToken(body.email.toLowerCase());
    const link = `${app.config.API_URL}/auth/callback?token=${token}`;
    request.log.info({ email: body.email, link }, 'magic link issued');
    if (!app.config.SMTP_URL) app.log.info(`[auth] magic link for ${body.email}: ${link}`);
    return app.config.AUTH_MODE === 'dev' ? { ok: true, link } : { ok: true };
  });

  app.get('/auth/callback', async (request, reply) => {
    const token = queryOf(request).token ?? '';
    const email = consumeMagicToken(token);
    if (!email) throw notFound('invalid or expired token');
    const user = await findOrCreateUser(app.db, email);
    if (!user.is_active) throw forbidden('user is inactive');
    await startSession(reply, user.id);
    return reply.redirect(app.config.APP_URL, 302);
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.sessionToken) await destroySession(app.db, request.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const memberships = await app.db`select project_id, role from project_members where user_id = ${user.id} and deleted_at is null`;
    const preferences = await app.db`select * from notification_preferences where user_id = ${user.id} and deleted_at is null order by channel`;
    return { user, memberships, preferences, auth: request.authKind };
  });

  app.patch('/me', { preHandler: requireAuth }, async (request) => {
    const body = parse(z.object({ name: z.string().min(1).optional(), avatar_url: z.string().nullable().optional(), settings: z.record(z.unknown()).optional() }), request.body);
    const user = request.user!;
    const updated = await withTxn(app.db, async (tx) => {
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.avatar_url !== undefined) updates.avatar_url = body.avatar_url;
      if (body.settings !== undefined) updates.settings = tx.json({ ...user.settings, ...body.settings } as any);
      if (!Object.keys(updates).length) return user;
      const [u] = await tx`update users set ${tx(updates as any)} where id = ${user.id} returning *`;
      await writeEvents(tx, request.actor, app.metaFor(request, 'updateUser'), [{ entity_type: 'user', entity_id: user.id, action: 'update', field: null, new_value: Object.keys(updates) }]);
      return u!;
    });
    return { user: updated };
  });

  app.get('/me/api-keys', { preHandler: requireAuth }, async (request) => {
    const keys = await app.db`
      select id, name, key_prefix, scopes, expires_at, last_used_at, created_at from api_keys
      where user_id = ${request.user!.id} and revoked_at is null order by created_at desc`;
    return { keys };
  });

  app.post('/me/api-keys', { preHandler: requireAuth }, async (request, reply) => {
    const body = parse(z.object({ name: z.string().min(1), scopes: z.array(z.enum(['read', 'write'])).min(1).optional(), expires_at: z.string().nullable().optional() }), request.body);
    const row = await createApiKey(app.db, request.user!.id, body.name, body.scopes ?? ['read', 'write'], body.expires_at ?? null);
    reply.code(201);
    return { id: row.id, key: row.key, name: row.name, key_prefix: row.key_prefix, scopes: row.scopes, created_at: row.created_at };
  });

  app.delete('/me/api-keys/:id', { preHandler: requireAuth }, async (request) => {
    const id = paramsOf(request).id!;
    const rows = await app.db`delete from api_keys where id = ${id} and user_id = ${request.user!.id} returning id`;
    if (!rows.length) throw notFound('api key not found');
    return { ok: true };
  });

  void randomUUID;
}
