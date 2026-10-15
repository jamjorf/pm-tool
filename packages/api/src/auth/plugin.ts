import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import '../types.js';
import type { Actor } from '@pm/core';
import type { UserRow } from '../actor.js';
import { loadActor, loadUser } from '../actor.js';
import { forbidden, unauthorized } from '../errors.js';
import { resolveApiKey } from './apikeys.js';
import { resolveSession, SESSION_COOKIE } from './session.js';

export type AuthKind = 'session' | 'api_key';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    actor: Actor | null;
    authKind: AuthKind | null;
    apiKeyName: string | null;
    sessionToken: string | null;
  }
}

/** Decorates requests with user/actor (never fails; use requireAuth to enforce). */
export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('actor', null);
  app.decorateRequest('authKind', null);
  app.decorateRequest('apiKeyName', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (request) => {
    const sql = app.db;
    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const key = auth.slice(7).trim();
      const k = await resolveApiKey(sql, key);
      if (!k) throw unauthorized('invalid api key');
      const user = await loadUser(sql, k.user_id);
      if (!user || !user.is_active) throw unauthorized('user inactive');
      request.user = user;
      request.actor = await loadActor(sql, user.id, { scopes: k.scopes });
      request.authKind = 'api_key';
      request.apiKeyName = k.name;
      return;
    }
    const raw = request.cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const userId = await resolveSession(sql, unsigned.value);
        if (userId) {
          const user = await loadUser(sql, userId);
          if (user && user.is_active) {
            request.user = user;
            request.actor = await loadActor(sql, user.id);
            request.authKind = 'session';
            request.sessionToken = unsigned.value;
          }
        }
      }
    }
  });
}

/** preHandler: 401 without a principal; API keys need the `write` scope for non-GET routes. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.actor || !request.user) throw unauthorized('authentication required');
  if (request.authKind === 'api_key' && request.method !== 'GET' && request.method !== 'HEAD') {
    const scopes = request.actor.scopes ?? [];
    if (!scopes.includes('write')) throw forbidden('api key lacks the write scope');
  }
}

export function requireFirmAdmin(request: FastifyRequest) {
  const a = request.actor;
  if (!a) throw unauthorized();
  if (a.firmRole !== 'owner' && a.firmRole !== 'admin') throw forbidden('firm admin required');
}
