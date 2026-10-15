// ============================================================================
// Workflow engine: pure evaluation of data-driven state machines.
// ============================================================================
import type { WorkflowDefinition, WorkflowEngine, GuardContext, GuardFailure, TransitionResult } from './types.js';
import type { WorkItem, WorkflowState, WorkflowTransition, Guard, Effect, StateCategory } from '../schema/entities.js';

function isNil(v: unknown): boolean { return v === null || v === undefined; }

/** Read `fields.x` or a column off an item. */
function readPath(item: WorkItem, field: string): unknown {
  if (field.startsWith('fields.')) {
    const v = item.fields?.[field.slice(7)];
    return v === undefined ? null : v;
  }
  const v = (item as unknown as Record<string, unknown>)[field];
  return v === undefined ? null : v;
}

function isMissing(v: unknown): boolean {
  return isNil(v) || v === '' || (Array.isArray(v) && v.length === 0);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined), bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

function liveStates(def: WorkflowDefinition): WorkflowState[] { return def.states.filter((s) => !s.deleted_at); }
function liveTransitions(def: WorkflowDefinition): WorkflowTransition[] { return def.transitions.filter((t) => !t.deleted_at); }

function describeGuard(g: Guard): string {
  switch (g.type) {
    case 'require_field': return `field ${g.field} is required`;
    case 'field_equals': return `field ${g.field} must equal ${JSON.stringify(g.value)}`;
    case 'field_in': return `field ${g.field} must be one of ${JSON.stringify(g.values)}`;
    case 'no_open_blockers': return 'item has open blockers';
    case 'children_in_category': return `all children must be in ${g.categories.join('/')}`;
    case 'require_role': return `requires project role ${g.roles.join(' or ')}`;
    case 'require_assignee_is_actor': return 'only the assignee can do this';
    case 'require_label': return `requires label "${g.label}"`;
  }
}

/** Evaluate one guard; returns a failure reason or null when it passes. */
export function evaluateGuard(guard: Guard, item: WorkItem, ctx: GuardContext): string | null {
  switch (guard.type) {
    case 'require_field': return isMissing(readPath(item, guard.field)) ? describeGuard(guard) : null;
    case 'field_equals': return deepEqual(readPath(item, guard.field), guard.value) ? null : describeGuard(guard);
    case 'field_in': { const v = readPath(item, guard.field); return guard.values.some((x) => deepEqual(v, x)) ? null : describeGuard(guard); }
    case 'no_open_blockers': return ctx.openBlockerCount > 0 ? `item has ${ctx.openBlockerCount} open blocker${ctx.openBlockerCount === 1 ? '' : 's'}` : null;
    case 'children_in_category': {
      const bad = ctx.childrenCategories.filter((c: StateCategory) => !guard.categories.includes(c));
      return bad.length ? `${bad.length} child item${bad.length === 1 ? ' is' : 's are'} not ${guard.categories.join('/')}` : null;
    }
    case 'require_role': {
      if (ctx.actorRole === 'admin') return null;
      return ctx.actorRole && guard.roles.includes(ctx.actorRole) ? null : describeGuard(guard);
    }
    case 'require_assignee_is_actor': return item.assignee_id === ctx.actorId ? null : describeGuard(guard);
    case 'require_label': {
      const want = guard.label.toLowerCase();
      return ctx.labelNames.some((l) => l.toLowerCase() === want) ? null : describeGuard(guard);
    }
    default: return `unknown guard type ${(guard as { type: string }).type}`;
  }
}

/** Resolve an effect value macro: $now (ISO), $today (YYYY-MM-DD), $actor, null. */
export function resolveEffectValue(value: unknown, ctx: GuardContext): unknown {
  if (value === '$now') return ctx.now.toISOString();
  if (value === '$today') return ctx.now.toISOString().slice(0, 10);
  if (value === '$actor') return ctx.actorId;
  return value === undefined ? null : value;
}

function availableTransitions(def: WorkflowDefinition, item: Pick<WorkItem, 'state_id'>): WorkflowTransition[] {
  return liveTransitions(def)
    .filter((t) => t.from_state_id === null || t.from_state_id === item.state_id)
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

function evaluate(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): TransitionResult {
  const transition = liveTransitions(def).find((t) => t.key === transitionKey);
  if (!transition) throw new Error(`unknown transition "${transitionKey}" in workflow ${def.key}`);
  const toState = liveStates(def).find((s) => s.id === transition.to_state_id);
  if (!toState) throw new Error(`transition "${transitionKey}" targets unknown state ${transition.to_state_id}`);

  const failures: GuardFailure[] = [];
  if (transition.from_state_id !== null && transition.from_state_id !== item.state_id) {
    const from = liveStates(def).find((s) => s.id === transition.from_state_id);
    failures.push({
      guard: { type: 'field_equals', field: 'state_id', value: transition.from_state_id },
      reason: `transition "${transition.name}" is only available from state ${from?.name ?? transition.from_state_id}`,
    });
  }
  for (const guard of transition.guards ?? []) {
    const reason = evaluateGuard(guard, item, ctx);
    if (reason) failures.push({ guard, reason });
  }

  const patch: Partial<WorkItem> = { state_id: toState.id };
  const deferredEffects: Effect[] = [];
  let fields: Record<string, unknown> | null = null;
  for (const effect of transition.effects ?? []) {
    if (effect.type !== 'set_field') { deferredEffects.push(effect); continue; }
    const current = effect.field.startsWith('fields.')
      ? (fields ?? item.fields ?? {})[effect.field.slice(7)]
      : (patch as Record<string, unknown>)[effect.field] ?? readPath(item, effect.field);
    if (effect.only_if_null && !isNil(current)) continue;
    const value = resolveEffectValue(effect.value, ctx);
    if (effect.field.startsWith('fields.')) {
      fields = fields ?? { ...(item.fields ?? {}) };
      fields[effect.field.slice(7)] = value;
    } else {
      (patch as Record<string, unknown>)[effect.field] = value;
    }
  }
  if (fields) patch.fields = fields;

  return { ok: failures.length === 0, transition, toState, failures, patch, deferredEffects };
}

function canTransition(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): boolean {
  try { return evaluate(def, item, transitionKey, ctx).ok; } catch { return false; }
}

function initialState(def: WorkflowDefinition): WorkflowState {
  const s = liveStates(def).find((x) => x.is_initial);
  if (!s) throw new Error(`workflow ${def.key} has no initial state`);
  return s;
}

function validateDefinition(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const states = liveStates(def);
  const transitions = liveTransitions(def);
  if (!states.length) errors.push('workflow has no states');
  const initial = states.filter((s) => s.is_initial);
  if (initial.length !== 1) errors.push(`workflow must have exactly one initial state (found ${initial.length})`);
  const seenState = new Set<string>();
  for (const s of states) {
    if (seenState.has(s.key)) errors.push(`duplicate state key "${s.key}"`);
    seenState.add(s.key);
  }
  const seenTr = new Set<string>();
  const stateIds = new Set(states.map((s) => s.id));
  for (const t of transitions) {
    if (seenTr.has(t.key)) errors.push(`duplicate transition key "${t.key}"`);
    seenTr.add(t.key);
    if (!stateIds.has(t.to_state_id)) errors.push(`transition "${t.key}" targets unknown state ${t.to_state_id}`);
    if (t.from_state_id !== null && !stateIds.has(t.from_state_id)) errors.push(`transition "${t.key}" starts from unknown state ${t.from_state_id}`);
  }
  if (!states.some((s) => s.category === 'done' || s.category === 'canceled')) errors.push('workflow needs at least one state in the done or canceled category');
  if (initial.length === 1 && states.length) {
    const reach = new Set<string>([initial[0]!.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of transitions) {
        if (!stateIds.has(t.to_state_id) || reach.has(t.to_state_id)) continue;
        if (t.from_state_id === null || reach.has(t.from_state_id)) { reach.add(t.to_state_id); changed = true; }
      }
    }
    for (const s of states) if (!reach.has(s.id)) errors.push(`state "${s.key}" is not reachable from the initial state`);
  }
  return errors;
}

export const workflowEngine: WorkflowEngine = { availableTransitions, evaluate, canTransition, initialState, validateDefinition };
