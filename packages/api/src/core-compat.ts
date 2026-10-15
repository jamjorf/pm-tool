// ============================================================================
// Thin wrappers around @pm/core. The real implementations are the contract;
// the fallbacks below only kick in while core still exports stubs that throw
// 'not implemented' (concurrent build-out), so this package stays testable.
// ============================================================================
import * as core from '@pm/core';
import type {
  Actor, Action, Resource, ProjectCtx, ProjectRole, FieldDef, WorkItem, ActivityEvent, EventKind, FieldChange,
  WorkflowDefinition, GuardContext, TransitionResult, WorkflowTransition, WorkflowState, Guard, Effect,
} from '@pm/core';
import { ACTION_MIN_ROLE, ROLE_RANK, PermissionError, TRACKED_ITEM_FIELDS } from '@pm/core';

const isStub = (e: unknown) => e instanceof Error && /not implemented/i.test(e.message);

function withFallback<A extends unknown[], R>(fn: (...a: A) => R, fallback: (...a: A) => R): (...a: A) => R {
  return (...a: A) => {
    try {
      return fn(...a);
    } catch (e) {
      if (isStub(e)) return fallback(...a);
      throw e;
    }
  };
}

// ---- events ---------------------------------------------------------------
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffItemFallback(before: Partial<WorkItem>, after: Partial<WorkItem>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of TRACKED_ITEM_FIELDS) {
    const o = (before as any)[f], n = (after as any)[f];
    if (!eq(o, n)) out.push({ field: f, old: o ?? null, new: n ?? null });
  }
  const bf = (before.fields ?? {}) as Record<string, unknown>, af = (after.fields ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(bf), ...Object.keys(af)])) {
    if (!eq(bf[k], af[k])) out.push({ field: `fields.${k}`, old: bf[k] ?? null, new: af[k] ?? null });
  }
  return out;
}
export const diffItem = withFallback(core.diffItem, diffItemFallback);

function eventKindOfFallback(e: Pick<ActivityEvent, 'entity_type' | 'action' | 'field'>): EventKind | null {
  const { entity_type: t, action: a } = e;
  if (t === 'work_item') {
    if (a === 'create') return 'item.created';
    if (a === 'delete') return 'item.deleted';
    if (a === 'restore') return 'item.restored';
    if (a === 'transition') return 'item.transitioned';
    if (a === 'update') return 'item.updated';
    return null;
  }
  if (t === 'comment') return a === 'create' || a === 'comment' ? 'comment.created' : a === 'update' ? 'comment.updated' : a === 'delete' ? 'comment.deleted' : null;
  if (t === 'relation') return a === 'relation_add' || a === 'create' ? 'relation.added' : a === 'relation_remove' || a === 'delete' ? 'relation.removed' : null;
  if (t === 'project') return a === 'create' ? 'project.created' : 'project.updated';
  return null;
}
export const eventKindOf = withFallback(core.eventKindOf, eventKindOfFallback);

export const extractMentions = withFallback(core.extractMentions, (md: string) => {
  const out = new Set<string>();
  for (const m of md.matchAll(/@\[[^\]]*\]\(user:([0-9a-fA-F-]{36})\)/g)) out.add(m[1]!.toLowerCase());
  return [...out];
});

export const extractItemKeys = withFallback(core.extractItemKeys, (text: string) => {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g)) out.add(m[1]!);
  return [...out];
});

// ---- fields ---------------------------------------------------------------
type ValidateResult = { ok: true; value: Record<string, unknown> } | { ok: false; errors: { field: string; message: string }[] };
function validateFieldsFallback(defs: FieldDef[], fields: Record<string, unknown>): ValidateResult {
  const errors: { field: string; message: string }[] = [];
  const value: Record<string, unknown> = {};
  const known = new Set(defs.map((d) => d.key));
  for (const k of Object.keys(fields)) if (!known.has(k)) errors.push({ field: k, message: 'unknown field' });
  for (const d of defs) {
    const v = fields[d.key];
    if (v === undefined || v === null || v === '') {
      if (d.required) errors.push({ field: d.key, message: 'required' });
      else if (v === null) value[d.key] = null;
      continue;
    }
    const multi = d.multi || d.kind === 'multi_select';
    const items = multi ? (Array.isArray(v) ? v : [v]) : [v];
    if (multi && !Array.isArray(v)) { errors.push({ field: d.key, message: 'must be an array' }); continue; }
    for (const it of items) {
      switch (d.kind) {
        case 'number': if (typeof it !== 'number' || Number.isNaN(it)) errors.push({ field: d.key, message: 'must be a number' }); break;
        case 'bool': if (typeof it !== 'boolean') errors.push({ field: d.key, message: 'must be a boolean' }); break;
        case 'select': case 'multi_select':
          if (typeof it !== 'string') errors.push({ field: d.key, message: 'must be a string' });
          else if (d.options && !d.options.some((o) => o.value === it)) errors.push({ field: d.key, message: `invalid option "${it}"` });
          break;
        case 'date': if (typeof it !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it)) errors.push({ field: d.key, message: 'must be YYYY-MM-DD' }); break;
        default: if (typeof it !== 'string') errors.push({ field: d.key, message: 'must be a string' });
      }
    }
    value[d.key] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
export const validateFields = withFallback(core.validateFields, validateFieldsFallback);

// ---- permissions ----------------------------------------------------------
function effectiveRoleFallback(actor: Actor, project: ProjectCtx): ProjectRole | null {
  const explicit = actor.memberships[project.id];
  if (explicit) return explicit;
  if (actor.firmRole === 'owner' || actor.firmRole === 'admin') return 'admin';
  if (actor.firmRole === 'member' && project.visibility === 'firm') return 'editor';
  return null;
}
function canFallback(actor: Actor, action: Action, resource?: Resource): boolean {
  if (actor.scopes && action !== 'item.view' && action !== 'project.view' && action !== 'activity.view' && action !== 'export' && !actor.scopes.includes('write')) return false;
  const min = ACTION_MIN_ROLE[action];
  const firmAdmin = actor.firmRole === 'owner' || actor.firmRole === 'admin';
  if (min === 'firm_admin') return firmAdmin;
  if (min === 'any_user') return actor.firmRole !== 'guest';
  const project = resource?.project ?? resource?.item?.project;
  if (!project) return firmAdmin || actor.firmRole === 'member';
  const role = effectiveRoleFallback(actor, project);
  if (!role) return false;
  if (resource?.item?.confidential) {
    const it = resource.item;
    const privileged = role === 'admin' || it.assignee_id === actor.id || it.reporter_id === actor.id || it.created_by === actor.id;
    if (!privileged) return false;
  }
  if (action.endsWith('_own') && resource?.ownerId !== undefined && resource.ownerId !== actor.id) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
export const permissions = {
  effectiveRole: withFallback(core.permissions.effectiveRole.bind(core.permissions), effectiveRoleFallback),
  can: withFallback(core.permissions.can.bind(core.permissions), canFallback),
  assert: withFallback(core.permissions.assert.bind(core.permissions), (actor: Actor, action: Action, resource?: Resource) => {
    if (!canFallback(actor, action, resource)) throw new PermissionError(action);
  }),
};

// ---- workflow engine ------------------------------------------------------
function getPath(item: WorkItem, field: string): unknown {
  if (field.startsWith('fields.')) return (item.fields as any)?.[field.slice(7)];
  return (item as any)[field];
}
const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function availableFallback(def: WorkflowDefinition, item: Pick<WorkItem, 'state_id'>): WorkflowTransition[] {
  return def.transitions
    .filter((t) => !t.deleted_at && (t.from_state_id === null || t.from_state_id === item.state_id) && t.to_state_id !== item.state_id)
    .sort((a, b) => a.sort - b.sort);
}
function evalGuard(g: Guard, item: WorkItem, ctx: GuardContext): string | null {
  switch (g.type) {
    case 'require_field': return empty(getPath(item, g.field)) ? `${g.field} is required` : null;
    case 'field_equals': return eq(getPath(item, g.field), g.value) ? null : `${g.field} must equal ${JSON.stringify(g.value)}`;
    case 'field_in': return g.values.some((v) => eq(v, getPath(item, g.field))) ? null : `${g.field} must be one of ${JSON.stringify(g.values)}`;
    case 'no_open_blockers': return ctx.openBlockerCount > 0 ? `${ctx.openBlockerCount} open blocker(s)` : null;
    case 'children_in_category': return ctx.childrenCategories.every((c) => g.categories.includes(c)) ? null : `all children must be ${g.categories.join('/')}`;
    case 'require_role': return ctx.actorRole && g.roles.includes(ctx.actorRole) ? null : `requires role ${g.roles.join('/')}`;
    case 'require_assignee_is_actor': return item.assignee_id === ctx.actorId ? null : 'only the assignee may do this';
    case 'require_label': return ctx.labelNames.includes(g.label) ? null : `label "${g.label}" required`;
    default: return null;
  }
}
function resolveEffectValue(v: unknown, ctx: GuardContext): unknown {
  if (v === '$now') return ctx.now.toISOString();
  if (v === '$today') return ctx.now.toISOString().slice(0, 10);
  if (v === '$actor') return ctx.actorId;
  return v;
}
function evaluateFallback(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): TransitionResult {
  const transition = def.transitions.find((t) => t.key === transitionKey && !t.deleted_at);
  if (!transition) throw new Error(`unknown transition "${transitionKey}"`);
  const toState = def.states.find((s) => s.id === transition.to_state_id);
  if (!toState) throw new Error(`transition "${transitionKey}" targets unknown state`);
  const failures: { guard: Guard; reason: string }[] = [];
  if (transition.from_state_id !== null && transition.from_state_id !== item.state_id) {
    failures.push({ guard: { type: 'field_equals', field: 'state_id', value: transition.from_state_id }, reason: 'transition not available from current state' });
  }
  for (const g of transition.guards) {
    const r = evalGuard(g, item, ctx);
    if (r) failures.push({ guard: g, reason: r });
  }
  const patch: Partial<WorkItem> = { state_id: toState.id };
  const deferred: Effect[] = [];
  for (const e of transition.effects) {
    if (e.type === 'set_field') {
      if (e.only_if_null && !empty(getPath(item, e.field))) continue;
      const val = resolveEffectValue(e.value, ctx);
      if (e.field.startsWith('fields.')) patch.fields = { ...(patch.fields ?? item.fields ?? {}), [e.field.slice(7)]: val };
      else (patch as any)[e.field] = val;
    } else deferred.push(e);
  }
  return { ok: failures.length === 0, transition, toState, failures, patch, deferredEffects: deferred };
}
export const workflowEngine = {
  availableTransitions: withFallback(core.workflowEngine.availableTransitions.bind(core.workflowEngine), availableFallback),
  evaluate: withFallback(core.workflowEngine.evaluate.bind(core.workflowEngine), evaluateFallback),
  canTransition: withFallback(core.workflowEngine.canTransition.bind(core.workflowEngine), (d: WorkflowDefinition, i: WorkItem, k: string, c: GuardContext) => evaluateFallback(d, i, k, c).ok),
  initialState: withFallback(core.workflowEngine.initialState.bind(core.workflowEngine), (def: WorkflowDefinition): WorkflowState => {
    const s = def.states.find((x) => x.is_initial && !x.deleted_at) ?? def.states[0];
    if (!s) throw new Error('workflow has no states');
    return s;
  }),
  validateDefinition: withFallback(core.workflowEngine.validateDefinition.bind(core.workflowEngine), (def: WorkflowDefinition): string[] => {
    const errs: string[] = [];
    const states = def.states.filter((s) => !s.deleted_at);
    if (states.filter((s) => s.is_initial).length !== 1) errs.push('exactly one initial state is required');
    const keys = new Set<string>();
    for (const s of states) { if (keys.has(s.key)) errs.push(`duplicate state key ${s.key}`); keys.add(s.key); }
    const ids = new Set(states.map((s) => s.id));
    const tkeys = new Set<string>();
    for (const t of def.transitions.filter((x) => !x.deleted_at)) {
      if (tkeys.has(t.key)) errs.push(`duplicate transition key ${t.key}`); tkeys.add(t.key);
      if (!ids.has(t.to_state_id)) errs.push(`transition ${t.key} targets unknown state`);
      if (t.from_state_id && !ids.has(t.from_state_id)) errs.push(`transition ${t.key} starts from unknown state`);
    }
    for (const s of states) {
      if (!s.is_initial && !def.transitions.some((t) => !t.deleted_at && t.to_state_id === s.id)) errs.push(`state ${s.key} is unreachable`);
    }
    return errs;
  }),
};
