import type { FastifyInstance } from 'fastify';
import { PullRequest, PushRequest } from '@pm/core';
import { requireAuth } from '../auth/plugin.js';
import { registerPokeRoute } from '../sync/poke.js';
import { handlePull } from '../sync/pull.js';
import { handlePush } from '../sync/push.js';
import { parse } from './util.js';

export async function syncRoutes(app: FastifyInstance) {
  app.post('/sync/push', { preHandler: requireAuth }, async (request) => handlePush(app, request, parse(PushRequest, request.body)));
  app.post('/sync/pull', { preHandler: requireAuth }, async (request) => handlePull(app, request, parse(PullRequest, request.body)));
  registerPokeRoute(app, '/sync/poke');
}
