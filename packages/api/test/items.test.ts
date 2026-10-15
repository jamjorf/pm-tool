import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, createProject, expectOk, login, startApp, typeIds, type Api, type Session } from './helpers.js';

let app: FastifyInstance;
let owner: Session, bob: Session, carol: Session;
let api: Api, bobApi: Api;
let types: Record<string, string>;
let project: any;
const P = 'ITM';

beforeAll(async () => {
  app = await startApp();
  owner = await login(app, 'owner@items.test', 'Olivia Owner');
  bob = await login(app, 'bob@items.test', 'Bob Builder');
  carol = await login(app, 'carol@items.test', 'Carol Coder');
  api = client(app, owner);
  bobApi = client(app, bob);
  types = await typeIds(api);
  project = await createProject(api, P);
});
afterAll(async () => { await app.close(); });

describe('projects', () => {
  it('creates a project, lists it and exposes members/counts', async () => {
    expect(project.key).toBe(P);
    const list = expectOk(await api.get('/api/v1/projects'));
    expect(list.projects.some((p: any) => p.key === P)).toBe(true);
    const detail = expectOk(await api.get(`/api/v1/projects/${P}`));
    expect(detail.members.some((m: any) => m.user_id === owner.user.id && m.role === 'admin')).toBe(true);
    expect(detail.item_counts).toEqual({});
    expect(detail.effective_role).toBe('admin');
    const dup = await api.post('/api/v1/projects', { key: P, name: 'dup' });
    expect(dup.status).toBe(409);
  });
});

describe('items', () => {
  it('creates an item with key assignment, default initial state, reporter and one create event', async () => {
    const res = await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Build the rates curve', description: 'Bootstrap the curve' });
    expect(res.status).toBe(201);
    const item = res.body;
    expect(item.key).toBe(`${P}-1`);
    expect(item.number).toBe(1);
    expect(item.reporter_id).toBe(owner.user.id);
    expect(item.created_by).toBe(owner.user.id);
    const [state] = await app.db`select key, is_initial from workflow_states where id = ${item.state_id}`;
    expect(state).toMatchObject({ key: 'todo', is_initial: true });
    const events = await app.db`select * from activity_events where item_id = ${item.id}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', field: null, entity_type: 'work_item' });
    expect(events[0]!.new_value.key).toBe(item.key);
    const second = expectOk(await api.post('/api/v1/items', { project: P, type_id: types.task, title: 'Second' }), 201);
    expect(second.key).toBe(`${P}-2`);
    const detail = expectOk(await api.get(`/api/v1/items/${item.key}`));
    expect(detail.item.id).toBe(item.id);
    expect(detail.available_transitions.map((t: any) => t.key)).toContain('start');
    expect(detail.watchers.some((w: any) => w.user_id === owner.user.id && w.reason === 'reporter')).toBe(true);
    const byId = expectOk(await api.get(`/api/v1/items/${item.id}`));
    expect(byId.item.key).toBe(item.key);
  });

  it('rejects a bug without the required severity field with a validation error', async () => {
    const res = await api.post('/api/v1/items', { project_key: P, type: 'bug', title: 'Crash on start' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');
    expect(JSON.stringify(res.body.error.details)).toContain('severity');
    const bad = await api.post('/api/v1/items', { project_key: P, type: 'bug', title: 'Crash', fields: { severity: 'nope' } });
    expect(bad.status).toBe(400);
    const ok = await api.post('/api/v1/items', { project_key: P, type: 'bug', title: 'Crash on start', fields: { severity: 's1' } });
    expect(ok.status).toBe(201);
    expect(ok.body.fields).toEqual({ severity: 's1' });
  });

  it('update writes one activity row per changed field in one txn and auto-watches + notifies the assignee', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'bug', title: 'Flaky test', fields: { severity: 's3' } }), 201);
    const res = await api.patch(`/api/v1/items/${item.key}`, { title: 'Flaky integration test', priority: 2, assignee_id: bob.user.id, fields: { environment: 'uat' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Flaky integration test', priority: 2, assignee_id: bob.user.id, fields: { severity: 's3', environment: 'uat' } });
    const events = await app.db`select * from activity_events where item_id = ${item.id} and action = 'update' order by id`;
    const fields = events.map((e) => e.field).sort();
    expect(fields).toEqual(['assignee_id', 'fields.environment', 'priority', 'title']);
    expect(new Set(events.map((e) => e.txn_id)).size).toBe(1);
    expect(events.find((e) => e.field === 'title')).toMatchObject({ old_value: 'Flaky test', new_value: 'Flaky integration test' });
    const watchers = await app.db`select * from item_watchers where item_id = ${item.id} and user_id = ${bob.user.id}`;
    expect(watchers[0]).toMatchObject({ reason: 'assignee' });
    const notes = await app.db`select * from notifications where item_id = ${item.id}`;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ user_id: bob.user.id, kind: 'assigned', read_at: null });
    const activity = expectOk(await api.get(`/api/v1/items/${item.key}/activity`));
    expect(activity.events.length).toBe(5);
    const noop = await api.patch(`/api/v1/items/${item.key}`, { priority: 2 });
    expect(noop.status).toBe(200);
    expect((await app.db`select count(*)::int as n from activity_events where item_id = ${item.id}`)[0]!.n).toBe(5);
  });

  it('transition: guard failure returns 409 guard_failed; success applies the patch, effects and transition events', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Needs an owner' }), 201);
    const fail = await api.post(`/api/v1/items/${item.key}/transitions/start`, {});
    expect(fail.status).toBe(409);
    expect(fail.body.error.code).toBe('guard_failed');
    expect(fail.body.error.details.failures.length).toBeGreaterThan(0);
    expect(JSON.stringify(fail.body.error.details.failures)).toContain('assignee_id');
    const avail = expectOk(await api.get(`/api/v1/items/${item.key}/transitions`));
    expect(avail.transitions.find((t: any) => t.key === 'start').allowed).toBe(false);

    expectOk(await api.patch(`/api/v1/items/${item.key}`, { assignee_id: bob.user.id }));
    const ok = await api.post(`/api/v1/items/${item.key}/transitions/start`, { comment: 'Kicking off' });
    expect(ok.status).toBe(200);
    const [state] = await app.db`select key, category from workflow_states where id = ${ok.body.state_id}`;
    expect(state).toMatchObject({ key: 'in_progress', category: 'in_progress' });
    expect(ok.body.start_date).toBe(new Date().toISOString().slice(0, 10));
    const events = await app.db`select * from activity_events where item_id = ${item.id} and action = 'transition' order by id`;
    expect(events.map((e) => e.field)).toEqual(['state_id', 'transition_key']);
    expect(events[1]!.new_value).toBe('start');
    expect(events[0]!.mutation_name).toBe('transitionItem');
    const comments = expectOk(await api.get(`/api/v1/items/${item.key}/comments`));
    expect(comments.comments.map((c: any) => c.body)).toContain('Kicking off');
    const notes = await app.db`select kind from notifications where item_id = ${item.id} and user_id = ${bob.user.id} order by kind`;
    expect(notes.map((n) => n.kind)).toEqual(['assigned', 'state_change']);
    const unknown = await api.post(`/api/v1/items/${item.key}/transitions/teleport`, {});
    expect(unknown.status).toBe(404);
    const done = await api.post(`/api/v1/items/${item.key}/transitions/complete`, {});
    expect(done.status).toBe(200);
    expect(done.body.completed_at).toBeTruthy();
  });

  it('bulk update applies one patch to many items under one txn_id and bulk-transition reports failures', async () => {
    const a = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Bulk A' }), 201);
    const b = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Bulk B' }), 201);
    const res = await api.post('/api/v1/items/bulk', { keys: [a.key, b.key], patch: { priority: 1, due_date: '2030-01-01' } });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.priority)).toEqual([1, 1]);
    const txns = await app.db`select distinct txn_id from activity_events where item_id in (${a.id}, ${b.id}) and action = 'update'`;
    expect(txns).toHaveLength(1);
    const bt = await api.post('/api/v1/items/bulk-transition', { ids: [a.id, b.id], transition_key: 'start' });
    expect(bt.status).toBe(200);
    expect(bt.body.ok).toEqual([]);
    expect(bt.body.failed.map((f: any) => f.id).sort()).toEqual([a.id, b.id].sort());
    expectOk(await api.post('/api/v1/items/bulk', { ids: [a.id], patch: { assignee_id: owner.user.id } }));
    const bt2 = expectOk(await api.post('/api/v1/items/bulk-transition', { ids: [a.id, b.id], transition_key: 'start' }));
    expect(bt2.ok).toEqual([a.id]);
    expect(bt2.failed.map((f: any) => f.id)).toEqual([b.id]);
  });

  it('relations: parent, blocks → is_blocked, and cycles are rejected', async () => {
    const epic = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'initiative', title: 'Epic' }), 201);
    const child = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Child', parent: epic.key }), 201);
    expect(child.parent_id).toBe(epic.id);
    const other = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Other' }), 201);
    const moved = expectOk(await api.put(`/api/v1/items/${child.key}/parent`, { parent: other.key }));
    expect(moved.parent_id).toBe(other.id);
    const live = await app.db`select from_item_id from relations where to_item_id = ${child.id} and type = 'parent_of' and deleted_at is null`;
    expect(live).toHaveLength(1);
    expect(live[0]!.from_item_id).toBe(other.id);
    const cycle = await api.put(`/api/v1/items/${other.key}/parent`, { parent: child.key });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.message).toMatch(/cycle/);

    const blocker = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Blocker' }), 201);
    const rel = await api.post(`/api/v1/items/${blocker.key}/relations`, { type: 'blocks', to_item: other.key });
    expect(rel.status).toBe(201);
    const detail = expectOk(await api.get(`/api/v1/items/${other.key}`));
    expect(detail.item.is_blocked).toBe(true);
    expect(detail.relations.find((r: any) => r.type === 'blocks')).toMatchObject({ direction: 'in', label: 'is blocked by', other_item: { key: blocker.key } });
    expectOk(await api.patch(`/api/v1/items/${other.key}`, { assignee_id: owner.user.id }));
    const blocked = await api.post(`/api/v1/items/${other.key}/transitions/start`, {});
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body.error.details.failures)).toContain('no_open_blockers');
    const back = await api.post(`/api/v1/items/${other.key}/relations`, { type: 'blocks', to_item: blocker.key });
    expect(back.status).toBe(409);
    expectOk(await api.del(`/api/v1/relations/${rel.body.id}`));
    expect(expectOk(await api.get(`/api/v1/items/${other.key}`)).item.is_blocked).toBe(false);
    const ext = await api.post(`/api/v1/items/${other.key}/relations`, { type: 'links_to', external_kind: 'github_pr', external_ref: { url: 'https://github.com/org/repo/pull/1', number: 1 } });
    expect(ext.status).toBe(201);
    const extAgain = await api.post(`/api/v1/items/${other.key}/relations`, { type: 'links_to', external_kind: 'github_pr', external_ref: { url: 'https://github.com/org/repo/pull/1', number: 1 } });
    expect(extAgain.body.id).toBe(ext.body.id);
  });

  it('comments: mention notifies the mentioned user, never the actor; replies notify the parent author', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Discuss' }), 201);
    const body = `Hey @[Bob Builder](user:${bob.user.id}) and @[Olivia Owner](user:${owner.user.id}) look at this`;
    const c = await api.post(`/api/v1/items/${item.key}/comments`, { body });
    expect(c.status).toBe(201);
    expect(c.body.source).toBe('app');
    const notes = await app.db`select user_id, kind from notifications where item_id = ${item.id}`;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ user_id: bob.user.id, kind: 'mention' });
    expect((await app.db`select reason from item_watchers where item_id = ${item.id} and user_id = ${bob.user.id}`)[0]).toMatchObject({ reason: 'mention' });
    const reply = expectOk(await bobApi.post(`/api/v1/items/${item.key}/comments`, { body: 'Looking!', parent_id: c.body.id }), 201);
    expect(reply.parent_id).toBe(c.body.id);
    const ownerNotes = await app.db`select kind from notifications where item_id = ${item.id} and user_id = ${owner.user.id}`;
    expect(ownerNotes.map((n) => n.kind)).toEqual(['reply']);
    const inbox = expectOk(await bobApi.get('/api/v1/notifications?unread=1'));
    expect(inbox.notifications.some((n: any) => n.kind === 'mention' && n.item_key === item.key)).toBe(true);
    const read = expectOk(await bobApi.post(`/api/v1/notifications/${inbox.notifications[0].id}/read`, {}));
    expect(read.read_at).toBeTruthy();
    const edited = expectOk(await bobApi.patch(`/api/v1/comments/${reply.id}`, { body: 'Looking now!' }));
    expect(edited.edited_at).toBeTruthy();
    const forbidden = await client(app, carol).patch(`/api/v1/comments/${reply.id}`, { body: 'hijack' });
    expect(forbidden.status).toBe(403);
    expectOk(await bobApi.del(`/api/v1/comments/${reply.id}`));
  });

  it('soft delete hides the item; restore brings it back', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Temporary' }), 201);
    expectOk(await api.del(`/api/v1/items/${item.key}`));
    expect((await api.get(`/api/v1/items/${item.key}`)).status).toBe(404);
    const [row] = await app.db`select deleted_at from work_items where id = ${item.id}`;
    expect(row!.deleted_at).toBeTruthy();
    const restored = await api.post(`/api/v1/items/${item.key}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.deleted_at).toBeNull();
    const actions = (await app.db`select action from activity_events where item_id = ${item.id} order by id`).map((e) => e.action);
    expect(actions).toEqual(['create', 'delete', 'restore']);
  });

  it('labels, watch and list filters', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Labelled' }), 201);
    const labelled = expectOk(await api.post(`/api/v1/items/${item.key}/labels`, { label: 'urgent-fix' }));
    expect(labelled.label_ids).toHaveLength(1);
    const list = expectOk(await api.get(`/api/v1/items?project=${P}&label=urgent-fix`));
    expect(list.items.map((i: any) => i.key)).toEqual([item.key]);
    expect(list.items[0].label_names).toEqual(['urgent-fix']);
    const byCat = expectOk(await api.get(`/api/v1/items?project=${P}&state_category=done`));
    expect(byCat.items.every((i: any) => i.state_category === 'done')).toBe(true);
    expect(byCat.items.length).toBeGreaterThan(0);
    const paged = expectOk(await api.get(`/api/v1/items?project=${P}&limit=2`));
    expect(paged.items).toHaveLength(2);
    expect(paged.next_cursor).toBeTruthy();
    const page2 = expectOk(await api.get(`/api/v1/items?project=${P}&limit=2&cursor=${paged.next_cursor}`));
    expect(page2.items[0].key).not.toBe(paged.items[0].key);
    expectOk(await bobApi.post(`/api/v1/items/${item.key}/watch`, {}));
    expect((await app.db`select reason from item_watchers where item_id = ${item.id} and user_id = ${bob.user.id}`)[0]).toMatchObject({ reason: 'manual' });
    expectOk(await bobApi.del(`/api/v1/items/${item.key}/watch`));
    expect((await app.db`select deleted_at from item_watchers where item_id = ${item.id} and user_id = ${bob.user.id}`)[0]!.deleted_at).toBeTruthy();
    expectOk(await api.del(`/api/v1/items/${item.key}/labels/${labelled.label_ids[0]}`));
    expect(expectOk(await api.get(`/api/v1/items/${item.key}`)).labels).toEqual([]);
  });

  it('search uses FTS with snippets and falls back to trigram title matching', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Swaption volatility surface calibration', description: 'Recalibrate the SABR parameters nightly' }), 201);
    const fts = expectOk(await api.get('/api/v1/search?q=calibration'));
    expect(fts.items.map((i: any) => i.key)).toContain(item.key);
    const hit = fts.items.find((i: any) => i.key === item.key);
    expect(typeof hit.rank).toBe('number');
    expect(hit.snippet).toMatch(/calibration/i);
    const desc = expectOk(await api.get('/api/v1/search?q=SABR'));
    expect(desc.items.map((i: any) => i.key)).toContain(item.key);
    const trgm = expectOk(await api.get('/api/v1/search?q=swaptio'));
    expect(trgm.items.map((i: any) => i.key)).toContain(item.key);
    const scoped = expectOk(await api.get(`/api/v1/search?q=calibration&project=${P}`));
    expect(scoped.items.length).toBeGreaterThan(0);
    const empty = expectOk(await api.get('/api/v1/search?q='));
    expect(empty.items).toEqual([]);
  });

  it('my-work lists assigned/created/due_soon work', async () => {
    const item = expectOk(await api.post('/api/v1/items', { project_key: P, type: 'task', title: 'Mine', assignee_id: bob.user.id, due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }), 201);
    const mine = expectOk(await bobApi.get('/api/v1/my-work'));
    expect(mine.assigned.map((i: any) => i.key)).toContain(item.key);
    expect(mine.due_soon.map((i: any) => i.key)).toContain(item.key);
    const ownerWork = expectOk(await api.get('/api/v1/my-work'));
    expect(ownerWork.created.map((i: any) => i.key)).toContain(item.key);
    expect(Array.isArray(ownerWork.mentions)).toBe(true);
  });

  it('items/query compiles a QuerySpec with visibility scope, grouping and totals; views run the same way', async () => {
    const q = expectOk(await api.post('/api/v1/items/query', { spec: { filter: { and: [{ field: 'project.key', op: 'eq', value: P }, { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }] }, sort: [{ field: 'priority', dir: 'asc' }], group_by: 'state_id', limit: 3 } }));
    expect(q.items.length).toBe(3);
    expect(q.total).toBeGreaterThan(3);
    expect(q.groups.length).toBeGreaterThan(0);
    expect(q.groups[0].items.length).toBeGreaterThan(0);
    expect(q.groups.every((g: any) => g.label && g.key)).toBe(true);
    const view = expectOk(await api.post('/api/v1/views', { project: P, name: 'Open by state', kind: 'board', spec: { filter: { field: 'state.category', op: 'nin', value: ['done'] }, board: { column_field: 'state_id' } }, is_shared: true }), 201);
    const run = expectOk(await api.post(`/api/v1/views/${view.id}/run`, {}));
    expect(run.groups.length).toBeGreaterThan(0);
    const dash = expectOk(await api.post('/api/v1/views', { project: P, name: 'Dash', kind: 'dashboard', spec: { dashboard: { widgets: [{ id: 'w1', title: 'By state', viz: 'bar', query: { filter: { field: 'project.key', op: 'eq', value: P } }, group_by: 'state.category', measure: 'count' }] } } }), 201);
    const dashRun = expectOk(await api.post(`/api/v1/views/${dash.id}/run`, {}));
    expect(dashRun.widgets[0].id).toBe('w1');
    expect(dashRun.widgets[0].rows.reduce((s: number, r: any) => s + r.value, 0)).toBeGreaterThan(0);
    const views = expectOk(await bobApi.get(`/api/v1/views?project=${P}`));
    expect(views.views.map((v: any) => v.name)).toContain('Open by state');
    expect(views.views.map((v: any) => v.name)).not.toContain('Dash');
  });

  it('exports visible items as CSV and lists activity with visibility', async () => {
    const res = await api.get(`/api/v1/export/items.csv?project=${P}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = String(res.body);
    expect(text.split('\r\n')[0]).toMatch(/^key,title,type_key/);
    expect(text).toContain(`${P}-1,`);
    const feed = expectOk(await api.get(`/api/v1/activity?project=${P}&limit=10`));
    expect(feed.events.length).toBe(10);
    expect(feed.events[0].project_key).toBe(P);
    const since = expectOk(await api.get(`/api/v1/activity?project=${P}&since=${feed.events[9].id}&limit=5`));
    expect(since.events[0].id).toBeGreaterThan(feed.events[9].id);
  });
});
