import type { FastifyInstance, InjectOptions } from 'fastify';
import { openDb } from '@pm/db/sqlite';
import { runMigrations } from '@pm/db/migrate';
import { buildApp } from '../src/app.js';

/** Fresh in-memory SQLite database with the migration applied; closed when the app closes. */
export async function startApp(): Promise<FastifyInstance> {
  const db = openDb(':memory:');
  await runMigrations(db);
  const app = await buildApp({
    config: { DATABASE_URL: ':memory:', WORKERS: false, LOG_LEVEL: 'silent', AUTH_MODE: 'dev', APP_URL: 'http://localhost:5173' },
    db,
    logger: false,
    integrations: false,
  });
  app.addHook('onClose', async () => db.close());
  return app;
}

export interface Session { cookie: string; user: any; headers: Record<string, string> }

/** Dev-login; `role` promotes the user (only the very first user of a database is a natural owner). */
export async function login(app: FastifyInstance, email: string, name?: string, role?: 'owner' | 'admin' | 'member' | 'guest'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { email, name } });
  if (res.statusCode !== 200) throw new Error(`dev-login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'pm_session');
  if (!c) throw new Error('no session cookie');
  let user = res.json().user;
  if (role && user.firm_role !== role) {
    await app.db`update users set firm_role = ${role} where id = ${user.id}`;
    [user] = await app.db`select * from users where id = ${user.id}`;
  }
  return { cookie: c.value, user, headers: { cookie: `pm_session=${encodeURIComponent(c.value)}` } };
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

/** `select count(*)` as a number. */
export const count = async (app: FastifyInstance, q: PromiseLike<any[]>): Promise<number> => Number((await q)[0]?.n ?? 0);
