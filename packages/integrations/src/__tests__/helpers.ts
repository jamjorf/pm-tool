import type { Actor, Mutation } from '@pm/core';
import type { IntegrationDeps, ItemSummary } from '../deps.js';

export interface MutationCall { actor: Actor; mutation: Mutation; meta: { source: string; actorLabel: string } }

export interface MockDeps extends IntegrationDeps {
  calls: MutationCall[];
  mutations: Mutation[];
  items: Map<string, ItemSummary>;
  logs: Array<{ level: string; obj: unknown; msg?: string }>;
  /** Make runMutation throw for a given mutation name (once per call while set). */
  failWith: Partial<Record<Mutation['name'], Error>>;
}

export const USER_ALICE = { id: '11111111-1111-4111-8111-111111111111', name: 'Alice', email: 'alice@example.com' };
export const SYSTEM_ID = '00000000-0000-4000-8000-000000000000';
export const PROJECT_RATES = { id: '22222222-2222-4222-8222-222222222222', key: 'RATES', name: 'Rates', default_type_id: '33333333-3333-4333-8333-333333333333' };

export function item(key: string, overrides: Partial<ItemSummary> = {}): ItemSummary {
  const n = key.split('-')[1];
  return {
    id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`,
    key,
    title: `Item ${key}`,
    description: 'Some description',
    type_key: 'task',
    project_id: PROJECT_RATES.id,
    project_key: key.split('-')[0]!,
    state_name: 'In progress',
    state_category: 'in_progress',
    priority: 2,
    assignee_name: 'Bob',
    assignee_id: '55555555-5555-4555-8555-555555555555',
    due_date: null,
    url: `http://app.test/items/${key}`,
    ...overrides,
  };
}

export function mockDeps(overrides: Partial<IntegrationDeps> = {}): MockDeps {
  const items = new Map<string, ItemSummary>();
  items.set('RATES-12', item('RATES-12'));
  items.set('RATES-7', item('RATES-7', { state_name: 'Done', state_category: 'done' }));
  const seen = new Set<string>();
  const calls: MutationCall[] = [];
  const logs: MockDeps['logs'] = [];
  const deps: MockDeps = {
    calls,
    mutations: [],
    items,
    logs,
    failWith: {},
    config: { appUrl: 'http://app.test', apiUrl: 'http://api.test', emailFrom: 'pm@pm.test', inboundDomain: 'pm.test' },
    getIntegrationConfig: async () => null,
    findItemByKey: async (key) => items.get(key.toUpperCase()) ?? null,
    findProjectByKey: async (key) => (key.toUpperCase() === 'RATES' ? PROJECT_RATES : null),
    resolveUserByEmail: async (email) => (email.toLowerCase() === USER_ALICE.email ? USER_ALICE : null),
    resolveUserBySlackId: async (id) => (id === 'UALICE' ? USER_ALICE : null),
    systemActor: async () => ({ id: SYSTEM_ID, firmRole: 'admin', memberships: {}, isService: true }),
    actorForUser: async (userId) => ({ id: userId, firmRole: 'member', memberships: {} }),
    runMutation: async (actor, mutation, meta) => {
      const fail = deps.failWith[mutation.name];
      if (fail) throw fail;
      calls.push({ actor, mutation, meta });
      deps.mutations.push(mutation);
      if (mutation.name === 'createItem') return { id: mutation.args.id, key: 'RATES-99', title: mutation.args.title };
      return { id: 'id' in mutation.args ? (mutation.args as { id: string }).id : undefined };
    },
    recordInbound: async (source, externalId) => {
      const k = `${source}:${externalId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
    log: {
      info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
    },
    ...overrides,
  };
  return deps;
}

export function named<N extends Mutation['name']>(calls: MutationCall[], name: N): Array<Extract<Mutation, { name: N }>> {
  return calls.map((c) => c.mutation).filter((m): m is Extract<Mutation, { name: N }> => m.name === name);
}
