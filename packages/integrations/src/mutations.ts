// ============================================================================
// Helpers that build mutations from the shared vocabulary (@pm/core) for the
// integration handlers, plus a tolerant wrapper around deps.runMutation.
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { Mutation } from '@pm/core';
import type { IntegrationDeps } from './deps.js';
import type { ResolvedActor } from './actors.js';

export type IntegrationSource = 'slack' | 'github' | 'email';

export interface ExternalLink {
  /** `slack_thread` | `github_pr` | `github_issue` | `github_commit` | ... */
  kind: string;
  ref: Record<string, unknown>;
}

export function linkMutation(itemId: string, link: ExternalLink): Mutation {
  return {
    name: 'addRelation',
    args: { id: randomUUID(), type: 'links_to', from_item_id: itemId, to_item_id: null, external_kind: link.kind, external_ref: link.ref },
  };
}

/**
 * Comment created by an integration. The core `addComment` args do not carry
 * `source`/`external_ref`; the API derives `comments.source` from `meta.source`
 * and may read the extra `external_ref`/`source` keys we attach here (zod
 * strips them otherwise, so this is forward compatible).
 */
export function commentMutation(itemId: string, body: string, source: IntegrationSource, externalRef?: Record<string, unknown>): Mutation {
  const args: Record<string, unknown> = { id: randomUUID(), item_id: itemId, body, source };
  if (externalRef) args.external_ref = externalRef;
  return { name: 'addComment', args } as unknown as Mutation;
}

export function transitionMutation(itemId: string, transitionKey: string, comment?: string): Mutation {
  return { name: 'transitionItem', args: { id: itemId, transition_key: transitionKey, ...(comment ? { comment } : {}) } };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function isDuplicateError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return /duplicate|already exists|already linked|unique|conflict/.test(msg);
}

/** Run a mutation, returning `{ ok, result | error }` instead of throwing. */
export async function tryMutation(
  deps: IntegrationDeps,
  who: ResolvedActor,
  mutation: Mutation,
  source: IntegrationSource,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; duplicate: boolean }> {
  try {
    const result = await deps.runMutation(who.actor, mutation, { source, actorLabel: who.label });
    return { ok: true, result };
  } catch (err) {
    const duplicate = isDuplicateError(err);
    const error = errorMessage(err);
    deps.log[duplicate ? 'info' : 'warn']({ mutation: mutation.name, source, error }, duplicate ? 'integration mutation skipped (duplicate)' : 'integration mutation failed');
    return { ok: false, error, duplicate };
  }
}

/** Ensure an external `links_to` relation exists; duplicate errors are treated as success. */
export async function ensureLink(deps: IntegrationDeps, who: ResolvedActor, itemId: string, link: ExternalLink, source: IntegrationSource): Promise<boolean> {
  const r = await tryMutation(deps, who, linkMutation(itemId, link), source);
  return r.ok || r.duplicate;
}

/** Pull the created row's key/id out of a runMutation result, when the API returns the row. */
export function rowOf(result: unknown): { id?: string; key?: string } {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const nested = (r.item ?? r.row ?? r) as Record<string, unknown>;
    return { id: typeof nested.id === 'string' ? nested.id : undefined, key: typeof nested.key === 'string' ? nested.key : undefined };
  }
  return {};
}
