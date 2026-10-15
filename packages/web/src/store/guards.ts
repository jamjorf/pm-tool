// Non-hook guard helpers over a Store snapshot (used where hooks cannot run, e.g. drag/drop handlers).
import { permissions, workflowEngine, type GuardContext, type ItemRow, type ProjectRole, type StateCategory, type TransitionResult, type WorkflowTransition } from '@pm/core';
import type { Me } from '../api';
import type { Store } from './provider';
import { isDone } from '../lib/util';

export function effectiveRoleFromStore(store: Store, me: Me | null, projectId: string): ProjectRole | null {
  if (!me) return null;
  const project = store.projectsById[projectId];
  if (!project) return null;
  const membership = (store.membersByProject[projectId] ?? []).find((m) => m.user_id === me.user.id);
  const memberships: Record<string, ProjectRole> = {};
  for (const m of me.memberships) memberships[m.project_id] = m.role;
  if (membership) memberships[projectId] = membership.role;
  try {
    return permissions.effectiveRole({ id: me.user.id, firmRole: me.user.firm_role, memberships }, { id: project.id, visibility: project.visibility });
  } catch {
    const fr = me.user.firm_role;
    if (fr === 'owner' || fr === 'admin') return 'admin';
    if (membership) return membership.role;
    if (project.visibility === 'firm' && fr === 'member') return 'editor';
    return null;
  }
}

export function guardContextFromStore(store: Store, me: Me, item: ItemRow): GuardContext {
  let openBlockerCount = 0;
  for (const r of store.relationsByItem[item.id] ?? []) {
    if (r.type === 'blocks' && r.to_item_id === item.id) {
      const blocker = store.itemsById[r.from_item_id];
      if (blocker && !isDone(store.statesById[blocker.state_id]?.category)) openBlockerCount++;
    }
  }
  const childrenCategories = (store.childrenByItem[item.id] ?? [])
    .map((id) => store.itemsById[id] && store.statesById[store.itemsById[id]!.state_id]?.category)
    .filter((c): c is StateCategory => !!c);
  const labelNames = (store.labelIdsByItem[item.id] ?? []).map((id) => store.labelsById[id]?.name).filter((n): n is string => !!n);
  return { actorId: me.user.id, actorRole: effectiveRoleFromStore(store, me, item.project_id), now: new Date(), openBlockerCount, childrenCategories, labelNames };
}

/** Find the transition from the item's state to `toStateId` and evaluate its guards. */
export function evaluateMoveToState(store: Store, me: Me, item: ItemRow, toStateId: string): { transition: WorkflowTransition; result: TransitionResult | null } | null {
  const type = store.typesById[item.type_id];
  const wf = type ? store.workflowsById[type.workflow_id] : undefined;
  if (!wf) return null;
  let available: WorkflowTransition[];
  try { available = workflowEngine.availableTransitions(wf, item); } catch { available = wf.transitions.filter((t) => !t.from_state_id || t.from_state_id === item.state_id); }
  const candidates = available.filter((t) => t.to_state_id === toStateId);
  if (candidates.length === 0) return null;
  const ctx = guardContextFromStore(store, me, item);
  let best: { transition: WorkflowTransition; result: TransitionResult | null } | null = null;
  for (const t of candidates) {
    try {
      const r = workflowEngine.evaluate(wf, item, t.key, ctx);
      if (r.ok) return { transition: t, result: r };
      best ??= { transition: t, result: r };
    } catch {
      return { transition: t, result: null };
    }
  }
  return best;
}
