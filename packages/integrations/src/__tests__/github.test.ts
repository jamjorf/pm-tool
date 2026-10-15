import { describe, expect, it } from 'vitest';
import { extractClosingKeys, handleGithubWebhook } from '../github/webhook.js';
import { mockDeps, named } from './helpers.js';

function prPayload(over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    repository: { full_name: 'acme/rates' },
    sender: { login: 'alice' },
    pull_request: {
      number: 42, title: 'Fix curve bootstrapping', body: 'Fixes RATES-12\n\nAlso touches OPS-3 (not here).', state: 'open', merged: false,
      html_url: 'https://github.com/acme/rates/pull/42', user: { login: 'alice' }, head: { ref: 'alice/rates-12-fix', sha: 'abc123' }, ...pr,
    },
    ...over,
  };
}

describe('handleGithubWebhook', () => {
  it('extracts closing keywords', () => {
    expect(extractClosingKeys('Fixes RATES-12, closes ops-3 and resolves: RATES-12')).toEqual(['RATES-12', 'OPS-3']);
    expect(extractClosingKeys('see RATES-12')).toEqual([]);
  });

  it('links and comments on an opened PR (keys from title/body/branch), skipping unknown items', async () => {
    const deps = mockDeps();
    const r = await handleGithubWebhook(deps, { event: 'pull_request', deliveryId: 'd1', payload: prPayload() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, linked: ['RATES-12'], commented: ['RATES-12'], completed: [] });
    const rel = named(deps.calls, 'addRelation');
    expect(rel).toHaveLength(1);
    expect(rel[0]!.args).toMatchObject({ type: 'links_to', external_kind: 'github_pr', external_ref: { url: 'https://github.com/acme/rates/pull/42', repo: 'acme/rates', number: 42, state: 'open', author: 'alice' } });
    const comments = named(deps.calls, 'addComment');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args.body).toContain('acme/rates#42');
    expect(comments[0]!.args.body).toContain('opened');
    expect(named(deps.calls, 'transitionItem')).toHaveLength(0);
    expect(deps.calls[0]!.meta.source).toBe('github');
  });

  it('runs the complete transition when a merged PR says "Fixes KEY", tolerating duplicate links and guard failures', async () => {
    const deps = mockDeps();
    deps.failWith.addRelation = new Error('duplicate key value violates unique constraint');
    const r = await handleGithubWebhook(deps, { event: 'pull_request', deliveryId: 'd2', payload: prPayload({ action: 'closed' }, { merged: true, state: 'closed' }) });
    expect(r.body).toMatchObject({ ok: true, linked: ['RATES-12'], commented: ['RATES-12'], completed: ['RATES-12'] });
    const t = named(deps.calls, 'transitionItem');
    expect(t).toHaveLength(1);
    expect(t[0]!.args).toMatchObject({ transition_key: 'complete' });
    expect(named(deps.calls, 'addComment')[0]!.args.body).toContain('merged');

    // Guard failure on the transition is logged, not thrown
    const deps2 = mockDeps();
    deps2.failWith.transitionItem = new Error('guard_failed: no_open_blockers');
    const r2 = await handleGithubWebhook(deps2, { event: 'pull_request', deliveryId: 'd3', payload: prPayload({ action: 'closed' }, { merged: true }) });
    expect(r2.status).toBe(200);
    expect(r2.body.completed).toEqual([]);
    expect(r2.body.errors?.[0]).toContain('guard_failed');
  });

  it('is idempotent per delivery id and links commits on push via branch name', async () => {
    const deps = mockDeps();
    await handleGithubWebhook(deps, { event: 'pull_request', deliveryId: 'same', payload: prPayload() });
    const dup = await handleGithubWebhook(deps, { event: 'pull_request', deliveryId: 'same', payload: prPayload() });
    expect(dup.body.duplicate).toBe(true);
    const before = deps.calls.length;

    const push = await handleGithubWebhook(deps, {
      event: 'push', deliveryId: 'p1',
      payload: { ref: 'refs/heads/rates-12-fix', repository: { full_name: 'acme/rates' }, pusher: { email: 'alice@example.com' }, commits: [{ id: 'deadbeef', message: 'tweak\n\nmore', url: 'https://github.com/acme/rates/commit/deadbeef', author: { name: 'Alice', username: 'alice' } }] },
    });
    expect(push.body.linked).toEqual(['RATES-12']);
    const rel = named(deps.calls, 'addRelation').at(-1)!;
    expect(rel.args.external_kind).toBe('github_commit');
    expect(rel.args.external_ref).toMatchObject({ sha: 'deadbeef', title: 'tweak', branch: 'rates-12-fix' });
    expect(deps.calls.length).toBe(before + 1);
    expect(deps.calls.at(-1)!.actor.id).toBe('11111111-1111-4111-8111-111111111111'); // resolved from pusher email
  });
});
