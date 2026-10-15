// ============================================================================
// POST /integrations/slack/events (Slack Events API)
//   url_verification  -> echo challenge
//   event_callback:
//     link_shared  -> chat.unfurl with an item card per pm-tool link
//     message      -> autolink: KEY-12 in a human message adds a links_to
//                     relation (external_kind 'slack_thread') on the item
//     app_mention  -> "@pm create PROJECT title" creates an item
// Idempotent via recordInbound('slack', event_id).
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { IntegrationDeps } from '../deps.js';
import { actorForSlackUser, type ResolvedActor } from '../actors.js';
import { extractKeys, keyFromUrl } from '../keys.js';
import { ensureLink, rowOf, tryMutation } from '../mutations.js';
import { truncate } from '../http.js';
import { itemCard } from './blocks.js';
import { sendSlackMessage, slackApi } from './client.js';

export interface HandlerResponse { status: number; body: unknown }

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: Record<string, unknown>;
}

export function slackPermalink(teamDomain: string | undefined, channel: string, ts: string, threadTs?: string): string {
  const base = teamDomain ? `https://${teamDomain}.slack.com` : 'https://slack.com';
  const p = `${base}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channel}` : p;
}

export async function handleSlackEvent(deps: IntegrationDeps, body: unknown): Promise<HandlerResponse> {
  const env = (body ?? {}) as SlackEventEnvelope;
  if (env.type === 'url_verification') return { status: 200, body: { challenge: env.challenge ?? '' } };
  if (env.type !== 'event_callback' || !env.event) return { status: 200, body: { ok: true, ignored: env.type ?? 'unknown' } };

  const eventId = env.event_id ?? `${env.team_id ?? 'team'}:${String(env.event.event_ts ?? env.event.ts ?? Date.now())}`;
  if (!(await deps.recordInbound('slack', eventId))) return { status: 200, body: { ok: true, duplicate: true } };

  const ev = env.event;
  const type = String(ev.type ?? '');
  try {
    switch (type) {
      case 'link_shared': return await onLinkShared(deps, ev);
      case 'message': return await onMessage(deps, ev);
      case 'app_mention': return await onAppMention(deps, ev);
      default: return { status: 200, body: { ok: true, ignored: type } };
    }
  } catch (err) {
    deps.log.error({ type, err: err instanceof Error ? err.message : String(err) }, 'slack: event handler failed');
    return { status: 200, body: { ok: false, error: 'handler_failed' } };
  }
}

async function onLinkShared(deps: IntegrationDeps, ev: Record<string, unknown>): Promise<HandlerResponse> {
  const links = Array.isArray(ev.links) ? (ev.links as Array<{ url?: string }>) : [];
  const unfurls: Record<string, unknown> = {};
  for (const l of links) {
    if (!l.url) continue;
    const key = keyFromUrl(l.url);
    if (!key) continue;
    const item = await deps.findItemByKey(key);
    if (!item) continue;
    unfurls[l.url] = { blocks: itemCard(item, { actions: true, description: true }) };
  }
  const keys = Object.keys(unfurls);
  if (keys.length && ev.channel && ev.message_ts) {
    await slackApi(deps, 'chat.unfurl', { channel: ev.channel, ts: ev.message_ts, unfurls });
  }
  return { status: 200, body: { ok: true, unfurled: keys.length } };
}

async function autolinkEnabled(deps: IntegrationDeps): Promise<boolean> {
  const cfg = await deps.getIntegrationConfig('slack').catch(() => null);
  if (!cfg) return true;              // no admin config yet: autolink on (dev-friendly default)
  if (cfg.is_active === false) return false;
  return cfg.config?.autolink !== false;
}

async function onMessage(deps: IntegrationDeps, ev: Record<string, unknown>): Promise<HandlerResponse> {
  // Only plain human messages: skip bots, edits, joins, our own unfurls, etc.
  if (ev.bot_id || ev.subtype) return { status: 200, body: { ok: true, ignored: 'bot_or_subtype' } };
  const text = typeof ev.text === 'string' ? ev.text : '';
  const keys = extractKeys(text);
  if (!keys.length) return { status: 200, body: { ok: true, linked: [] } };
  if (!(await autolinkEnabled(deps))) return { status: 200, body: { ok: true, ignored: 'autolink_disabled' } };

  const channel = String(ev.channel ?? '');
  const ts = String(ev.ts ?? '');
  const threadTs = typeof ev.thread_ts === 'string' ? ev.thread_ts : undefined;
  const url = slackPermalink(typeof ev.team_domain === 'string' ? ev.team_domain : undefined, channel, ts, threadTs);
  const who = await actorForSlackUser(deps, typeof ev.user === 'string' ? ev.user : undefined);

  const linked: string[] = [];
  for (const key of keys) {
    const item = await deps.findItemByKey(key);
    if (!item) continue;
    const ok = await ensureLink(deps, who, item.id, {
      kind: 'slack_thread',
      ref: { url, channel, ts, thread_ts: threadTs ?? ts, text: truncate(text, 500), user: ev.user ?? null },
    }, 'slack');
    if (ok) linked.push(key);
  }
  return { status: 200, body: { ok: true, linked } };
}

const CREATE_RE = /^\s*create\s+([A-Za-z][A-Za-z0-9]{1,9})\s+(.+)$/s;

async function onAppMention(deps: IntegrationDeps, ev: Record<string, unknown>): Promise<HandlerResponse> {
  const raw = typeof ev.text === 'string' ? ev.text : '';
  const text = raw.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ').trim();
  const channel = String(ev.channel ?? '');
  const threadTs = typeof ev.thread_ts === 'string' ? ev.thread_ts : (typeof ev.ts === 'string' ? ev.ts : undefined);
  const m = CREATE_RE.exec(text);
  if (!m) {
    await sendSlackMessage(deps, { channel, thread_ts: threadTs, text: 'Usage: `@pm create PROJECT Title of the item` or `/pm help`.' });
    return { status: 200, body: { ok: true, ignored: 'no_command' } };
  }
  const projectKey = m[1]!.toUpperCase();
  const title = m[2]!.trim();
  const who = await actorForSlackUser(deps, typeof ev.user === 'string' ? ev.user : undefined);
  const created = await createItemInProject(deps, who, projectKey, title, undefined);
  await sendSlackMessage(deps, { channel, thread_ts: threadTs, text: created.ok ? `Created <${created.url}|${created.key}>: ${title}` : `Could not create item: ${created.error}` });
  return { status: 200, body: created.ok ? { ok: true, created: created.key } : { ok: false, error: created.error } };
}

/** Shared by app_mention and `/pm create`. */
export async function createItemInProject(
  deps: IntegrationDeps,
  who: ResolvedActor,
  projectKey: string,
  title: string,
  description: string | undefined,
): Promise<{ ok: true; key: string; url: string } | { ok: false; error: string }> {
  const project = await deps.findProjectByKey(projectKey);
  if (!project) return { ok: false, error: `unknown project ${projectKey}` };
  if (!project.default_type_id) return { ok: false, error: `project ${projectKey} has no default item type` };
  const id = randomUUID();
  const r = await tryMutation(deps, who, {
    name: 'createItem',
    args: { id, project_id: project.id, type_id: project.default_type_id, title, ...(description ? { description } : {}) },
  }, 'slack');
  if (!r.ok) return { ok: false, error: r.error };
  const row = rowOf(r.result);
  const key = row.key;
  if (key) {
    const item = await deps.findItemByKey(key).catch(() => null);
    return { ok: true, key, url: item?.url ?? `${deps.config.appUrl}/items/${key}` };
  }
  return { ok: true, key: `${projectKey}-?`, url: `${deps.config.appUrl}/search?q=${encodeURIComponent(title)}` };
}
