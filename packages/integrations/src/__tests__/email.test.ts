import { describe, expect, it } from 'vitest';
import { handleInboundEmail, parseInboundEmail, routeAddress, stripQuotedReply } from '../email/inbound.js';
import { mockDeps, named, USER_ALICE } from './helpers.js';

describe('stripQuotedReply', () => {
  it('drops quoted lines and everything after an "On ... wrote:" header', () => {
    const text = [
      'Sounds good, shipping it tomorrow.',
      '',
      'On Mon, 1 Jan 2024 at 10:00, Bob <bob@example.com>',
      'wrote:',
      '> Can you take RATES-12?',
      '> thanks',
      '',
      'random trailing quote',
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('Sounds good, shipping it tomorrow.');
    expect(stripQuotedReply('ok\n> quoted\nstill mine\n-- \nAlice\nSig')).toBe('ok\nstill mine');
    expect(stripQuotedReply('reply\n\n-----Original Message-----\nFrom: x')).toBe('reply');
  });
});

describe('address routing', () => {
  it('routes pm+KEY to items, pm+PROJECT to projects and ignores other domains', () => {
    expect(routeAddress('pm+RATES-12@pm.test', 'pm.test')).toEqual({ kind: 'item', key: 'RATES-12' });
    expect(routeAddress('pm+rates@pm.test', 'pm.test')).toEqual({ kind: 'project', key: 'RATES' });
    expect(routeAddress('pm@pm.test', 'pm.test')).toEqual({ kind: 'plain' });
    expect(routeAddress('pm+RATES-12@other.test', 'pm.test')).toBeNull();
    expect(routeAddress('alice@pm.test', 'pm.test')).toBeNull();
  });

  it('normalises Postmark-style payloads', () => {
    const mail = parseInboundEmail({ From: 'Alice <alice@example.com>', ToFull: [{ Email: 'pm+RATES-12@pm.test' }], Subject: 'Re: [RATES-12] hi', TextBody: 'body', MessageID: '<abc@mail>' });
    expect(mail).toMatchObject({ fromAddress: 'alice@example.com', to: ['pm+rates-12@pm.test'], subject: 'Re: [RATES-12] hi', text: 'body', message_id: 'abc@mail' });
  });
});

describe('handleInboundEmail', () => {
  it('adds a comment for pm+KEY as the resolved user, stripping the quote, and is idempotent', async () => {
    const deps = mockDeps();
    const body = { from: 'Alice <alice@example.com>', to: 'pm+RATES-12@pm.test', subject: 'Re: [RATES-12] Item', text: 'Will do.\n\nOn Mon Bob wrote:\n> please', message_id: 'm1' };
    const r = await handleInboundEmail(deps, body);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, action: 'comment', key: 'RATES-12' });
    const comments = named(deps.calls, 'addComment');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args.body).toBe('Will do.');
    expect((comments[0]!.args as Record<string, unknown>).external_ref).toMatchObject({ message_id: 'm1', from: 'alice@example.com' });
    expect(deps.calls[0]!.actor.id).toBe(USER_ALICE.id);
    expect(deps.calls[0]!.meta).toEqual({ source: 'email', actorLabel: 'Alice' });
    const again = await handleInboundEmail(deps, body);
    expect(again.body.action).toBe('duplicate');
    expect(deps.calls).toHaveLength(1);
  });

  it('creates an item for pm+PROJECT with the subject as title (system actor for unknown senders)', async () => {
    const deps = mockDeps();
    const r = await handleInboundEmail(deps, { from: 'stranger@example.com', to: ['pm+rates@pm.test'], subject: 'Rates feed is stale', text: 'Since this morning.', message_id: 'm2' });
    expect(r.body).toMatchObject({ ok: true, action: 'created', key: 'RATES-99' });
    const created = named(deps.calls, 'createItem');
    expect(created[0]!.args).toMatchObject({ title: 'Rates feed is stale' });
    expect(created[0]!.args.description).toContain('Since this morning.');
    expect(created[0]!.args.description).toContain('stranger@example.com');
    expect(deps.calls[0]!.meta.source).toBe('email');
    expect(deps.calls[0]!.actor.isService).toBe(true);
  });

  it('falls back to the [KEY] in the subject when mail goes to the plain pm@ address', async () => {
    const deps = mockDeps();
    const r = await handleInboundEmail(deps, { from: 'alice@example.com', to: 'pm@pm.test', subject: 'Re: [RATES-12] Item RATES-12', text: 'hi', message_id: 'm3' });
    expect(r.body).toMatchObject({ action: 'comment', key: 'RATES-12' });
  });
});
