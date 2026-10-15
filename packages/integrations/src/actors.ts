import type { Actor } from '@pm/core';
import type { IntegrationDeps } from './deps.js';

export interface ResolvedActor {
  actor: Actor;
  /** Display label stored in activity_events.actor_label */
  label: string;
  /** Resolved pm-tool user, when the external identity could be mapped. */
  user: { id: string; name: string; email: string } | null;
}

export async function actorForSlackUser(deps: IntegrationDeps, slackUserId: string | undefined): Promise<ResolvedActor> {
  if (slackUserId) {
    const user = await deps.resolveUserBySlackId(slackUserId).catch(() => null);
    if (user) return { actor: await deps.actorForUser(user.id), label: user.name, user };
  }
  return { actor: await deps.systemActor('slack'), label: slackUserId ? `slack:${slackUserId}` : 'slack', user: null };
}

export async function actorForEmail(deps: IntegrationDeps, source: 'github' | 'email', email: string | null | undefined, fallbackLabel?: string): Promise<ResolvedActor> {
  if (email) {
    const user = await deps.resolveUserByEmail(email).catch(() => null);
    if (user) return { actor: await deps.actorForUser(user.id), label: user.name, user };
  }
  return { actor: await deps.systemActor(source), label: fallbackLabel ?? (email ? `${source}:${email}` : source), user: null };
}
