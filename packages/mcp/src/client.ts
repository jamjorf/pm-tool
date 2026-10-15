// ============================================================================
// PmClient: thin typed wrapper over the pm-tool REST API v1 (fetch + Bearer
// API key). Every method maps to one route in docs/ARCHITECTURE.md. Errors
// become PmApiError (status + code + details) which the tool layer renders
// as MCP tool errors instead of crashing the server.
// ============================================================================
import type { ItemPatch, QuerySpec } from '@pm/core';

export interface PmClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
}

export class PmApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PmApiError';
  }
}

export type Json = Record<string, unknown>;

export interface ItemRef { id: string; key: string; title: string; state?: string }
export interface ItemDetail extends Json {
  item: Json;
  labels?: Json[];
  relations?: Array<Json & { other_item?: ItemRef | null }>;
  parent?: Json | null;
  children?: Json[];
  rollup?: Json | null;
  available_transitions?: Array<{ key: string; name: string; to_state: string; allowed: boolean; failures?: unknown[] }>;
  watchers?: Json[];
}

export interface CreateItemInput {
  project_key: string;
  type_id: string;
  title: string;
  description?: string;
  priority?: number;
  assignee_id?: string | null;
  due_date?: string | null;
  start_date?: string | null;
  estimate?: number | null;
  fields?: Record<string, unknown>;
  parent_id?: string | null;
  confidential?: boolean;
}

export interface ActivityQuery { project?: string; item?: string; actor?: string; since?: string | number; limit?: number }

const DEFAULT_BASE = 'http://localhost:3001';

export class PmClient {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: PmClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.API_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? process.env.PM_API_KEY;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** New client bound to a different bearer token (used by the HTTP transport's Authorization passthrough). */
  withApiKey(apiKey: string): PmClient {
    return new PmClient({ baseUrl: this.baseUrl, apiKey, fetch: this.fetchFn, timeoutMs: this.timeoutMs });
  }

  async request<T = Json>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new PmApiError(0, 'network', `Could not reach pm-tool API at ${this.baseUrl}: ${msg}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    let json: unknown = null;
    if (text) { try { json = JSON.parse(text); } catch { json = text; } }
    if (!res.ok) {
      const e = (json && typeof json === 'object' && 'error' in json ? (json as { error: Json }).error : null) ?? {};
      const code = typeof e.code === 'string' ? e.code : res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : 'internal';
      const message = typeof e.message === 'string' ? e.message : typeof json === 'string' && json ? json : `HTTP ${res.status}`;
      throw new PmApiError(res.status, code, message, e.details ?? (typeof json === 'object' ? json : undefined));
    }
    return (json ?? {}) as T;
  }

  get<T = Json>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> { return this.request<T>('GET', path, { query }); }
  post<T = Json>(path: string, body?: unknown): Promise<T> { return this.request<T>('POST', path, { body: body ?? {} }); }
  patch<T = Json>(path: string, body: unknown): Promise<T> { return this.request<T>('PATCH', path, { body }); }
  put<T = Json>(path: string, body: unknown): Promise<T> { return this.request<T>('PUT', path, { body }); }
  delete<T = Json>(path: string): Promise<T> { return this.request<T>('DELETE', path); }

  // ---- me / users -----------------------------------------------------------
  me() { return this.get('/me'); }
  listUsers() { return this.get<Json[] | { users: Json[] }>('/api/v1/users').then(unwrap('users')); }

  // ---- projects --------------------------------------------------------------
  listProjects(includeArchived = false) { return this.get<Json[] | { projects: Json[] }>('/api/v1/projects', includeArchived ? { include_archived: 1 } : undefined).then(unwrap('projects')); }
  getProject(key: string) { return this.get(`/api/v1/projects/${enc(key)}`); }

  // ---- items -----------------------------------------------------------------
  search(q: string, project?: string, limit?: number) { return this.get<{ items: Json[] }>('/api/v1/search', { q, project, limit }); }
  queryItems(spec: QuerySpec) { return this.post<{ items: Json[]; groups?: unknown; total?: number }>('/api/v1/items/query', { spec }); }
  listItems(query: Record<string, string | number | boolean | undefined>) { return this.get<{ items: Json[] } | Json[]>('/api/v1/items', query); }
  getItem(key: string) { return this.get<ItemDetail>(`/api/v1/items/${enc(key)}`); }
  createItem(input: CreateItemInput) { return this.post<Json>('/api/v1/items', input); }
  updateItem(key: string, patch: ItemPatch) { return this.patch<Json>(`/api/v1/items/${enc(key)}`, patch); }
  deleteItem(key: string) { return this.delete(`/api/v1/items/${enc(key)}`); }
  bulkUpdate(keys: string[], patch: ItemPatch) { return this.post<Json>('/api/v1/items/bulk', { keys, patch }); }
  transition(key: string, transitionKey: string, comment?: string) { return this.post<Json>(`/api/v1/items/${enc(key)}/transitions/${enc(transitionKey)}`, comment ? { comment } : {}); }
  listTransitions(key: string) { return this.get<Json[] | { transitions: Json[] }>(`/api/v1/items/${enc(key)}/transitions`).then(unwrap('transitions')); }
  listComments(key: string) { return this.get<Json[] | { comments: Json[] }>(`/api/v1/items/${enc(key)}/comments`).then(unwrap('comments')); }
  addComment(key: string, body: string, parentId?: string) { return this.post<Json>(`/api/v1/items/${enc(key)}/comments`, parentId ? { body, parent_id: parentId } : { body }); }
  listRelations(key: string) { return this.get<Json[] | { relations: Json[] }>(`/api/v1/items/${enc(key)}/relations`).then(unwrap('relations')); }
  addRelation(key: string, rel: { type: string; to_item?: string; external_kind?: string; external_ref?: Record<string, unknown> }) { return this.post<Json>(`/api/v1/items/${enc(key)}/relations`, rel); }
  removeRelation(id: string) { return this.delete(`/api/v1/relations/${enc(id)}`); }
  setParent(key: string, parent: string | null) { return this.put<Json>(`/api/v1/items/${enc(key)}/parent`, { parent }); }
  addLabel(key: string, label: string) { return this.post<Json>(`/api/v1/items/${enc(key)}/labels`, { label }); }
  itemActivity(key: string, q: { before?: string | number; limit?: number } = {}) { return this.get<Json[] | { events: Json[] }>(`/api/v1/items/${enc(key)}/activity`, q).then(unwrap('events')); }

  // ---- feeds / views / metadata --------------------------------------------
  activity(q: ActivityQuery) { return this.get<Json[] | { events: Json[] }>('/api/v1/activity', q as Record<string, string | number | undefined>).then(unwrap('events')); }
  myWork() { return this.get('/api/v1/my-work'); }
  listViews(project?: string) { return this.get<Json[] | { views: Json[] }>('/api/v1/views', { project }).then(unwrap('views')); }
  runView(id: string) { return this.post<Json>(`/api/v1/views/${enc(id)}/run`, {}); }
  createView(input: { project_id?: string | null; name: string; kind: string; spec: Record<string, unknown>; is_shared?: boolean }) { return this.post<Json>('/api/v1/views', input); }
  listTypes() { return this.get<Json[] | { types: Json[] }>('/api/v1/types').then(unwrap('types')); }
  listWorkflows() { return this.get<Json[] | { workflows: Json[] }>('/api/v1/workflows').then(unwrap('workflows')); }
  getWorkflow(key: string) { return this.get(`/api/v1/workflows/${enc(key)}`); }
  listLabels(project?: string) { return this.get<Json[] | { labels: Json[] }>('/api/v1/labels', { project }).then(unwrap('labels')); }
}

function enc(s: string): string { return encodeURIComponent(s); }

/** Routes may return either a bare array or `{ <name>: [...] }`; accept both. */
function unwrap(name: string) {
  return (res: unknown): Json[] => {
    if (Array.isArray(res)) return res as Json[];
    if (res && typeof res === 'object') {
      const r = res as Json;
      if (Array.isArray(r[name])) return r[name] as Json[];
      if (Array.isArray(r.items)) return r.items as Json[];
      if (Array.isArray(r.data)) return r.data as Json[];
    }
    return [];
  };
}
