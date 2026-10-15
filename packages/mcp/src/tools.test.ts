import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PmApiError, type PmClient } from './client.js';
import { createServer } from './createServer.js';

type Call = { method: string; args: unknown[] };

function mockClient(calls: Call[]): PmClient {
  const detail = {
    item: { id: 'i-12', key: 'RATES-12', title: 'Fix curve bootstrapping', description: 'The 10y point is off.', project_key: 'RATES', type_key: 'bug', state_name: 'In progress', state_category: 'in_progress', priority: 2, assignee_name: 'Bob', due_date: '2026-10-20', url: 'http://app.test/items/RATES-12', fields: { severity: 'high' } },
    labels: [{ name: 'quant' }],
    relations: [
      { id: 'r1', type: 'blocks', other_item: { id: 'i-13', key: 'RATES-13', title: 'Publish curve', state: 'Todo' } },
      { id: 'r2', type: 'links_to', external_kind: 'github_pr', external_ref: { url: 'https://github.com/acme/rates/pull/42', title: 'PR #42' } },
    ],
    rollup: { children: 2, done: 1 },
    available_transitions: [
      { key: 'complete', name: 'Complete', to_state: 'done', allowed: false, failures: [{ guard: 'no_open_blockers', message: 'RATES-13 is still open' }] },
      { key: 'cancel', name: 'Cancel', to_state: 'canceled', allowed: true, failures: [] },
    ],
  };
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        calls.push({ method: prop, args });
        switch (prop) {
          case 'listProjects': return [{ id: 'p1', key: 'RATES', name: 'Rates desk', status: 'active' }, { id: 'p2', key: 'OPS', name: 'Operations', status: 'active', visibility: 'private' }];
          case 'getProject': return { project: { id: 'p1', key: 'RATES', name: 'Rates desk', default_type_id: 't-task' }, members: [], counts: { todo: 3 } };
          case 'getItem': return detail;
          case 'listTypes': return [{ id: 't-task', key: 'task', name: 'Task' }, { id: 't-bug', key: 'bug', name: 'Bug', field_defs: [{ key: 'severity', kind: 'select', options: [{ value: 'high' }] }] }];
          case 'listUsers': return [{ id: '11111111-1111-4111-8111-111111111111', name: 'Alice', email: 'alice@example.com' }];
          case 'createItem': return { id: 'i-99', key: 'RATES-99', title: (args[0] as { title: string }).title, url: 'http://app.test/items/RATES-99' };
          case 'addLabel': return {};
          case 'transition': {
            if ((args[1] as string) === 'complete') throw new PmApiError(409, 'guard_failed', 'transition not allowed', { failures: [{ guard: 'no_open_blockers', message: 'RATES-13 is still open' }, 'require_field: fields.root_cause'] });
            return { item: { key: 'RATES-12', state_name: 'Canceled' } };
          }
          default: return {};
        }
      };
    },
  };
  return new Proxy({}, handler) as PmClient;
}

describe('MCP tools over the in-memory transport', () => {
  const calls: Call[] = [];
  const client = new Client({ name: 'test', version: '0' });
  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(mockClient(calls)).connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterAll(async () => { await client.close(); });

  it('exposes the expected tools, resources and prompts', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of ['list_projects', 'get_project', 'search_items', 'query_items', 'get_item', 'create_item', 'update_item', 'bulk_update_items', 'transition_item', 'list_transitions', 'add_comment', 'list_comments', 'link_items', 'add_external_link', 'unlink', 'list_activity', 'my_work', 'list_views', 'run_view', 'list_types', 'list_workflows', 'create_view', 'list_users']) {
      expect(tools).toContain(n);
    }
    const q = (await client.listTools()).tools.find((t) => t.name === 'query_items')!;
    expect(q.description).toContain('$me');
    expect(JSON.stringify(q.inputSchema)).toContain('filter');
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate).sort();
    expect(templates).toEqual(['pm://items/{key}', 'pm://projects/{key}']);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['standup', 'triage_project']);
  });

  it('list_projects returns text and structuredContent', async () => {
    const r = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(r.isError).toBeFalsy();
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('RATES: Rates desk');
    expect(text).toContain('OPS: Operations');
    expect((r.structuredContent as { projects: unknown[] }).projects).toHaveLength(2);
  });

  it('get_item renders markdown with relations, transitions and guard failures', async () => {
    const r = await client.callTool({ name: 'get_item', arguments: { key: 'RATES-12' } });
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('# RATES-12 Fix curve bootstrapping');
    expect(text).toContain('**State:** In progress');
    expect(text).toContain('blocks → RATES-13 Publish curve (Todo)');
    expect(text).toContain('github_pr PR #42 https://github.com/acme/rates/pull/42');
    expect(text).toContain('`complete` Complete → done (not allowed) — blocked: RATES-13 is still open');
    expect(text).toContain('**severity:** high');
    expect((r.structuredContent as { item: { key: string } }).item.key).toBe('RATES-12');
    const res = await client.readResource({ uri: 'pm://items/RATES-12' });
    expect(res.contents[0]!.text).toContain('# RATES-12');
    expect(calls.filter((c) => c.method === 'getItem').map((c) => c.args[0])).toEqual(['RATES-12', 'RATES-12']);
  });

  it('transition_item surfaces 409 guard failures as a readable tool error', async () => {
    const r = await client.callTool({ name: 'transition_item', arguments: { key: 'RATES-12', transition: 'complete' } });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('Transition blocked by workflow guards');
    expect(text).toContain('- RATES-13 is still open');
    expect(text).toContain('- require_field: fields.root_cause');
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe('guard_failed');

    const okRes = await client.callTool({ name: 'transition_item', arguments: { key: 'RATES-12', transition: 'cancel', comment: 'dup' } });
    expect(okRes.isError).toBeFalsy();
    expect((okRes.content as Array<{ text: string }>)[0]!.text).toContain('transition "cancel" applied → Canceled');
    expect(calls.find((c) => c.method === 'transition' && c.args[1] === 'cancel')!.args[2]).toBe('dup');
  });

  it('create_item resolves assignee email and type key, then applies labels', async () => {
    calls.length = 0;
    const r = await client.callTool({ name: 'create_item', arguments: { project: 'rates', type: 'bug', title: 'Stale fixings', assignee: 'alice@example.com', priority: 1, labels: ['quant'], fields: { severity: 'high' } } });
    expect(r.isError).toBeFalsy();
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain('Created RATES-99: Stale fixings');
    const create = calls.find((c) => c.method === 'createItem')!;
    expect(create.args[0]).toMatchObject({ project_key: 'RATES', type_id: 't-bug', title: 'Stale fixings', assignee_id: '11111111-1111-4111-8111-111111111111', priority: 1, fields: { severity: 'high' } });
    expect(calls.find((c) => c.method === 'addLabel')!.args).toEqual(['RATES-99', 'quant']);
  });

  it('rejects invalid arguments without crashing the server', async () => {
    const r = await client.callTool({ name: 'create_item', arguments: { project: 'RATES', title: 'x', priority: 9 } }).catch((e: Error) => e);
    const text = r instanceof Error ? r.message : (r.content as Array<{ text: string }>)[0]!.text;
    expect(text.toLowerCase()).toMatch(/invalid|less than or equal/);
    const again = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(again.isError).toBeFalsy();
  });
});
