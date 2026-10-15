// Typed selectors over the local store. All memoized; all synchronous.
import { useContext, useMemo } from 'react';
import type { Comment, EvalLookups, ItemRow, ItemType, Label, Notification, Project, ProjectRole, Relation, User, View, ItemWatcher, ProjectMember, WorkflowTransition, GuardContext, StateCategory, QueryContext } from '@pm/core';
import { permissions, workflowEngine } from '@pm/core';
import { StoreContext, type Store, type WorkflowGroup } from './provider';
import { useSession } from '../session';
import { isUuid, isDone } from '../lib/util';

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

export const useAllItems = (): ItemRow[] => useStore().items;

export function useItem(idOrKey: string | null | undefined): ItemRow | undefined {
  const { itemsById, itemByKey } = useStore();
  if (!idOrKey) return undefined;
  return isUuid(idOrKey) ? itemsById[idOrKey] : itemByKey[idOrKey.toUpperCase()] ?? itemByKey[idOrKey];
}

export const useProjects = (): Project[] => useStore().projects;
export const useProject = (key: string | undefined): Project | undefined => {
  const { projectByKey, projectsById } = useStore();
  if (!key) return undefined;
  return projectByKey[key] ?? projectByKey[key.toUpperCase()] ?? projectsById[key];
};
export const useTypes = (): ItemType[] => useStore().types;
export const useWorkflows = (): WorkflowGroup[] => useStore().workflows;
export const useUsers = (): User[] => useStore().users;
export const useLabels = (): Label[] => useStore().labels;
export const useLookups = (): EvalLookups => useStore().lookups;
export const useNotifications = (): Notification[] => useStore().notifications;

export function useViews(projectId: string | null | undefined): View[] {
  const { views } = useStore();
  return useMemo(() => views.filter((v) => (projectId === undefined ? true : v.project_id === projectId)), [views, projectId]);
}

export function useComments(itemId: string | undefined): Comment[] {
  const { commentsByItem } = useStore();
  return (itemId && commentsByItem[itemId]) || EMPTY_ARR;
}

export function useRelations(itemId: string | undefined): Relation[] {
  const { relationsByItem } = useStore();
  return (itemId && relationsByItem[itemId]) || EMPTY_ARR;
}

export function useChildren(itemId: string | undefined): ItemRow[] {
  const { childrenByItem, itemsById } = useStore();
  return useMemo(() => {
    if (!itemId) return [];
    return (childrenByItem[itemId] ?? []).map((id) => itemsById[id]).filter((x): x is ItemRow => !!x);
  }, [childrenByItem, itemsById, itemId]);
}

export function useWatchers(itemId: string | undefined): ItemWatcher[] {
  const { watchersByItem } = useStore();
  return (itemId && watchersByItem[itemId]) || EMPTY_ARR;
}

export function useMembers(projectId: string | undefined): ProjectMember[] {
  const { membersByProject } = useStore();
  return (projectId && membersByProject[projectId]) || EMPTY_ARR;
}

export function useProjectLabels(projectId: string | null | undefined): Label[] {
  const { labels } = useStore();
  return useMemo(() => labels.filter((l) => l.project_id === null || l.project_id === projectId), [labels, projectId]);
}

/** Types allowed in a project (allowed_type_ids or all active). */
export function useProjectTypes(project: Project | undefined): ItemType[] {
  const { types } = useStore();
  return useMemo(() => {
    const active = types.filter((t) => t.is_active);
    if (!project?.allowed_type_ids?.length) return active;
    const allowed = new Set(project.allowed_type_ids);
    return active.filter((t) => allowed.has(t.id));
  }, [types, project]);
}

export function useWorkflowForType(typeId: string | undefined): WorkflowGroup | undefined {
  const { typesById, workflowsById } = useStore();
  const t = typeId ? typesById[typeId] : undefined;
  return t ? workflowsById[t.workflow_id] : undefined;
}

export function useQueryContext(): QueryContext {
  const { me } = useSession();
  const tz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  return useMemo(() => ({ userId: me?.user.id ?? '', tz, visibleProjectIds: 'all' as const }), [me?.user.id, tz]);
}

/** Effective project role of the current user, via @pm/core permissions (falls back to the local rule). */
export function useEffectiveRole(projectId: string | undefined): ProjectRole | null {
  const { actor, me } = useSession();
  const { projectsById, membersByProject } = useStore();
  return useMemo(() => {
    if (!actor || !projectId) return null;
    const project = projectsById[projectId];
    if (!project) return null;
    const membership = (membersByProject[projectId] ?? []).find((m) => m.user_id === actor.id);
    try {
      return permissions.effectiveRole({ ...actor, memberships: membership ? { ...actor.memberships, [projectId]: membership.role } : actor.memberships }, { id: project.id, visibility: project.visibility });
    } catch {
      const fr = me?.user.firm_role;
      if (fr === 'owner' || fr === 'admin') return 'admin';
      if (membership) return membership.role;
      if (project.visibility === 'firm' && fr === 'member') return 'editor';
      return null;
    }
  }, [actor, me, projectId, projectsById, membersByProject]);
}

export function useIsFirmAdmin(): boolean {
  const { me } = useSession();
  return me?.user.firm_role === 'owner' || me?.user.firm_role === 'admin';
}

/** Best-effort GuardContext for an item from local data (same as the mutator computes). */
export function useGuardContext(item: ItemRow | undefined): GuardContext | null {
  const { relationsByItem, itemsById, statesById, labelIdsByItem, labelsById, childrenByItem } = useStore();
  const { me } = useSession();
  const role = useEffectiveRole(item?.project_id);
  return useMemo(() => {
    if (!item || !me) return null;
    let openBlockerCount = 0;
    for (const r of relationsByItem[item.id] ?? []) {
      if (r.type === 'blocks' && r.to_item_id === item.id) {
        const blocker = itemsById[r.from_item_id];
        if (blocker && !isDone(statesById[blocker.state_id]?.category)) openBlockerCount++;
      }
    }
    const childrenCategories = (childrenByItem[item.id] ?? [])
      .map((id) => itemsById[id] && statesById[itemsById[id]!.state_id]?.category)
      .filter((c): c is StateCategory => !!c);
    const labelNames = (labelIdsByItem[item.id] ?? []).map((id) => labelsById[id]?.name).filter((n): n is string => !!n);
    return { actorId: me.user.id, actorRole: role, now: new Date(), openBlockerCount, childrenCategories, labelNames };
  }, [item, me, role, relationsByItem, itemsById, statesById, labelIdsByItem, labelsById, childrenByItem]);
}

export interface TransitionOption {
  transition: WorkflowTransition;
  toState: { id: string; name: string; category: StateCategory; color: string | null };
  allowed: boolean;
  failures: string[];
}

/** Available transitions for an item with guard evaluation (for buttons / menus). */
export function useTransitions(item: ItemRow | undefined): TransitionOption[] {
  const wf = useWorkflowForType(item?.type_id);
  const ctx = useGuardContext(item);
  return useMemo(() => {
    if (!item || !wf || !ctx) return [];
    let available: WorkflowTransition[];
    try {
      available = workflowEngine.availableTransitions(wf, item);
    } catch {
      available = wf.transitions.filter((t) => t.from_state_id === null || t.from_state_id === item.state_id);
    }
    return available
      .filter((t) => t.to_state_id !== item.state_id)
      .map((t) => {
        const toState = wf.statesById[t.to_state_id];
        let allowed = true;
        let failures: string[] = [];
        try {
          const r = workflowEngine.evaluate(wf, item, t.key, ctx);
          allowed = r.ok;
          failures = r.failures.map((f) => f.reason);
        } catch (e) {
          allowed = true;
          failures = [];
          void e;
        }
        return {
          transition: t,
          toState: { id: t.to_state_id, name: toState?.name ?? '?', category: toState?.category ?? 'todo', color: toState?.color ?? null },
          allowed,
          failures,
        };
      });
  }, [item, wf, ctx]);
}

export function useUnreadCount(): number {
  const n = useNotifications();
  return useMemo(() => n.filter((x) => !x.read_at).length, [n]);
}

const EMPTY_ARR: never[] = [];
