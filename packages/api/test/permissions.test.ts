import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, createProject, expectOk, login, startApp, typeIds, type Api, type Session } from './helpers.js';

let app: FastifyInstance;
let owner: Session, guest: Session, viewer: Session;
let api: Api, guestApi: Api, viewerApi: Api;
let types: Record<string, string>;
const FIRM = 'PRM';
const PRIV = 'PRV';

beforeAll(async () => {
  app = await startApp();
  owner = await login(app, 'owner@perm.test', 'Perm Owner', 'owner');
  guest = await login(app, 'guest@perm.test', 'Gus Guest');
  viewer = await login(app, 'viewer@perm.test', 'Vera Viewer');
  api = client(app, owner);
  expectOk(await api.patch(`/api/v1/users/${guest.user.id}`, { firm_role: 'guest' }));
  guest = await login(app, 'guest@perm.test');
  guestApi = client(app, guest);
  viewerApi = client(app, viewer);
  types = await typeIds(api);
  await createProject(api, FIRM);
  await createProject(api, PRIV, { visibility: 'private' });
});
afterAll(async () => { await app.close(); });

describe('permissions', () => {
  it('guests cannot see firm projects; adding them as a member grants access', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: FIRM, type: 'task', title: 'Firm only' }), 201);
    expect(expectOk(await guestApi.get('/api/v1/projects')).projects).toEqual([]);
    expect((await guestApi.get(`/api/v1/projects/${FIRM}`)).status).toBe(404);
    expect((await guestApi.get(`/api/v1/items/${item.key}`)).status).toBe(404);
    expect((await guestApi.get(`/api/v1/items?project=${FIRM}`)).status).toBe(404);
    expect(expectOk(await guestApi.get('/api/v1/search?q=firm')).items).toEqual([]);
    expect((await guestApi.post('/api/v1/projects', { key: 'GST', name: 'nope' })).status).toBe(403);
    expectOk(await api.put(`/api/v1/projects/${FIRM}/members/${guest.user.id}`, { role: 'viewer' }));
    expect(expectOk(await guestApi.get(`/api/v1/projects/${FIRM}`)).effective_role).toBe('viewer');
    expect(expectOk(await guestApi.get(`/api/v1/items/${item.key}`)).item.key).toBe(item.key);
    const [flag] = await app.db`select count(*)::int as n from sync_client_groups where user_id = ${guest.user.id}`;
    expect(flag!.n).toBe(0);
  });

  it('viewers can read and comment but cannot edit, transition or delete', async () => {
    expectOk(await api.put(`/api/v1/projects/${PRIV}/members/${viewer.user.id}`, { role: 'viewer' }));
    const item = expectOk(await api.post('/api/v1/items', { project_key: PRIV, type: 'task', title: 'Private item' }), 201);
    expect(expectOk(await viewerApi.get(`/api/v1/items/${item.key}`)).item.key).toBe(item.key);
    const edit = await viewerApi.patch(`/api/v1/items/${item.key}`, { title: 'hacked' });
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toBe('forbidden');
    expect((await viewerApi.post(`/api/v1/items/${item.key}/transitions/start`, {})).status).toBe(403);
    expect((await viewerApi.del(`/api/v1/items/${item.key}`)).status).toBe(403);
    expect((await viewerApi.post('/api/v1/items', { project_key: PRIV, type: 'task', title: 'new' })).status).toBe(403);
    expect((await viewerApi.post(`/api/v1/items/${item.key}/comments`, { body: 'viewers may comment' })).status).toBe(201);
    const other = await login(app, 'other@perm.test');
    expect((await client(app, other).get(`/api/v1/items/${item.key}`)).status).toBe(404);
    expect((await client(app, other).get(`/api/v1/projects/${PRIV}`)).status).toBe(404);
    expectOk(await api.del(`/api/v1/projects/${PRIV}/members/${viewer.user.id}`));
    expect((await viewerApi.get(`/api/v1/items/${item.key}`)).status).toBe(404);
  });

  it('confidential items are only visible to admins, assignee, reporter', async () => {
    const member = await login(app, 'member@perm.test');
    const memberApi = client(app, member);
    const item = expectOk(await api.post('/api/v1/items', { project_key: FIRM, type: 'task', title: 'Hush', confidential: true }), 201);
    expect((await memberApi.get(`/api/v1/items/${item.key}`)).status).toBe(404);
    expectOk(await api.patch(`/api/v1/items/${item.key}`, { assignee_id: member.user.id }));
    expect((await memberApi.get(`/api/v1/items/${item.key}`)).status).toBe(200);
    const feed = expectOk(await client(app, await login(app, 'member2@perm.test')).get(`/api/v1/activity?project=${FIRM}`));
    expect(feed.events.some((e: any) => e.item_id === item.id)).toBe(false);
  });
});

describe('admin', () => {
  it('PUT /types/:key validates field_defs and refuses to drop a field still in use unless forced', async () => {
    const member = client(app, await login(app, 'member3@perm.test'));
    expect((await member.put('/api/v1/types/gadget', { name: 'Gadget', workflow: 'simple', field_defs: [] })).status).toBe(403);
    const bad = await api.put('/api/v1/types/gadget', { name: 'Gadget', workflow: 'simple', field_defs: [{ key: 'Bad Key', label: 'x', kind: 'text' }] });
    expect(bad.status).toBe(400);
    const created = expectOk(await api.put('/api/v1/types/gadget', { name: 'Gadget', workflow: 'simple', field_defs: [{ key: 'serial', label: 'Serial', kind: 'text' }, { key: 'weight', label: 'Weight', kind: 'number' }] }));
    expect(created.key).toBe('gadget');
    const item = expectOk(await api.post('/api/v1/items', { project_key: FIRM, type: 'gadget', title: 'G1', fields: { serial: 'abc' } }), 201);
    const refuse = await api.put('/api/v1/types/gadget', { name: 'Gadget', workflow: 'simple', field_defs: [{ key: 'weight', label: 'Weight', kind: 'number' }] });
    expect(refuse.status).toBe(400);
    expect(refuse.body.error.details.fields).toEqual(['serial']);
    const forced = expectOk(await api.put('/api/v1/types/gadget?force=1', { name: 'Gadget', workflow: 'simple', field_defs: [{ key: 'weight', label: 'Weight', kind: 'number' }] }));
    expect(forced.field_defs.map((d: any) => d.key)).toEqual(['weight']);
    expect((await app.db`select fields from work_items where id = ${item.id}`)[0]!.fields).toEqual({});
    expect(expectOk(await api.get('/api/v1/types')).types.map((t: any) => t.key)).toContain('gadget');
  });

  it('PUT /workflows/:key validates with the engine and refuses to delete states still in use', async () => {
    const invalid = await api.put('/api/v1/workflows/review', { name: 'Review', states: [{ key: 'open', name: 'Open', category: 'todo', is_initial: true }, { key: 'closed', name: 'Closed', category: 'done' }], transitions: [] });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body.error.details)).toMatch(/closed/);
    const wf = expectOk(await api.put('/api/v1/workflows/review', {
      name: 'Review',
      states: [{ key: 'open', name: 'Open', category: 'todo', is_initial: true }, { key: 'closed', name: 'Closed', category: 'done' }, { key: 'parked', name: 'Parked', category: 'backlog' }],
      transitions: [{ key: 'close', name: 'Close', from: null, to: 'closed', guards: [{ type: 'require_role', roles: ['admin', 'editor'] }] }, { key: 'park', name: 'Park', from: 'open', to: 'parked' }],
    }));
    expect(wf.states.map((s: any) => s.key).sort()).toEqual(['closed', 'open', 'parked']);
    const got = expectOk(await api.get('/api/v1/workflows/review'));
    expect(got.transitions.map((t: any) => t.key).sort()).toEqual(['close', 'park']);
    expectOk(await api.put('/api/v1/types/reviewable', { name: 'Reviewable', workflow: 'review', field_defs: [] }));
    const item = expectOk(await api.post('/api/v1/items', { project_key: FIRM, type: 'reviewable', title: 'R1' }), 201);
    expectOk(await api.post(`/api/v1/items/${item.key}/transitions/park`, {}));
    const refuse = await api.put('/api/v1/workflows/review', {
      name: 'Review',
      states: [{ key: 'open', name: 'Open', category: 'todo', is_initial: true }, { key: 'closed', name: 'Closed', category: 'done' }],
      transitions: [{ key: 'close', name: 'Close', from: null, to: 'closed' }],
    });
    expect(refuse.status).toBe(400);
    expect(refuse.body.error.message).toMatch(/parked/);
    expectOk(await api.post(`/api/v1/items/${item.key}/transitions/close`, {}));
    const ok = expectOk(await api.put('/api/v1/workflows/review', {
      name: 'Review',
      states: [{ key: 'open', name: 'Open', category: 'todo', is_initial: true }, { key: 'closed', name: 'Closed', category: 'done' }],
      transitions: [{ key: 'close', name: 'Close', from: null, to: 'closed' }, { key: 'reopen', name: 'Reopen', from: 'closed', to: 'open' }],
    }));
    expect(ok.states.map((s: any) => s.key).sort()).toEqual(['closed', 'open']);
    expect((await app.db`select deleted_at from workflow_states where workflow_id = ${ok.id} and key = 'parked'`)[0]!.deleted_at).toBeTruthy();
    expect(expectOk(await api.get('/api/v1/workflows')).workflows.map((w: any) => w.key)).toContain('review');
    void randomUUID; void types;
  });
});
