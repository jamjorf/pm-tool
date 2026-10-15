import type { Actor, Mutation } from '@pm/core';
import type { FastifyRequest } from 'fastify';
import type { Sql } from './db.js';
import type { Config } from './config.js';
import type { MutationMeta } from './activity.js';

export interface MutateOptions {
  source?: string;
  actorKind?: MutationMeta['actorKind'];
  actorLabel?: string | null;
  force?: boolean;
  txnId?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Sql;
    config: Config;
    /** Run one mutation in its own locked transaction, then poke sync clients. */
    mutate(actor: Actor, mutation: Mutation, meta: MutationMeta): Promise<unknown>;
    /** Convenience: mutate on behalf of the request's actor with meta derived from the request. */
    mutateFor(request: FastifyRequest, mutation: Mutation, opts?: MutateOptions): Promise<unknown>;
    /** Build mutation meta from a request (source/actorKind/actorLabel). */
    metaFor(request: FastifyRequest, mutationName: string, opts?: MutateOptions): MutationMeta;
  }
}
