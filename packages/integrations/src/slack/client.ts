import type { IntegrationDeps } from '../deps.js';

export interface SlackMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  /** Reply in a thread */
  thread_ts?: string;
  unfurl_links?: boolean;
}

/** Bot token from env (`SLACK_BOT_TOKEN`) or the admin-edited integration config (`bot_token`). */
export async function slackBotToken(deps: IntegrationDeps): Promise<string | undefined> {
  if (deps.config.slackBotToken) return deps.config.slackBotToken;
  const cfg = await deps.getIntegrationConfig('slack').catch(() => null);
  const t = cfg?.config?.bot_token;
  return typeof t === 'string' && t ? t : undefined;
}

/** Call a Slack Web API method with the bot token. Returns null (and logs) when no token is configured. */
export async function slackApi(deps: IntegrationDeps, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const token = await slackBotToken(deps);
  if (!token) {
    deps.log.info({ method, payload }, 'slack: no bot token configured; skipping API call (dev mode)');
    return null;
  }
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.ok === false) deps.log.warn({ method, status: res.status, error: json.error }, 'slack: API call failed');
    return json;
  } catch (err) {
    deps.log.error({ method, err: err instanceof Error ? err.message : String(err) }, 'slack: API call threw');
    return null;
  }
}

/** Post a message to a channel (or thread). No-op + log when the bot token is unset. */
export async function sendSlackMessage(deps: IntegrationDeps, msg: SlackMessage): Promise<void> {
  const payload: Record<string, unknown> = { channel: msg.channel, text: msg.text };
  if (msg.blocks) payload.blocks = msg.blocks;
  if (msg.thread_ts) payload.thread_ts = msg.thread_ts;
  if (msg.unfurl_links !== undefined) payload.unfurl_links = msg.unfurl_links;
  await slackApi(deps, 'chat.postMessage', payload);
}
