import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, createProject, expectOk, login, startApp, type Api, type Session } from './helpers.js';
import { dispatchPendingWebhooks } from '../src/webhooks/dispatcher.js';

let app: FastifyInstance;
let owner: Session;
let api: Api;
let server: Server;
let url: string;
const received: { headers: Record<string, any>; body: string }[] = [];
const P = 'WHK';

beforeAll(async () => {
  app = await startApp();
  owner = await login(app, 'owner@webhooks.test', 'Hook Owner', 'owner');
  api = client(app, owner);
  await createProject(api, P);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(req.url?.includes('fail') ? 500 : 200, { 'content-type': 'application/json' }).end('{"received":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}/hook`;
});
afterAll(async () => { await app.close(); server.close(); });

describe('webhooks', () => {
  it('enqueues coalesced deliveries, signs them with HMAC and marks them delivered', async () => {
    const ep = await api.post('/api/v1/webhooks', { name: 'test', url, event_kinds: ['item.created', 'item.transitioned', 'item.completed'], project: P });
    expect(ep.status).toBe(201);
    const secret: string = ep.body.secret;
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Hooked', assignee_id: owner.user.id }), 201);
    const pending = await app.db`select * from webhook_deliveries where endpoint_id = ${ep.body.id} order by id`;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'pending', event_kind: 'item.created' });
    expect(pending[0]!.payload.item.key).toBe(item.key);
    expect(pending[0]!.payload.id).toBe(String(pending[0]!.id));

    expectOk(await api.patch(`/api/v1/items/${item.key}`, { priority: 2 })); // item.updated: not subscribed
    expect((await app.db`select count(*)::int as n from webhook_deliveries where endpoint_id = ${ep.body.id}`)[0]!.n).toBe(1);
    expectOk(await api.post(`/api/v1/items/${item.key}/transitions/start`, { comment: 'go' }));
    expectOk(await api.post(`/api/v1/items/${item.key}/transitions/complete`, {}));
    const rows = await app.db`select * from webhook_deliveries where endpoint_id = ${ep.body.id} order by id`;
    expect(rows.map((r) => r.event_kind)).toEqual(['item.created', 'item.transitioned', 'item.completed']);
    expect(rows[1]!.payload.changes.map((c: any) => c.field)).toContain('state_id');
    expect(rows[1]!.payload.event_ids.length).toBeGreaterThan(1);

    const n = await dispatchPendingWebhooks(app.db, app.log);
    expect(n).toBe(3);
    expect(received).toHaveLength(3);
    for (const r of received) {
      expect(r.headers['x-pm-signature']).toBe('sha256=' + createHmac('sha256', secret).update(r.body).digest('hex'));
      expect(r.headers['x-pm-event']).toBe(JSON.parse(r.body).kind);
      expect(r.headers['x-pm-delivery']).toBe(JSON.parse(r.body).id);
    }
    const payload = JSON.parse(received[0]!.body);
    expect(payload).toMatchObject({ kind: 'item.created', actor: { id: owner.user.id, kind: 'user' }, project: { key: P }, item: { key: item.key } });
    const after = await app.db`select status, response_status, attempts from webhook_deliveries where endpoint_id = ${ep.body.id}`;
    expect(after.every((r) => r.status === 'delivered' && r.response_status === 200 && r.attempts === 1)).toBe(true);
    const list = expectOk(await api.get(`/api/v1/webhooks/${ep.body.id}/deliveries`));
    expect(list.deliveries).toHaveLength(3);
  });

  it('failed deliveries back off and the test endpoint sends a synchronous ping', async () => {
    const ep = expectOk(await api.post('/api/v1/webhooks', { name: 'failing', url: url + '?fail=1', event_kinds: ['*'] }), 201);
    expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Will fail' }), 201);
    await dispatchPendingWebhooks(app.db, app.log);
    const [d] = await app.db`select status, attempts, next_attempt_at > now() as later, response_status from webhook_deliveries where endpoint_id = ${ep.id}`;
    expect(d).toMatchObject({ status: 'failed', attempts: 1, later: true, response_status: 500 });
    const before = received.length;
    const test = expectOk(await api.post(`/api/v1/webhooks/${ep.id}/test`, {}));
    expect(test.status).toBe(500);
    expect(received.length).toBe(before + 1);
    expect(JSON.parse(received.at(-1)!.body).kind).toBe('ping');
    expect(received.at(-1)!.headers['x-pm-event']).toBe('ping');
    const member = client(app, await login(app, 'member@webhooks.test'));
    expect((await member.get('/api/v1/webhooks')).status).toBe(403);
    expectOk(await api.del(`/api/v1/webhooks/${ep.id}`));
  });
});
