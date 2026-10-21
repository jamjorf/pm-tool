import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { parseMutation, type Actor, type Mutation } from '@pm/core';
import { loadConfig, type Config } from './config.js';
import { createDb, withTxn, type Sql } from './db.js';
import { ApiError, toApiError } from './errors.js';
import { authPlugin } from './auth/plugin.js';
import { applyMutation, type MutationMeta } from './mutations/index.js';
import { pokeAfterCommit } from './sync/poke.js';
import { buildIntegrationDeps, loadIntegrationsModule } from './integrations.js';
import type { MutateOptions } from './types.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { syncRoutes } from './routes/sync.js';
import { itemRoutes } from './routes/items.js';
import { projectRoutes } from './routes/projects.js';
import { commentRoutes } from './routes/comments.js';
import { viewRoutes } from './routes/views.js';
import { adminRoutes } from './routes/admin.js';
import { notificationRoutes } from './routes/notifications.js';
import { activityRoutes } from './routes/activity.js';
import { searchRoutes } from './routes/search.js';
import { exportRoutes } from './routes/export.js';
import './types.js';

export interface BuildAppOptions {
  config?: Partial<Config>;
  db?: Sql;
  logger?: boolean | object;
  /** Mount /integrations/* from @pm/integrations (default true; skipped when the package is not built). */
  integrations?: boolean;
}

const SOURCES = new Set(['app', 'api', 'mcp']);

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...opts.config } as Config;
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });
  app.decorate('db', db);
  app.decorate('config', config);

  // Empty JSON bodies (e.g. POST /watch with content-type json) are {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  await app.register(cookie, { secret: config.APP_SECRET });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origin === config.APP_URL || origin === config.API_URL || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-PM-Source', 'X-Requested-With'],
  });

  app.setErrorHandler((err, request, reply) => {
    const e = toApiError(err);
    if (e.status >= 500) request.log.error({ err }, 'request failed');
    else if (e.status !== 404 && e.status !== 401) request.log.info({ code: e.code, message: e.message }, 'request rejected');
    reply.code(e.status).send(e.toBody());
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(new ApiError(404, 'not_found', 'route not found').toBody());
  });

  // ---- mutation helpers -----------------------------------------------------
  app.decorate('metaFor', (request: FastifyRequest, mutationName: string, o: MutateOptions = {}): MutationMeta => {
    const header = request.headers['x-pm-source'];
    const hinted = typeof header === 'string' && SOURCES.has(header) ? header : null;
    const source = o.source ?? hinted ?? (request.authKind === 'api_key' ? 'api' : 'app');
    const actorKind = o.actorKind ?? (source === 'mcp' ? 'agent' : request.authKind === 'api_key' ? 'api_key' : 'user');
    return { source, txnId: o.txnId ?? randomUUID(), mutationName, actorKind, actorLabel: o.actorLabel ?? request.apiKeyName ?? null, force: o.force };
  });
  app.decorate('mutate', async (actor: Actor, mutation: Mutation, meta: MutationMeta) => {
    const result = await withTxn(db, (tx) => applyMutation(tx, actor, mutation, meta));
    await pokeAfterCommit(db);
    return result;
  });
  app.decorate('mutateFor', async (request: FastifyRequest, mutation: Mutation, o: MutateOptions = {}) => {
    if (!request.actor) throw new ApiError(401, 'unauthorized', 'authentication required');
    const parsed = parseMutation(mutation.name, mutation.args);
    return app.mutate(request.actor, parsed, app.metaFor(request, parsed.name, o));
  });

  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(syncRoutes);
  for (const r of [itemRoutes, projectRoutes, commentRoutes, viewRoutes, adminRoutes, notificationRoutes, activityRoutes, searchRoutes, exportRoutes]) {
    await app.register(r, { prefix: '/api/v1' });
  }

  // ---- integrations (optional) ----------------------------------------------
  const deps = buildIntegrationDeps(app);
  app.decorate('integrations', null);
  if (opts.integrations !== false) {
    const mod = await loadIntegrationsModule(app);
    if (mod) {
      try {
        await mod.registerIntegrationRoutes(app, deps);
        app.integrations = mod;
      } catch (e) {
        app.log.warn({ err: e }, 'registerIntegrationRoutes failed; /integrations/* disabled');
      }
    }
  }

  app.addHook('onClose', async () => {
    if (!opts.db) await db.end({ timeout: 5 });
  });
  return app;
}
