// ============================================================================
// POST /integrations/slack/commands  (slash command `/pm`)
//   /pm KEY-12               -> ephemeral item card with buttons
//   /pm find <text>          -> cards for any keys in <text>, else a link to the web search
//   /pm create PROJECT title -> creates an item as the Slack user (or the system actor)
//   /pm mine                 -> link to "my work"
//   /pm help
// Body is application/x-www-form-urlencoded (parsed to an object by the route).
// ============================================================================
import type { IntegrationDeps, ItemSummary } from '../deps.js';
import { actorForSlackUser } from '../actors.js';
import { extractKeys, isItemKey } from '../keys.js';
import { itemCard, itemPlainText, mrkdwnEscape } from './blocks.js';
import { createItemInProject, type HandlerResponse } from './events.js';

export interface SlashCommandBody {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  response_url?: string;
  trigger_id?: string;
}

function ephemeral(text: string, blocks?: unknown[]): HandlerResponse {
  return { status: 200, body: { response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) } };
}

const HELP = [
  '*`/pm` commands*',
  '• `/pm KEY-12` — show an item',
  '• `/pm find <text>` — search items',
  '• `/pm create PROJECT title of the item` — create an item',
  '• `/pm mine` — your assigned work',
].join('\n');

export async function handleSlackCommand(deps: IntegrationDeps, body: SlashCommandBody): Promise<HandlerResponse> {
  const text = (body.text ?? '').trim();
  const [first = '', ...rest] = text.split(/\s+/);
  const sub = first.toLowerCase();
  const appUrl = deps.config.appUrl.replace(/\/$/, '');

  if (!text || sub === 'help') return ephemeral(HELP);

  if (sub === 'mine') return ephemeral(`Your work: <${appUrl}/|open my work>`);

  if (sub === 'find') {
    const q = rest.join(' ').trim();
    if (!q) return ephemeral('Usage: `/pm find <text>`');
    const items = await findByKeys(deps, extractKeys(q));
    if (items.length) return ephemeral(items.map(itemPlainText).join('\n'), items.flatMap((i) => itemCard(i)));
    return ephemeral(`No item keys in "${mrkdwnEscape(q)}". Search the app: <${appUrl}/search?q=${encodeURIComponent(q)}|search for "${mrkdwnEscape(q)}">`);
  }

  if (sub === 'create') {
    const projectKey = (rest[0] ?? '').toUpperCase();
    const title = rest.slice(1).join(' ').trim();
    if (!projectKey || !title) return ephemeral('Usage: `/pm create PROJECT title of the item`');
    const who = await actorForSlackUser(deps, body.user_id);
    const created = await createItemInProject(deps, who, projectKey, title, undefined);
    if (!created.ok) return ephemeral(`Could not create item: ${mrkdwnEscape(created.error)}`);
    const asWhom = who.user ? '' : ' (as the pm-tool Slack service user — link your Slack id in Settings to create as yourself)';
    return { status: 200, body: { response_type: 'in_channel', text: `Created <${created.url}|${created.key}>: ${mrkdwnEscape(title)}${asWhom}` } };
  }

  if (isItemKey(first)) {
    const item = await deps.findItemByKey(first.toUpperCase());
    if (!item) return ephemeral(`No item ${first.toUpperCase()}.`);
    return ephemeral(itemPlainText(item), itemCard(item, { description: true }));
  }

  // Free text: treat as find
  const items = await findByKeys(deps, extractKeys(text));
  if (items.length) return ephemeral(items.map(itemPlainText).join('\n'), items.flatMap((i) => itemCard(i)));
  return ephemeral(`Unknown command. ${HELP}`);
}

async function findByKeys(deps: IntegrationDeps, keys: string[]): Promise<ItemSummary[]> {
  const out: ItemSummary[] = [];
  for (const key of keys.slice(0, 5)) {
    const item = await deps.findItemByKey(key);
    if (item) out.push(item);
  }
  return out;
}
