import { describe, it, expect } from 'vitest';
import { workflowEngine, evaluateGuard, resolveEffectValue } from './engine.js';
import type { WorkflowDefinition, GuardContext } from './types.js';
import type { WorkItem, WorkflowState, WorkflowTransition, Guard } from '../schema/entities.js';

const synced = { version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null };
const st = (id: string, key: string, category: WorkflowState['category'], sort: number, is_initial = false): WorkflowState =>
  ({ id, workflow_id: 'wf', key, name: key, category, color: null, sort, is_initial, ...synced });
const tr = (id: string, key: string, from: string | null, to: string, guards: WorkflowTransition['guards'] = [], effects: WorkflowTransition['effects'] = [], sort = 0): WorkflowTransition =>
  ({ id, workflow_id: 'wf', key, name: key, from_state_id: from, to_state_id: to, guards, effects, sort, ...synced });

const def: WorkflowDefinition = {
  id: 'wf', key: 'standard',
  states: [st('backlog', 'backlog', 'backlog', 0), st('todo', 'todo', 'todo', 1, true), st('prog', 'in_progress', 'in_progress', 2), st('done', 'done', 'done', 4), st('cancel', 'canceled', 'canceled', 5)],
  transitions: [
    tr('t1', 'triage', 'backlog', 'todo', [], [], 0),
    tr('t2', 'start', null, 'prog', [{ type: 'require_field', field: 'assignee_id' }, { type: 'no_open_blockers' }], [{ type: 'set_field', field: 'start_date', value: '$today', only_if_null: true }], 1),
    tr('t3', 'complete', null, 'done', [{ type: 'children_in_category', categories: ['done', 'canceled'] }], [{ type: 'set_field', field: 'completed_at', value: '$now' }, { type: 'webhook', event: 'item.completed' }, { type: 'notify', audience: ['watchers'], template: 'done' }], 4),
    tr('t4', 'cancel', null, 'cancel', [{ type: 'require_role', roles: ['admin', 'editor'] }], [{ type: 'set_field', field: 'canceled_at', value: '$now' }, { type: 'set_field', field: 'fields.reason', value: 'canceled by $actor' }, { type: 'set_field', field: 'fields.closed_by', value: '$actor' }], 5),
    tr('t5', 'restore', 'cancel', 'todo', [], [{ type: 'set_field', field: 'canceled_at', value: null }], 6),
    tr('t6', 'approve', 'prog', 'done', [{ type: 'field_equals', field: 'fields.approved', value: true }, { type: 'field_in', field: 'fields.severity', values: ['s1', 's2'] }, { type: 'require_assignee_is_actor' }, { type: 'require_label', label: 'Regulatory' }], [{ type: 'transition_parent_if', all_children_category: ['done'], to: 'done' }], 7),
    { ...tr('t7', 'old', null, 'done'), deleted_at: '2026-02-01T00:00:00Z' },
    tr('t8', 'backlog', null, 'backlog', [], [{ type: 'set_field', field: 'completed_at', value: null }], 8),
  ],
};

const item: WorkItem = {
  id: 'i1', project_id: 'p', type_id: 't', number: 1, key: 'X-1', title: 't', description: '', state_id: 'todo', priority: 2,
  assignee_id: 'alice', reporter_id: null, start_date: null, due_date: null, estimate: null, fields: { approved: true, severity: 's1', existing: 1 }, confidential: false, sort_order: 0,
  created_by: null, completed_at: null, canceled_at: null, archived_at: null, ...synced,
};
const now = new Date('2026-10-15T12:34:56.000Z');
const ctx: GuardContext = { actorId: 'alice', actorRole: 'editor', now, openBlockerCount: 0, childrenCategories: [], labelNames: ['regulatory', 'tech-debt'] };

describe('availableTransitions', () => {
  it('returns global + matching from-state transitions sorted, excluding deleted', () => {
    expect(workflowEngine.availableTransitions(def, { state_id: 'backlog' }).map((t) => t.key)).toEqual(['triage', 'start', 'complete', 'cancel', 'backlog']);
    expect(workflowEngine.availableTransitions(def, { state_id: 'prog' }).map((t) => t.key)).toEqual(['start', 'complete', 'cancel', 'approve', 'backlog']);
    expect(workflowEngine.availableTransitions(def, { state_id: 'cancel' }).map((t) => t.key)).toEqual(['start', 'complete', 'cancel', 'restore', 'backlog']);
  });
});

describe('evaluate', () => {
  it('passes guards and builds the patch with macros', () => {
    const r = workflowEngine.evaluate(def, item, 'start', ctx);
    expect(r.ok).toBe(true);
    expect(r.toState.id).toBe('prog');
    expect(r.patch).toEqual({ state_id: 'prog', start_date: '2026-10-15' });
    expect(r.deferredEffects).toEqual([]);
  });
  it('respects only_if_null', () => {
    const r = workflowEngine.evaluate(def, { ...item, start_date: '2026-01-02' }, 'start', ctx);
    expect(r.patch).toEqual({ state_id: 'prog' });
  });
  it('reports every failing guard with a reason', () => {
    const r = workflowEngine.evaluate(def, { ...item, assignee_id: null }, 'start', { ...ctx, openBlockerCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.guard.type)).toEqual(['require_field', 'no_open_blockers']);
    expect(r.failures[1]!.reason).toContain('2 open blockers');
    expect(workflowEngine.canTransition(def, { ...item, assignee_id: '' }, 'start', ctx)).toBe(false);
  });
  it('treats empty string / empty array as missing for require_field', () => {
    const g: Guard = { type: 'require_field', field: 'fields.tags' };
    expect(evaluateGuard(g, { ...item, fields: { tags: [] } }, ctx)).toMatch(/required/);
    expect(evaluateGuard(g, { ...item, fields: { tags: ['a'] } }, ctx)).toBeNull();
    expect(evaluateGuard({ type: 'require_field', field: 'title' }, { ...item, title: '' }, ctx)).toMatch(/required/);
  });
  it('children_in_category passes with no children and fails otherwise', () => {
    expect(workflowEngine.evaluate(def, item, 'complete', ctx).ok).toBe(true);
    expect(workflowEngine.evaluate(def, item, 'complete', { ...ctx, childrenCategories: ['done', 'canceled'] }).ok).toBe(true);
    const r = workflowEngine.evaluate(def, item, 'complete', { ...ctx, childrenCategories: ['done', 'in_progress'] });
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.reason).toContain('1 child item is not done/canceled');
  });
  it('defers non-field effects in order and resolves $now', () => {
    const r = workflowEngine.evaluate(def, item, 'complete', ctx);
    expect(r.patch).toEqual({ state_id: 'done', completed_at: '2026-10-15T12:34:56.000Z' });
    expect(r.deferredEffects.map((e) => e.type)).toEqual(['webhook', 'notify']);
  });
  it('require_role: admin passes, viewer fails, null role fails', () => {
    expect(workflowEngine.canTransition(def, item, 'cancel', { ...ctx, actorRole: 'admin' })).toBe(true);
    expect(workflowEngine.canTransition(def, item, 'cancel', { ...ctx, actorRole: 'viewer' })).toBe(false);
    expect(workflowEngine.canTransition(def, item, 'cancel', { ...ctx, actorRole: null })).toBe(false);
    const g = { type: 'require_role', roles: ['viewer'] } as const;
    expect(evaluateGuard(g, item, { ...ctx, actorRole: 'admin' })).toBeNull();
  });
  it('writes fields.* effects into a copied fields object', () => {
    const r = workflowEngine.evaluate(def, item, 'cancel', ctx);
    expect(r.patch.fields).toEqual({ approved: true, severity: 's1', existing: 1, reason: 'canceled by $actor', closed_by: 'alice' });
    expect(item.fields).toEqual({ approved: true, severity: 's1', existing: 1 });
    expect(r.patch.canceled_at).toBe(now.toISOString());
  });
  it('sets null values', () => {
    const r = workflowEngine.evaluate(def, { ...item, state_id: 'cancel', canceled_at: 'x' }, 'restore', ctx);
    expect(r.patch).toEqual({ state_id: 'todo', canceled_at: null });
  });
  it('field_equals / field_in / assignee / label guards', () => {
    const prog = { ...item, state_id: 'prog' };
    expect(workflowEngine.evaluate(def, prog, 'approve', ctx).ok).toBe(true);
    expect(workflowEngine.evaluate(def, { ...prog, fields: { approved: false, severity: 's1' } }, 'approve', ctx).failures.map((f) => f.guard.type)).toEqual(['field_equals']);
    expect(workflowEngine.evaluate(def, { ...prog, fields: { approved: true, severity: 's3' } }, 'approve', ctx).failures.map((f) => f.guard.type)).toEqual(['field_in']);
    expect(workflowEngine.evaluate(def, prog, 'approve', { ...ctx, actorId: 'bob' }).failures.map((f) => f.guard.type)).toEqual(['require_assignee_is_actor']);
    expect(workflowEngine.evaluate(def, prog, 'approve', { ...ctx, labelNames: [] }).failures.map((f) => f.guard.type)).toEqual(['require_label']);
    expect(workflowEngine.evaluate(def, prog, 'approve', ctx).deferredEffects[0]!.type).toBe('transition_parent_if');
  });
  it('fails (not throws) when the transition is not available from the current state', () => {
    const r = workflowEngine.evaluate(def, item, 'restore', ctx);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.reason).toMatch(/only available from state canceled/);
  });
  it('throws for unknown / deleted transitions', () => {
    expect(() => workflowEngine.evaluate(def, item, 'nope', ctx)).toThrow(/unknown transition/);
    expect(() => workflowEngine.evaluate(def, item, 'old', ctx)).toThrow(/unknown transition/);
    expect(workflowEngine.canTransition(def, item, 'nope', ctx)).toBe(false);
  });
  it('resolveEffectValue macros', () => {
    expect(resolveEffectValue('$today', ctx)).toBe('2026-10-15');
    expect(resolveEffectValue('$actor', ctx)).toBe('alice');
    expect(resolveEffectValue(undefined, ctx)).toBeNull();
    expect(resolveEffectValue(5, ctx)).toBe(5);
  });
});

describe('initialState / validateDefinition', () => {
  it('finds the initial state or throws', () => {
    expect(workflowEngine.initialState(def).id).toBe('todo');
    expect(() => workflowEngine.initialState({ ...def, states: def.states.map((s) => ({ ...s, is_initial: false })) })).toThrow(/no initial state/);
  });
  it('accepts a valid definition', () => {
    expect(workflowEngine.validateDefinition(def)).toEqual([]);
  });
  it('reports every problem', () => {
    const bad: WorkflowDefinition = {
      id: 'wf', key: 'bad',
      states: [st('a', 'a', 'todo', 0, true), st('b', 'a', 'todo', 1, true), st('c', 'c', 'in_progress', 2), st('d', 'd', 'in_progress', 3)],
      transitions: [tr('x', 'go', 'a', 'c'), tr('y', 'go', 'zzz', 'c'), tr('z', 'bad', 'a', 'nope')],
    };
    const errs = workflowEngine.validateDefinition(bad);
    expect(errs).toEqual(expect.arrayContaining([
      expect.stringMatching(/exactly one initial state \(found 2\)/),
      expect.stringMatching(/duplicate state key "a"/),
      expect.stringMatching(/duplicate transition key "go"/),
      expect.stringMatching(/starts from unknown state zzz/),
      expect.stringMatching(/targets unknown state nope/),
      expect.stringMatching(/done or canceled/),
    ]));
    const unreachable = workflowEngine.validateDefinition({ ...def, transitions: [tr('t1', 'triage', 'backlog', 'todo'), tr('t3', 'complete', 'todo', 'done')] });
    expect(unreachable).toEqual(['state "backlog" is not reachable from the initial state', 'state "in_progress" is not reachable from the initial state', 'state "canceled" is not reachable from the initial state']);
    expect(workflowEngine.validateDefinition({ id: 'e', key: 'e', states: [], transitions: [] })).toContain('workflow has no states');
  });
});
