import type { FastifyRequest } from 'fastify';
import type { Actor } from '@pm/core';
import { z } from 'zod';
import { isUuid, type Q } from '../db.js';
import { unauthorized, validation } from '../errors.js';
import { resolveItemId, resolveProjectId } from '../mutations/helpers.js';

export const actorOf = (request: FastifyRequest): Actor => {
  if (!request.actor) throw unauthorized();
  return request.actor;
};

export const queryOf = (request: FastifyRequest): Record<string, string | undefined> => (request.query ?? {}) as Record<string, string | undefined>;
export const paramsOf = (request: FastifyRequest): Record<string, string> => (request.params ?? {}) as Record<string, string>;

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw validation('invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export function intQuery(v: string | undefined, def: number, max = 500): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw validation(`invalid number "${v}"`);
  return Math.min(Math.floor(n), max);
}

export const flag = (v: string | undefined) => v !== undefined && v !== '' && !['0', 'false', 'no'].includes(v.toLowerCase());

export const csv = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export async function itemIdParam(q: Q, request: FastifyRequest, name = 'key', opts: { includeDeleted?: boolean } = {}): Promise<string> {
  return resolveItemId(q, paramsOf(request)[name]!, opts);
}

export async function projectIdParam(q: Q, request: FastifyRequest, name = 'key'): Promise<string> {
  return resolveProjectId(q, paramsOf(request)[name]!);
}

/** Resolve an optional project reference (key or uuid) from the query string. */
export async function projectIdQuery(q: Q, request: FastifyRequest, name = 'project'): Promise<string | null> {
  const v = queryOf(request)[name];
  return v ? resolveProjectId(q, v) : null;
}

export const uuidOrNull = (v: unknown) => (isUuid(v) ? v : null);

export const zUuid = z.string().uuid();
export const zKeys = z.object({ ids: z.array(zUuid).optional(), keys: z.array(z.string()).optional() });

/** Resolve a {ids|keys} body to item ids. */
export async function resolveIds(q: Q, body: { ids?: string[]; keys?: string[] }): Promise<string[]> {
  const out: string[] = [...(body.ids ?? [])];
  for (const k of body.keys ?? []) out.push(await resolveItemId(q, k));
  if (!out.length) throw validation('ids or keys required');
  return [...new Set(out)];
}
