import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, login, startApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('health + auth', () => {
  it('GET /health reports db ok', async () => {
    const res = await client(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: true });
    expect(typeof res.body.version).toBe('string');
  });

  it('dev-login creates the first user as owner, sets a cookie, /me works', async () => {
    const s = await login(app, 'owner@auth.test', 'Olivia Owner');
    expect(s.user.firm_role).toBe('owner');
    const me = await client(app, s).get('/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('owner@auth.test');
    expect(Array.isArray(me.body.memberships)).toBe(true);
    expect(Array.isArray(me.body.preferences)).toBe(true);
    const again = await login(app, 'owner@auth.test');
    expect(again.user.id).toBe(s.user.id);
  });

  it('later users are members; unauthenticated requests get 401 in the error envelope', async () => {
    const m = await login(app, 'member@auth.test');
    expect(m.user.firm_role).toBe('member');
    const res = await client(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    const nf = await client(app, m).get('/api/v1/items/NOPE-1');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('not_found');
  });

  it('api keys authenticate with Bearer; read-only keys cannot write; logout clears the session', async () => {
    const s = await login(app, 'keys@auth.test');
    const api = client(app, s);
    const created = await api.post('/me/api-keys', { name: 'cli', scopes: ['read'] });
    expect(created.status).toBe(201);
    expect(created.body.key.startsWith('pm_')).toBe(true);
    const bearer = client(app, { headers: { authorization: `Bearer ${created.body.key}` } });
    const me = await bearer.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.auth).toBe('api_key');
    const write = await bearer.post('/api/v1/projects', { key: 'KEYS', name: 'x' });
    expect(write.status).toBe(403);
    const list = await api.get('/me/api-keys');
    expect(list.body.keys.map((k: any) => k.id)).toContain(created.body.id);
    expect(list.body.keys[0].key).toBeUndefined();
    const bad = await client(app, { headers: { authorization: 'Bearer pm_nope' } }).get('/me');
    expect(bad.status).toBe(401);
    const out = await api.post('/auth/logout', {});
    expect(out.status).toBe(200);
    expect((await api.get('/me')).status).toBe(401);
    const del = await client(app, await login(app, 'keys@auth.test')).del(`/me/api-keys/${created.body.id}`);
    expect(del.status).toBe(200);
    expect((await bearer.get('/me')).status).toBe(401);
  });

  it('magic link flow logs a link and the callback sets a cookie', async () => {
    const res = await client(app).post('/auth/magic-link', { email: 'magic@auth.test' });
    expect(res.status).toBe(200);
    expect(res.body.link).toContain('/auth/callback?token=');
    const token = new URL(res.body.link).searchParams.get('token')!;
    const cb = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.cookies.some((c) => c.name === 'pm_session')).toBe(true);
    const replay = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` });
    expect(replay.statusCode).toBe(404);
  });
});
