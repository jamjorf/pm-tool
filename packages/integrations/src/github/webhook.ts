// ============================================================================
// POST /integrations/github/webhook
//   pull_request (opened/edited/closed/reopened/ready_for_review), issues, push
//   * keys from PR/issue title + body, head branch name, commit messages
//   * ensure links_to relation (github_pr / github_issue / github_commit)
//   * comment (source 'github') when a PR/issue is opened or a PR is merged
//   * merged PR whose title/body says "Fixes KEY-12" -> transition `complete`
// Idempotent via recordInbound('github', X-GitHub-Delivery).
// ============================================================================
import type { IntegrationDeps } from '../deps.js';
import { actorForEmail, type ResolvedActor } from '../actors.js';
import { extractKeys, extractKeysFromBranch } from '../keys.js';
import { commentMutation, ensureLink, transitionMutation, tryMutation } from '../mutations.js';
import { truncate } from '../http.js';

export interface GithubWebhookInput {
  /** X-GitHub-Event */
  event: string;
  /** X-GitHub-Delivery */
  deliveryId: string;
  payload: Record<string, unknown>;
}

export interface GithubWebhookResult {
  status: number;
  body: { ok: boolean; event: string; duplicate?: boolean; linked?: string[]; commented?: string[]; completed?: string[]; ignored?: string; errors?: string[] };
}

export const CLOSING_KEYWORD_RE = /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*:?\s+([A-Z][A-Z0-9]{1,9}-\d+)\b/gi;

/** Item keys referenced with a closing keyword ("Fixes RATES-12"), uppercased, de-duplicated. */
export function extractClosingKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(CLOSING_KEYWORD_RE)) out.add(m[2]!.toUpperCase());
  return [...out];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const PR_ACTIONS = new Set(['opened', 'edited', 'closed', 'reopened', 'ready_for_review']);
const ISSUE_ACTIONS = new Set(['opened', 'edited', 'closed', 'reopened']);

async function senderActor(deps: IntegrationDeps, payload: Obj): Promise<ResolvedActor> {
  const sender = obj(payload.sender);
  const pusher = obj(payload.pusher);
  const headAuthor = obj(obj(payload.head_commit).author);
  const login = str(sender.login);
  const candidates = [str(sender.email), str(pusher.email), str(headAuthor.email), login ? `${login}@users.noreply.github.com` : ''].filter(Boolean);
  for (const email of candidates) {
    const who = await actorForEmail(deps, 'github', email, login ? `github:${login}` : 'github');
    if (who.user) return who;
  }
  return actorForEmail(deps, 'github', null, login ? `github:${login}` : 'github');
}

export async function handleGithubWebhook(deps: IntegrationDeps, input: GithubWebhookInput): Promise<GithubWebhookResult> {
  const { event, payload } = input;
  const deliveryId = input.deliveryId || `${event}:${str(payload.action)}:${str(obj(payload.repository).full_name)}:${str(payload.after ?? obj(payload.pull_request).id ?? obj(payload.issue).id)}`;
  if (event === 'ping') return { status: 200, body: { ok: true, event, ignored: 'ping' } };
  if (!(await deps.recordInbound('github', deliveryId))) return { status: 200, body: { ok: true, event, duplicate: true } };

  try {
    if (event === 'pull_request') return await onPullRequest(deps, payload);
    if (event === 'issues') return await onIssue(deps, payload);
    if (event === 'push') return await onPush(deps, payload);
    return { status: 200, body: { ok: true, event, ignored: 'unhandled_event' } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error({ event, err: message }, 'github: webhook handler failed');
    return { status: 200, body: { ok: false, event, errors: [message] } };
  }
}

async function onPullRequest(deps: IntegrationDeps, payload: Obj): Promise<GithubWebhookResult> {
  const action = str(payload.action);
  if (!PR_ACTIONS.has(action)) return { status: 200, body: { ok: true, event: 'pull_request', ignored: `action:${action}` } };
  const pr = obj(payload.pull_request);
  const repo = str(obj(payload.repository).full_name);
  const number = Number(pr.number);
  const title = str(pr.title);
  const body = str(pr.body);
  const branch = str(obj(pr.head).ref);
  const merged = pr.merged === true;
  const state = merged ? 'merged' : str(pr.state) || (action === 'closed' ? 'closed' : 'open');
  const author = str(obj(pr.user).login);
  const url = str(pr.html_url);

  const keys = [...new Set([...extractKeys(title), ...extractKeys(body), ...extractKeysFromBranch(branch)])];
  const who = await senderActor(deps, payload);
  const result: GithubWebhookResult['body'] = { ok: true, event: 'pull_request', linked: [], commented: [], completed: [], errors: [] };

  const isOpenEvent = action === 'opened' || action === 'reopened' || action === 'ready_for_review';
  const isMergeEvent = action === 'closed' && merged;
  const closingKeys = isMergeEvent ? new Set([...extractClosingKeys(title), ...extractClosingKeys(body)]) : new Set<string>();

  for (const key of keys) {
    const item = await deps.findItemByKey(key);
    if (!item) continue;
    const linked = await ensureLink(deps, who, item.id, {
      kind: 'github_pr',
      ref: { url, repo, number, title, state, author, branch, draft: pr.draft === true, merged },
    }, 'github');
    if (linked) result.linked!.push(key);

    if (isOpenEvent || isMergeEvent) {
      const verb = isMergeEvent ? 'merged' : action === 'reopened' ? 'reopened' : action === 'ready_for_review' ? 'marked ready for review' : 'opened';
      const text = `Pull request [${repo}#${number}](${url}) ${verb}${author ? ` by @${author}` : ''}: ${title}`;
      const c = await tryMutation(deps, who, commentMutation(item.id, text, 'github', { url, repo, number, action, sha: str(obj(pr.head).sha) }), 'github');
      if (c.ok) result.commented!.push(key); else result.errors!.push(`comment ${key}: ${c.error}`);
    }

    if (isMergeEvent && closingKeys.has(key)) {
      const t = await tryMutation(deps, who, transitionMutation(item.id, 'complete', `Completed by merge of ${repo}#${number}`), 'github');
      if (t.ok) result.completed!.push(key);
      else { result.errors!.push(`complete ${key}: ${t.error}`); deps.log.info({ key, pr: number, error: t.error }, 'github: complete transition not applied'); }
    }
  }
  if (!result.errors!.length) delete result.errors;
  return { status: 200, body: result };
}

async function onIssue(deps: IntegrationDeps, payload: Obj): Promise<GithubWebhookResult> {
  const action = str(payload.action);
  if (!ISSUE_ACTIONS.has(action)) return { status: 200, body: { ok: true, event: 'issues', ignored: `action:${action}` } };
  const issue = obj(payload.issue);
  const repo = str(obj(payload.repository).full_name);
  const number = Number(issue.number);
  const title = str(issue.title);
  const body = str(issue.body);
  const url = str(issue.html_url);
  const author = str(obj(issue.user).login);
  const state = str(issue.state) || (action === 'closed' ? 'closed' : 'open');

  const keys = [...new Set([...extractKeys(title), ...extractKeys(body)])];
  const who = await senderActor(deps, payload);
  const result: GithubWebhookResult['body'] = { ok: true, event: 'issues', linked: [], commented: [], errors: [] };
  for (const key of keys) {
    const item = await deps.findItemByKey(key);
    if (!item) continue;
    if (await ensureLink(deps, who, item.id, { kind: 'github_issue', ref: { url, repo, number, title, state, author } }, 'github')) result.linked!.push(key);
    if (action === 'opened') {
      const c = await tryMutation(deps, who, commentMutation(item.id, `Issue [${repo}#${number}](${url}) opened${author ? ` by @${author}` : ''}: ${title}`, 'github', { url, repo, number, action }), 'github');
      if (c.ok) result.commented!.push(key); else result.errors!.push(`comment ${key}: ${c.error}`);
    }
  }
  if (!result.errors!.length) delete result.errors;
  return { status: 200, body: result };
}

async function onPush(deps: IntegrationDeps, payload: Obj): Promise<GithubWebhookResult> {
  const repo = str(obj(payload.repository).full_name);
  const ref = str(payload.ref);
  const branch = ref.replace(/^refs\/heads\//, '');
  const branchKeys = extractKeysFromBranch(ref);
  const commits = Array.isArray(payload.commits) ? (payload.commits as Obj[]) : [];
  const who = await senderActor(deps, payload);
  const result: GithubWebhookResult['body'] = { ok: true, event: 'push', linked: [] };
  const linked = new Set<string>();
  for (const commit of commits) {
    const message = str(commit.message);
    const keys = [...new Set([...extractKeys(message), ...branchKeys])];
    if (!keys.length) continue;
    const sha = str(commit.id ?? commit.sha);
    const author = obj(commit.author);
    for (const key of keys) {
      const item = await deps.findItemByKey(key);
      if (!item) continue;
      const ok = await ensureLink(deps, who, item.id, {
        kind: 'github_commit',
        ref: { url: str(commit.url), repo, number: null, sha, title: truncate(message.split('\n')[0] ?? '', 200), state: 'pushed', author: str(author.username) || str(author.name), branch },
      }, 'github');
      if (ok) linked.add(key);
    }
  }
  result.linked = [...linked];
  return { status: 200, body: result };
}
