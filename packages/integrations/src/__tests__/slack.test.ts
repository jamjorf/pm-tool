import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSlackEvent } from '../slack/events.js';
import { handleSlackCommand } from '../slack/commands.js';
import { handleSlackInteraction } from '../slack/interactions.js';
import { mockDeps, named, USER_ALICE } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('slack events', () => {
  it('echoes url_verification', async () => {
    const r = await handleSlackEvent(mockDeps(), { type: 'url_verification', challenge: 'abc', token: 't' });
    expect(r).toEqual({ status: 200, body: { challenge: 'abc' } });
  });

  it('autolinks item keys in human messages as a slack_thread relation (idempotent, bots ignored)', async () => {
    const deps = mockDeps();
    const ev = { type: 'event_callback', event_id: 'Ev1', event: { type: 'message', user: 'UALICE', channel: 'C1', ts: '1700000000.000100', thread_ts: '1699999999.000100', text: 'Looking at RATES-12 and RATES-404 now' } };
    const r = await handleSlackEvent(deps, ev);
    expect(r.body).toEqual({ ok: true, linked: ['RATES-12'] });
    const rel = named(deps.calls, 'addRelation');
    expect(rel).toHaveLength(1);
    expect(rel[0]!.args).toMatchObject({ type: 'links_to', external_kind: 'slack_thread', external_ref: { channel: 'C1', ts: '1700000000.000100', text: 'Looking at RATES-12 and RATES-404 now' } });
    expect((rel[0]!.args.external_ref as { url: string }).url).toContain('/archives/C1/p1700000000000100');
    expect(deps.calls[0]!.actor.id).toBe(USER_ALICE.id);
    expect(deps.calls[0]!.meta).toEqual({ source: 'slack', actorLabel: 'Alice' });

    expect((await handleSlackEvent(deps, ev)).body).toEqual({ ok: true, duplicate: true });
    const bot = await handleSlackEvent(deps, { ...ev, event_id: 'Ev2', event: { ...ev.event, bot_id: 'B1' } });
    expect(bot.body).toMatchObject({ ignored: 'bot_or_subtype' });
    expect(deps.calls).toHaveLength(1);
  });

  it('respects autolink=false in the integration config', async () => {
    const deps = mockDeps({ getIntegrationConfig: async () => ({ config: { autolink: false }, is_active: true }) });
    const r = await handleSlackEvent(deps, { type: 'event_callback', event_id: 'Ev3', event: { type: 'message', user: 'U2', channel: 'C1', ts: '1.2', text: 'RATES-12' } });
    expect(r.body).toMatchObject({ ignored: 'autolink_disabled' });
    expect(deps.calls).toHaveLength(0);
  });
});

describe('slack commands', () => {
  it('/pm KEY shows an ephemeral card with buttons and /pm create makes an item', async () => {
    const deps = mockDeps();
    const card = await handleSlackCommand(deps, { command: '/pm', text: 'rates-12', user_id: 'UALICE' });
    const body = card.body as { response_type: string; text: string; blocks: Array<{ type: string; elements?: Array<{ action_id: string }> }> };
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('RATES-12');
    const actions = body.blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements!.map((e) => e.action_id)).toEqual(['open:RATES-12', 'assign_me:RATES-12', 'transition:RATES-12:complete']);

    const find = await handleSlackCommand(deps, { command: '/pm', text: 'find curve bootstrapping' });
    expect((find.body as { text: string }).text).toContain('http://app.test/search?q=curve%20bootstrapping');

    const created = await handleSlackCommand(deps, { command: '/pm', text: 'create rates Stale curve on Mondays', user_id: 'UALICE' });
    expect((created.body as { text: string }).text).toContain('RATES-99');
    const m = named(deps.calls, 'createItem')[0]!;
    expect(m.args).toMatchObject({ project_id: '22222222-2222-4222-8222-222222222222', title: 'Stale curve on Mondays' });
    expect(deps.calls[0]!.actor.id).toBe(USER_ALICE.id);
  });
});

describe('slack interactions', () => {
  it('runs transitions / assign_me from block_actions and posts the outcome to response_url', async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => { posted.push({ url, body: JSON.parse(init.body) }); return new Response('ok', { status: 200 }); }));
    const deps = mockDeps();
    const payload = { type: 'block_actions', user: { id: 'UALICE' }, response_url: 'https://hooks.slack.test/r', actions: [{ action_id: 'transition:RATES-12:complete' }, { action_id: 'assign_me:RATES-12' }] };
    const r = await handleSlackInteraction(deps, { payload: JSON.stringify(payload) });
    expect(r.status).toBe(200);
    expect(named(deps.calls, 'transitionItem')[0]!.args).toMatchObject({ transition_key: 'complete' });
    expect(named(deps.calls, 'updateItem')[0]!.args).toMatchObject({ patch: { assignee_id: USER_ALICE.id } });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://hooks.slack.test/r');
    expect((posted[0]!.body as { text: string }).text).toContain('RATES-12 → ran transition "complete"');
    expect((posted[0]!.body as { text: string }).text).toContain('assigned to you');
  });
});
