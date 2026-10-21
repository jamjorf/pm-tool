import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentVersion, type Q } from '../db.js';

/** In-process poke bus (single region, single process). */
export class PokeBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(10_000);
  }
  poke(version: number) {
    this.emit('poke', version);
  }
}

export const pokeBus = new PokeBus();

/** Emit a poke after a committed write with the latest global version (sync_state.version). */
export async function pokeAfterCommit(q: Q) {
  let version = 0;
  try {
    version = await currentVersion(q);
  } catch {
    /* ignore */
  }
  pokeBus.poke(version);
}

const HEARTBEAT_MS = 25_000;

/** GET /sync/poke — Server-Sent Events: `event: poke` + `data: {"version":N}` after every committed write. */
export function registerPokeRoute(app: FastifyInstance, path = '/sync/poke') {
  app.get(path, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.actor) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
      return reply;
    }
    reply.hijack();
    const res = reply.raw;
    const origin = request.headers.origin;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } : {}),
    });
    res.write(': connected\n\n');
    const onPoke = (version: number) => {
      res.write(`event: poke\ndata: ${JSON.stringify({ version })}\n\n`);
    };
    pokeBus.on('poke', onPoke);
    const hb = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(hb);
      pokeBus.off('poke', onPoke);
    };
    request.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    return reply;
  });
}
