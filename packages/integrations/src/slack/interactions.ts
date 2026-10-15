// ============================================================================
// POST /integrations/slack/interactions  (Block Kit interactivity)
//   block_actions with action_id:
//     transition:<itemKey>:<transitionKey> -> transitionItem
//     assign_me:<itemKey>                  -> updateItem { assignee_id: me }
//     open:<itemKey>                       -> url button, nothing to do
// The route answers 200 immediately; the outcome is posted to response_url.
// Body is form-encoded with a single `payload` JSON field.
// ============================================================================
import type { IntegrationDeps } from '../deps.js';
import { actorForSlackUser } from '../actors.js';
import { postJson } from '../http.js';
import { transitionMutation, tryMutation } from '../mutations.js';
import type { HandlerResponse } from './events.js';

interface BlockActionsPayload {
  type?: string;
  user?: { id?: string; username?: string; name?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

export function parseInteractionPayload(body: unknown): BlockActionsPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.payload === 'string') {
    try { return JSON.parse(b.payload) as BlockActionsPayload; } catch { return null; }
  }
  if (b.type) return b as BlockActionsPayload;
  return null;
}

/** Returns the message posted back to Slack (also delivered via response_url when present). */
export async function handleSlackInteraction(deps: IntegrationDeps, body: unknown): Promise<HandlerResponse & { message?: string }> {
  const payload = parseInteractionPayload(body);
  if (!payload || payload.type !== 'block_actions') return { status: 200, body: '' };

  const messages: string[] = [];
  for (const action of payload.actions ?? []) {
    const id = action.action_id ?? '';
    const [verb, itemKey, arg] = id.split(':');
    if (!verb || !itemKey || verb === 'open') continue;
    const item = await deps.findItemByKey(itemKey.toUpperCase());
    if (!item) { messages.push(`No item ${itemKey}.`); continue; }
    const who = await actorForSlackUser(deps, payload.user?.id);

    if (verb === 'transition' && arg) {
      const r = await tryMutation(deps, who, transitionMutation(item.id, arg), 'slack');
      messages.push(r.ok ? `${item.key} → ran transition "${arg}".` : `Could not run "${arg}" on ${item.key}: ${r.error}`);
    } else if (verb === 'assign_me') {
      if (!who.user) { messages.push(`Can't assign ${item.key}: your Slack account isn't linked to a pm-tool user (set it in Settings).`); continue; }
      const r = await tryMutation(deps, who, { name: 'updateItem', args: { id: item.id, patch: { assignee_id: who.user.id } } }, 'slack');
      messages.push(r.ok ? `${item.key} assigned to you.` : `Could not assign ${item.key}: ${r.error}`);
    } else {
      messages.push(`Unknown action "${verb}".`);
    }
  }

  const message = messages.join('\n');
  if (message && payload.response_url) {
    await postJson(payload.response_url, { response_type: 'ephemeral', replace_original: false, text: message })
      .catch((err) => deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'slack: response_url post failed'));
  }
  return { status: 200, body: '', message };
}
