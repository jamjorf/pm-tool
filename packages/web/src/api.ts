// Tiny fetch wrapper for the non-synced endpoints. Everything else is read from the local store.
import type { ActivityEvent, User, ItemType, MutationArgsOf, ProjectRole, NotificationPreference } from '@pm/core';
import { toastError } from './lib/toast';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Opts {
  method?: string;
  body?: unknown;
  silent?: boolean; // don't toast on error
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const err = new ApiError(0, 'network', 'Network error: API unreachable');
    if (!opts.silent) toastError('API unreachable', 'Changes are kept locally and will sync when the server is back.');
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    const err = new ApiError(res.status, e?.code ?? 'internal', e?.message ?? `${res.status} ${res.statusText}`, e?.details);
    if (!opts.silent && res.status !== 401) toastError(err.message, err.code !== 'internal' ? err.code : undefined);
    throw err;
  }
  return json as T;
}

export interface Me {
  user: User;
  memberships: { project_id: string; role: ProjectRole }[];
  preferences: NotificationPreference[];
}

export interface SearchHit {
  id: string;
  key: string;
  title: string;
  project_id: string;
  state_id: string;
  rank?: number;
  snippet?: string;
  [k: string]: unknown;
}

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  event_kinds: string[];
  project_id: string | null;
  is_active: boolean;
  secret?: string;
  created_at: string;
}
export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_kind: string;
  status: string;
  attempts: number;
  response_status: number | null;
  next_attempt_at: string | null;
  created_at: string;
  last_error?: string | null;
}
export interface IntegrationConfig {
  kind: string;
  config: Record<string, unknown>;
  is_active: boolean;
  updated_at?: string;
}
export interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[] | null;
  created_at: string;
  last_used_at: string | null;
}

export const api = {
  // ---- auth / me ----
  devLogin: (email: string, name?: string) => request<{ user: User }>('/auth/dev-login', { body: { email, name } }),
  magicLink: (email: string) => request<{ ok: boolean }>('/auth/magic-link', { body: { email } }),
  logout: () => request<void>('/auth/logout', { method: 'POST', silent: true }),
  me: (silent = true) => request<Me>('/me', { silent }),

  // ---- api keys ----
  listApiKeys: () => request<ApiKeyRow[]>('/me/api-keys'),
  createApiKey: (name: string, scopes?: string[]) => request<{ id: string; key: string }>('/me/api-keys', { body: { name, scopes } }),
  deleteApiKey: (id: string) => request<void>(`/me/api-keys/${id}`, { method: 'DELETE' }),

  // ---- search / activity / my work ----
  search: (q: string, project?: string, limit = 25, signal?: AbortSignal) =>
    request<{ items: SearchHit[] }>(
      `/api/v1/search?q=${encodeURIComponent(q)}${project ? `&project=${encodeURIComponent(project)}` : ''}&limit=${limit}`,
      { silent: true, signal },
    ),
  activity: (itemKey: string, before?: number, limit = 100) =>
    request<{ events: ActivityEvent[] } | ActivityEvent[]>(
      `/api/v1/items/${encodeURIComponent(itemKey)}/activity?limit=${limit}${before ? `&before=${before}` : ''}`,
      { silent: true },
    ),
  myWork: () => request<Record<string, unknown>>('/api/v1/my-work', { silent: true }),
  runView: (id: string) => request<unknown>(`/api/v1/views/${id}/run`, { method: 'POST', body: {} }),

  // ---- admin ----
  upsertWorkflow: (key: string, args: MutationArgsOf<'upsertWorkflow'>) => request<unknown>(`/api/v1/workflows/${encodeURIComponent(key)}`, { method: 'PUT', body: args }),
  upsertType: (key: string, args: MutationArgsOf<'upsertItemType'>) => request<ItemType>(`/api/v1/types/${encodeURIComponent(key)}`, { method: 'PUT', body: args }),
  listUsers: () => request<User[] | { users: User[] }>('/api/v1/users'),
  patchUser: (id: string, patch: { firm_role?: string; is_active?: boolean }) => request<User>(`/api/v1/users/${id}`, { method: 'PATCH', body: patch }),
  listWebhooks: () => request<WebhookEndpoint[] | { webhooks: WebhookEndpoint[] }>('/api/v1/webhooks'),
  createWebhook: (body: { name: string; url: string; event_kinds: string[]; project?: string | null }) => request<WebhookEndpoint>('/api/v1/webhooks', { body }),
  patchWebhook: (id: string, patch: Partial<{ name: string; url: string; event_kinds: string[]; is_active: boolean }>) =>
    request<WebhookEndpoint>(`/api/v1/webhooks/${id}`, { method: 'PATCH', body: patch }),
  deleteWebhook: (id: string) => request<void>(`/api/v1/webhooks/${id}`, { method: 'DELETE' }),
  webhookDeliveries: (id: string) => request<WebhookDelivery[] | { deliveries: WebhookDelivery[] }>(`/api/v1/webhooks/${id}/deliveries`),
  testWebhook: (id: string) => request<unknown>(`/api/v1/webhooks/${id}/test`, { method: 'POST', body: {} }),
  listIntegrations: () => request<IntegrationConfig[] | { integrations: IntegrationConfig[] }>('/api/v1/integrations'),
  putIntegration: (kind: string, body: { config: Record<string, unknown>; is_active: boolean }) =>
    request<IntegrationConfig>(`/api/v1/integrations/${encodeURIComponent(kind)}`, { method: 'PUT', body }),
  exportCsvUrl: (project?: string) => `/api/v1/export/items.csv${project ? `?project=${encodeURIComponent(project)}` : ''}`,
};

/** Accept either `[...]` or `{ key: [...] }` response shapes. */
export function unwrapList<T>(res: T[] | Record<string, unknown>, key: string): T[] {
  if (Array.isArray(res)) return res;
  const v = (res as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as T[]) : [];
}
