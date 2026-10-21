import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, count, createProject, expectOk, login, startApp, typeIds, type Api, type Session } from './helpers.js';
import { pokeBus } from '../src/sync/poke.js';

let app: FastifyInstance;
let owner: Session, viewer: Session;
let api: Api, viewerApi: Api;
let types: Record<string, string>;
let project: any;
const P = 'SYN';
const push = (api: Api, clientGroupID: string, mutations: any[]) =>
  api.post('/sync/push', { pushVersion: 1, clientGroupID, profileID: 'p1', schemaVersion: '1', mutations });
const pull = (api: Api, clientGroupID: string, cookie: number | null) =>
  api.post('/sync/pull', { pullVersion: 1, clientGroupID, cookie, profileID: 'p1', schemaVersion: '1' });

beforeAll(async () => {
  app = await startApp();
  owner = await login(app, 'owner@sync.test', 'Sync Owner', 'owner');
  viewer = await login(app, 'viewer@sync.test', 'Sync Viewer');
  api = client(app, owner);
  viewerApi = client(app, viewer);
  types = await typeIds(api);
  project = await createProject(api, P);
});
afterAll(async () => { await app.close(); });

describe('sync', () => {
  const cg = 'cg-owner-1';
  const itemId = randomUUID();
  let cookie = 0;

  it('push applies mutations in order, idempotently, and pokes', async () => {
    const pokes: number[] = [];
    const onPoke = (v: number) => pokes.push(v);
    pokeBus.on('poke', onPoke);
    const mutations = [
      { id: 1, clientID: 'c1', name: 'createItem', args: { id: itemId, project_id: project.id, type_id: types.task, title: 'Synced item' }, timestamp: Date.now() },
      { id: 2, clientID: 'c1', name: 'updateItem', args: { id: itemId, patch: { priority: 1, title: 'Synced item v2' } }, timestamp: Date.now() },
    ];
    const res = await push(api, cg, mutations);
    expect(res.status).toBe(200);
    expect(pokes.length).toBe(1);
    expect(pokes[0]).toBe(app.db.currentVersion()); // poke carries the global version
    pokeBus.off('poke', onPoke);
    const [row] = await app.db`select key, title, priority from work_items where id = ${itemId}`;
    expect(row).toMatchObject({ key: `${P}-1`, title: 'Synced item v2', priority: 1 });
    const [cl] = await app.db`select last_mutation_id, version from sync_clients where id = 'c1'`;
    expect(cl!.last_mutation_id).toBe(2);
    expect(cl!.version).toBe(app.db.currentVersion()); // the last thing stamped in the push transaction
    const before = await count(app, app.db`select count(*) as n from activity_events where item_id = ${itemId}`);
    const replay = await push(api, cg, mutations);
    expect(replay.status).toBe(200);
    expect(await count(app, app.db`select count(*) as n from activity_events where item_id = ${itemId}`)).toBe(before);
    const gap = await push(api, cg, [{ id: 9, clientID: 'c1', name: 'updateItem', args: { id: itemId, patch: { priority: 2 } } }]);
    expect(gap.status).toBe(409);
    const other = await push(viewerApi, cg, []);
    expect(other.status).toBe(403);
  });

  it('first pull clears and sends every visible row; incremental pulls send put/del by version', async () => {
    const full = await pull(api, cg, null);
    expect(full.status).toBe(200);
    expect(full.body.patch[0]).toEqual({ op: 'clear' });
    expect(full.body.lastMutationIDChanges).toEqual({ c1: 2 });
    const keys = full.body.patch.filter((p: any) => p.key).map((p: any) => p.key);
    expect(keys).toContain(`work_items/${itemId}`);
    expect(keys).toContain(`projects/${project.id}`);
    expect(keys).toContain(`users/${owner.user.id}`);
    expect(keys.some((k: string) => k.startsWith('workflow_states/'))).toBe(true);
    expect(keys.some((k: string) => k.startsWith('item_types/'))).toBe(true);
    expect(full.body.patch.filter((p: any) => p.op === 'del')).toHaveLength(0);
    const itemPut = full.body.patch.find((p: any) => p.key === `work_items/${itemId}`);
    expect(itemPut.value).toMatchObject({ key: `${P}-1`, label_ids: [], parent_id: null, is_blocked: false, confidential: false, fields: {} });
    expect(itemPut.value.search).toBeUndefined();
    expect(itemPut.value._visible).toBeUndefined();
    const typePut = full.body.patch.find((p: any) => p.key === `item_types/${types.bug}`);
    expect(Array.isArray(typePut.value.field_defs)).toBe(true);
    expect(typePut.value.is_active).toBe(true);
    const statePut = full.body.patch.find((p: any) => p.key && p.key.startsWith('workflow_states/'));
    expect(typeof statePut.value.is_initial).toBe('boolean');
    expect(typeof full.body.cookie).toBe('number');
    expect(full.body.cookie).toBe(app.db.currentVersion()); // cookie = sync_state.version inside the snapshot
    cookie = full.body.cookie;

    const nothing = await pull(api, cg, cookie);
    expect(nothing.body.patch).toEqual([]);
    expect(nothing.body.cookie).toBe(cookie);

    await push(api, cg, [{ id: 3, clientID: 'c1', name: 'updateItem', args: { id: itemId, patch: { title: 'v3' } } }]);
    const inc = await pull(api, cg, cookie);
    expect(inc.body.patch.some((p: any) => p.op === 'clear')).toBe(false);
    const put = inc.body.patch.find((p: any) => p.key === `work_items/${itemId}`);
    expect(put.op).toBe('put');
    expect(put.value.title).toBe('v3');
    expect(put.value.version).toBeGreaterThan(cookie);
    expect(inc.body.lastMutationIDChanges).toEqual({ c1: 3 });
    expect(inc.body.cookie).toBeGreaterThan(cookie);
    cookie = inc.body.cookie;

    await push(api, cg, [{ id: 4, clientID: 'c1', name: 'deleteItem', args: { id: itemId } }]);
    const del = await pull(api, cg, cookie);
    expect(del.body.patch.find((p: any) => p.key === `work_items/${itemId}`)).toEqual({ op: 'del', key: `work_items/${itemId}` });
    cookie = del.body.cookie;
    await push(api, cg, [{ id: 5, clientID: 'c1', name: 'restoreItem', args: { id: itemId } }]);
    const restored = await pull(api, cg, cookie);
    expect(restored.body.patch.find((p: any) => p.key === `work_items/${itemId}`)?.op).toBe('put');
    cookie = restored.body.cookie;
  });

  it('confidential items are hidden from users who are not assignee/reporter/admin; confidentiality changes force a resync', async () => {
    const secretId = randomUUID();
    await push(api, cg, [{ id: 6, clientID: 'c1', name: 'createItem', args: { id: secretId, project_id: project.id, type_id: types.task, title: 'Secret', confidential: true } }]);
    const vg = 'cg-viewer-1';
    const vfull = await pull(viewerApi, vg, null);
    const vkeys = vfull.body.patch.filter((p: any) => p.key).map((p: any) => p.key);
    expect(vkeys).toContain(`projects/${project.id}`); // firm member sees the firm project
    expect(vkeys).toContain(`work_items/${itemId}`);
    expect(vkeys).not.toContain(`work_items/${secretId}`);
    let vcookie = vfull.body.cookie;

    await push(api, cg, [{ id: 7, clientID: 'c1', name: 'updateItem', args: { id: secretId, patch: { assignee_id: viewer.user.id } } }]);
    const vinc = await pull(viewerApi, vg, vcookie);
    expect(vinc.body.patch.find((p: any) => p.key === `work_items/${secretId}`)?.op).toBe('put');
    vcookie = vinc.body.cookie;

    await push(api, cg, [{ id: 8, clientID: 'c1', name: 'updateItem', args: { id: secretId, patch: { assignee_id: null } } }]);
    const vdel = await pull(viewerApi, vg, vcookie);
    expect(vdel.body.patch.find((p: any) => p.key === `work_items/${secretId}`)?.op).toBe('del');
    vcookie = vdel.body.cookie;
    expect((await app.db`select resync_required from sync_client_groups where id = ${vg}`)[0]!.resync_required).toBe(false);

    // a confidentiality change flags every client group of users who can see the project
    await push(api, cg, [{ id: 9, clientID: 'c1', name: 'updateItem', args: { id: secretId, patch: { confidential: false } } }]);
    expect((await app.db`select resync_required from sync_client_groups where id = ${vg}`)[0]!.resync_required).toBe(true);
    const resync = await pull(viewerApi, vg, vcookie);
    expect(resync.body.patch[0]).toEqual({ op: 'clear' });
    expect(resync.body.patch.some((p: any) => p.key === `work_items/${secretId}` && p.op === 'put')).toBe(true);
    expect((await app.db`select resync_required from sync_client_groups where id = ${vg}`)[0]!.resync_required).toBe(false);
    cookie = (await pull(api, cg, cookie)).body.cookie;
  });

  it('a failing mutation is still marked applied and surfaces as a mutation_rejected notification', async () => {
    const bugId = randomUUID();
    const res = await push(api, cg, [{ id: 10, clientID: 'c1', name: 'createItem', args: { id: bugId, project_id: project.id, type_id: types.bug, title: 'No severity' } }]);
    expect(res.status).toBe(200);
    expect((await app.db`select id from work_items where id = ${bugId}`)).toHaveLength(0);
    expect((await app.db`select last_mutation_id from sync_clients where id = 'c1'`)[0]!.last_mutation_id).toBe(10);
    const notes = await app.db`select * from notifications where user_id = ${owner.user.id} and kind = 'mutation_rejected'`;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain('createItem');
    expect(notes[0]!.body).toMatch(/severity/);
    const inc = await pull(api, cg, cookie);
    expect(inc.body.patch.some((p: any) => p.key === `notifications/${notes[0]!.id}` && p.op === 'put')).toBe(true);
    expect(inc.body.lastMutationIDChanges.c1).toBe(10);
  });

  it('GET /sync/poke streams SSE pokes after writes', async () => {
    const res = await new Promise<{ status: number; headers: any; chunks: string[] }>((resolve) => {
      const chunks: string[] = [];
      app.inject({ method: 'GET', url: '/sync/poke', headers: owner.headers, payloadAsStream: true } as any).then((r: any) => {
        r.stream().on('data', (c: Buffer) => {
          chunks.push(c.toString());
          if (chunks.join('').includes('event: poke')) { resolve({ status: r.statusCode, headers: r.headers, chunks }); r.stream().destroy(); }
        });
        setTimeout(() => pokeBus.poke(123), 50);
      });
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.chunks.join('')).toContain('event: poke\ndata: {"version":123}');
    expectOk(await api.get('/health'));
  });
});
