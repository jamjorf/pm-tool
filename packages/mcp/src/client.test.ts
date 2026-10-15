import { describe, expect, it, vi } from 'vitest';
import { PmApiError, PmClient } from './client.js';

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('PmClient', () => {
  it('sends the bearer API key and hits the documented paths', async () => {
    const { fn, calls } = mockFetch((url) => (url.includes('/api/v1/projects') ? { body: [{ key: 'RATES' }] } : { body: { item: { key: 'RATES-12' } } }));
    const c = new PmClient({ baseUrl: 'http://api.test/', apiKey: 'pm_abc', fetch: fn });
    const projects = await c.listProjects();
    expect(projects).toEqual([{ key: 'RATES' }]);
    expect(calls[0]!.url).toBe('http://api.test/api/v1/projects');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer pm_abc');
    expect(calls[0]!.init.method).toBe('GET');

    await c.getItem('RATES-12');
    expect(calls[1]!.url).toBe('http://api.test/api/v1/items/RATES-12');

    await c.transition('RATES-12', 'complete', 'done!');
    expect(calls[2]!.url).toBe('http://api.test/api/v1/items/RATES-12/transitions/complete');
    expect(calls[2]!.init.method).toBe('POST');
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ comment: 'done!' });
    expect((calls[2]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');

    await c.search('curve "boot strap"', 'RATES', 5);
    expect(calls[3]!.url).toBe('http://api.test/api/v1/search?q=curve+%22boot+strap%22&project=RATES&limit=5');

    await c.queryItems({ filter: { field: 'assignee_id', op: 'eq', value: '$me' } });
    expect(calls[4]!.url).toBe('http://api.test/api/v1/items/query');
    expect(JSON.parse(calls[4]!.init.body as string)).toEqual({ spec: { filter: { field: 'assignee_id', op: 'eq', value: '$me' } } });

    await c.updateItem('RATES-12', { priority: 1 });
    expect(calls[5]!.init.method).toBe('PATCH');
    await c.removeRelation('rel-1');
    expect(calls[6]!.init.method).toBe('DELETE');
    expect(calls[6]!.url).toBe('http://api.test/api/v1/relations/rel-1');
  });

  it('turns API error envelopes into PmApiError with code/status/details and swaps keys with withApiKey', async () => {
    const { fn, calls } = mockFetch((url) => (url.includes('/transitions/') ? { status: 409, body: { error: { code: 'guard_failed', message: 'blocked', details: { failures: ['no_open_blockers'] } } } } : { status: 404, body: { error: { code: 'not_found', message: 'nope' } } }));
    const c = new PmClient({ baseUrl: 'http://api.test', apiKey: 'pm_one', fetch: fn });
    await expect(c.getItem('X-1')).rejects.toMatchObject({ name: 'PmApiError', status: 404, code: 'not_found', message: 'nope' });
    const err = await c.withApiKey('pm_two').transition('X-1', 'complete').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmApiError);
    expect((err as PmApiError).details).toEqual({ failures: ['no_open_blockers'] });
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer pm_two');
  });

  it('reports network failures as a "network" PmApiError instead of throwing raw', async () => {
    const c = new PmClient({ baseUrl: 'http://api.test', apiKey: 'k', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(c.listProjects()).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});
