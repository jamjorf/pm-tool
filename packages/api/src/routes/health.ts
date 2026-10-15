import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

const version: string = (() => {
  try {
    return createRequire(import.meta.url)('../../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    try {
      await app.db`select 1`;
      return { ok: true, version, db: true };
    } catch (e) {
      reply.code(503);
      return { ok: false, version, db: false, error: (e as Error).message };
    }
  });
}
