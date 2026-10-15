import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/plugin.js';
import { parse, paramsOf } from './util.js';

export async function commentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.patch('/comments/:id', async (request) => {
    const body = parse(z.object({ body: z.string().min(1) }), request.body);
    return app.mutateFor(request, { name: 'editComment', args: { id: paramsOf(request).id!, body: body.body } });
  });

  app.delete('/comments/:id', async (request) => {
    await app.mutateFor(request, { name: 'deleteComment', args: { id: paramsOf(request).id! } });
    return { ok: true };
  });

  app.delete('/relations/:id', async (request) => {
    await app.mutateFor(request, { name: 'removeRelation', args: { id: paramsOf(request).id! } });
    return { ok: true };
  });
}
