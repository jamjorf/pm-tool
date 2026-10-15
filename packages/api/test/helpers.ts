import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/pmtool_api_test';

export async function startApp(): Promise<FastifyInstance> {
  return buildApp({
    config: { DATABASE_URL: TEST_DB_URL, WORKERS: false, LOG_LEVEL: 'silent', AUTH_MODE: 'dev', APP_URL: 'http://localhost:5173' },
    logger: false,
    integrations: false,
  });
}

export interface Session { cookie: string; user: any; headers: Record<string, string> }

export async function login(app: FastifyInstance, email: string, name?: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { email, name } });
  if (res.statusCode !== 200) throw new Error(`dev-login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'pm_session');
  if (!c) throw new Error('no session cookie');
  return { cookie: c.value, user: res.json().user, headers: { cookie: `pm_session=${c.value}` } };
}

export interface Res<T = any> { status: number; body: T; headers: Record<string, any> }

export function client(app: FastifyInstance, session?: Session | { headers: Record<string, string> }) {
  const call = async (method: InjectOptions['method'], url: string, payload?: unknown): Promise<Res> => {
    const res = await app.inject({ method, url, payload: payload as any, headers: { ...(session?.headers ?? {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
    let body: any = res.body;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* non-json */
    }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    patch: (url: string, payload: unknown) => call('PATCH', url, payload),
    put: (url: string, payload: unknown) => call('PUT', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}

export type Api = ReturnType<typeof client>;

export async function createProject(api: Api, key: string, extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/v1/projects', { key, name: `Project ${key}`, ...extra });
  if (res.status !== 201) throw new Error(`create project failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function typeIds(api: Api): Promise<Record<string, string>> {
  const res = await api.get('/api/v1/types');
  const out: Record<string, string> = {};
  for (const t of res.body.types) out[t.key] = t.id;
  return out;
}

export const expectOk = (res: Res, status = 200) => {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};
