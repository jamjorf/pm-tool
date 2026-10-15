import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerIntegrationRoutes } from '../routes.js';
import { signSlackRequest } from '../slack/verify.js';
import { signGithubRequest } from '../github/verify.js';
import { mockDeps, named } from './helpers.js';

async function app(deps = mockDeps()) {
  const f = Fastify();
  // The host API typically has its own JSON parser; ours must not conflict with it.
  f.removeContentTypeParser('application/json');
  f.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, JSON.parse(body as string)));
  f.post('/host', async (req) => ({ echoed: req.body }));
  await registerIntegrationRoutes(f, deps);
  await f.ready();
  return f;
}

describe('registerIntegrationRoutes', () => {
  it('rejects bad Slack signatures with 401 and accepts good ones (raw body preserved for JSON and form bodies)', async () => {
    const deps = mockDeps({ config: { appUrl: 'http://app.test', apiUrl: 'http://api.test', emailFrom: 'x@y', slackSigningSecret: 'sekrit' } });
    const f = await app(deps);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'xyz' });
    const ts = Math.floor(Date.now() / 1000);
    const bad = await f.inject({ method: 'POST', url: '/integrations/slack/events', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=00' }, payload: body });
    expect(bad.statusCode).toBe(401);
    const good = await f.inject({ method: 'POST', url: '/integrations/slack/events', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signSlackRequest('sekrit', body, ts) }, payload: body });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ challenge: 'xyz' });

    const form = 'command=%2Fpm&text=RATES-12&user_id=UALICE';
    const cmd = await f.inject({ method: 'POST', url: '/integrations/slack/commands', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signSlackRequest('sekrit', form, ts) }, payload: form });
    expect(cmd.statusCode).toBe(200);
    expect(cmd.json().text).toContain('RATES-12');

    // Host routes keep their own parser
    const host = await f.inject({ method: 'POST', url: '/host', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' });
    expect(host.json()).toEqual({ echoed: { a: 1 } });
    await f.close();
  });

  it('verifies GitHub signatures and dispatches to the webhook handler; email inbound answers 202', async () => {
    const deps = mockDeps({ config: { appUrl: 'http://app.test', apiUrl: 'http://api.test', emailFrom: 'x@y', inboundDomain: 'pm.test', githubWebhookSecret: 'gh' } });
    const f = await app(deps);
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'acme/rates' }, sender: { login: 'bob' }, pull_request: { number: 1, title: 'RATES-12 work', body: '', state: 'open', html_url: 'https://github.com/acme/rates/pull/1', user: { login: 'bob' }, head: { ref: 'main', sha: 'a' } } });
    const unsigned = await f.inject({ method: 'POST', url: '/integrations/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'g1' }, payload });
    expect(unsigned.statusCode).toBe(401);
    const signed = await f.inject({ method: 'POST', url: '/integrations/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'g1', 'x-hub-signature-256': signGithubRequest('gh', payload) }, payload });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ ok: true, linked: ['RATES-12'] });
    expect(named(deps.calls, 'addRelation')).toHaveLength(1);

    const mail = await f.inject({ method: 'POST', url: '/integrations/email/inbound', headers: { 'content-type': 'application/json' }, payload: { from: 'alice@example.com', to: 'pm+RATES-12@pm.test', subject: 's', text: 'hello', message_id: 'e1' } });
    expect(mail.statusCode).toBe(202);
    expect(mail.json()).toMatchObject({ action: 'comment', key: 'RATES-12' });
    expect(deps.logs.some((l) => l.level === 'warn' && /dev mode/.test(l.msg ?? ''))).toBe(true);
    await f.close();
  });
});
