// The whole app's read path: one Replicache subscription per synced table,
// memoized derived maps. Navigation never fetches.
import { createContext, useMemo, type ReactNode } from 'react';
import type { ReadTransaction } from 'replicache';
import type {
  User, Team, Workflow, WorkflowState, WorkflowTransition, ItemType, Project, ProjectMember, WorkItem, Label, WorkItemLabel,
  Comment, Relation, View, ItemWatcher, Notification, NotificationPreference, SyncedTable, ItemRow, EvalLookups, WorkflowDefinition,
} from '@pm/core';
import { useSubscribe } from '../sync/context';
import { useSession } from '../session';
import { isDone } from '../lib/util';

export interface WorkflowGroup extends WorkflowDefinition {
  name: string;
  description: string | null;
  statesById: Record<string, WorkflowState>;
}

export interface Store {
  ready: boolean;
  users: User[];
  usersById: Record<string, User>;
  teams: Team[];
  projects: Project[];
  projectsById: Record<string, Project>;
  projectByKey: Record<string, Project>;
  members: ProjectMember[];
  membersByProject: Record<string, ProjectMember[]>;
  types: ItemType[];
  typesById: Record<string, ItemType>;
  workflows: WorkflowGroup[];
  workflowsById: Record<string, WorkflowGroup>;
  statesById: Record<string, WorkflowState>;
  items: ItemRow[];
  itemsById: Record<string, ItemRow>;
  itemByKey: Record<string, ItemRow>;
  labels: Label[];
  labelsById: Record<string, Label>;
  labelIdsByItem: Record<string, string[]>;
  comments: Comment[];
  commentsByItem: Record<string, Comment[]>;
  relations: Relation[];
  relationsByItem: Record<string, Relation[]>;
  childrenByItem: Record<string, string[]>;
  parentByItem: Record<string, string>;
  views: View[];
  watchers: ItemWatcher[];
  watchersByItem: Record<string, ItemWatcher[]>;
  notifications: Notification[];
  preferences: NotificationPreference[];
  lookups: EvalLookups;
}

export const StoreContext = createContext<Store | null>(null);

const EMPTY: never[] = [];

function tableQuery<T>(table: SyncedTable) {
  return async (tx: ReadTransaction): Promise<T[]> => {
    const out: T[] = [];
    for await (const v of tx.scan({ prefix: `${table}/` })) out.push(v as T);
    return out;
  };
}

function useTable<T extends { deleted_at: string | null }>(table: SyncedTable): T[] | null {
  const { rep } = useSession();
  const q = useMemo(() => tableQuery<T>(table), [table]);
  const rows = useSubscribe<T[] | null>(rep, q, null, []);
  return useMemo(() => (rows ? rows.filter((r) => !r.deleted_at) : null), [rows]);
}

function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of rows) out[r.id] = r;
  return out;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const users = useTable<User>('users');
  const teams = useTable<Team>('teams');
  const workflowsRaw = useTable<Workflow>('workflows');
  const states = useTable<WorkflowState>('workflow_states');
  const transitions = useTable<WorkflowTransition>('workflow_transitions');
  const types = useTable<ItemType>('item_types');
  const projects = useTable<Project>('projects');
  const members = useTable<ProjectMember>('project_members');
  const workItems = useTable<WorkItem>('work_items');
  const labels = useTable<Label>('labels');
  const itemLabels = useTable<WorkItemLabel>('work_item_labels');
  const comments = useTable<Comment>('comments');
  const relations = useTable<Relation>('relations');
  const views = useTable<View>('views');
  const watchers = useTable<ItemWatcher>('item_watchers');
  const notifications = useTable<Notification>('notifications');
  const preferences = useTable<NotificationPreference>('notification_preferences');

  const ready = [users, workflowsRaw, states, transitions, types, projects, workItems].every((t) => t !== null);

  const usersById = useMemo(() => byId(users ?? EMPTY), [users]);
  const projectsSorted = useMemo(() => [...(projects ?? EMPTY)].sort((a, b) => a.key.localeCompare(b.key)), [projects]);
  const projectsById = useMemo(() => byId(projectsSorted), [projectsSorted]);
  const projectByKey = useMemo(() => {
    const out: Record<string, Project> = {};
    for (const p of projectsSorted) out[p.key] = p;
    return out;
  }, [projectsSorted]);
  const membersByProject = useMemo(() => {
    const out: Record<string, ProjectMember[]> = {};
    for (const m of members ?? EMPTY) (out[m.project_id] ??= []).push(m);
    return out;
  }, [members]);
  const typesSorted = useMemo(() => [...(types ?? EMPTY)].sort((a, b) => a.sort - b.sort), [types]);
  const typesById = useMemo(() => byId(typesSorted), [typesSorted]);
  const statesById = useMemo(() => byId(states ?? EMPTY), [states]);

  const workflows = useMemo<WorkflowGroup[]>(() => {
    return (workflowsRaw ?? EMPTY).map((w) => {
      const s = (states ?? EMPTY).filter((x) => x.workflow_id === w.id).sort((a, b) => a.sort - b.sort);
      const t = (transitions ?? EMPTY).filter((x) => x.workflow_id === w.id).sort((a, b) => a.sort - b.sort);
      return { id: w.id, key: w.key, name: w.name, description: w.description, states: s, transitions: t, statesById: byId(s) };
    });
  }, [workflowsRaw, states, transitions]);
  const workflowsById = useMemo(() => byId(workflows), [workflows]);

  const labelsSorted = useMemo(() => [...(labels ?? EMPTY)].sort((a, b) => a.name.localeCompare(b.name)), [labels]);
  const labelsById = useMemo(() => byId(labelsSorted), [labelsSorted]);
  const labelIdsByItem = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const l of itemLabels ?? EMPTY) {
      if (!labelsById[l.label_id]) continue;
      (out[l.item_id] ??= []).push(l.label_id);
    }
    return out;
  }, [itemLabels, labelsById]);

  const relationsSorted = useMemo(() => relations ?? EMPTY, [relations]);
  const { relationsByItem, childrenByItem, parentByItem } = useMemo(() => {
    const relationsByItem: Record<string, Relation[]> = {};
    const childrenByItem: Record<string, string[]> = {};
    const parentByItem: Record<string, string> = {};
    for (const r of relationsSorted) {
      (relationsByItem[r.from_item_id] ??= []).push(r);
      if (r.to_item_id) (relationsByItem[r.to_item_id] ??= []).push(r);
      if (r.type === 'parent_of' && r.to_item_id) {
        (childrenByItem[r.from_item_id] ??= []).push(r.to_item_id);
        parentByItem[r.to_item_id] = r.from_item_id;
      }
    }
    return { relationsByItem, childrenByItem, parentByItem };
  }, [relationsSorted]);

  const rawById = useMemo(() => byId(workItems ?? EMPTY), [workItems]);
  const blockedItems = useMemo(() => {
    const set = new Set<string>();
    for (const r of relationsSorted) {
      if (r.type !== 'blocks' || !r.to_item_id) continue;
      const blocker = rawById[r.from_item_id];
      if (!blocker) continue;
      const cat = statesById[blocker.state_id]?.category;
      if (!isDone(cat)) set.add(r.to_item_id);
    }
    return set;
  }, [relationsSorted, rawById, statesById]);

  const items = useMemo<ItemRow[]>(() => {
    return (workItems ?? EMPTY).map((w) => ({
      ...w,
      state_category: statesById[w.state_id]?.category,
      state_key: statesById[w.state_id]?.key,
      type_key: typesById[w.type_id]?.key,
      project_key: projectsById[w.project_id]?.key,
      state_name: statesById[w.state_id]?.name,
      type_name: typesById[w.type_id]?.name,
      project_name: projectsById[w.project_id]?.name,
      assignee_name: w.assignee_id ? (usersById[w.assignee_id]?.name ?? null) : null,
      label_ids: labelIdsByItem[w.id] ?? [],
      label_names: (labelIdsByItem[w.id] ?? []).map((id) => labelsById[id]?.name).filter((n): n is string => !!n),
      parent_id: parentByItem[w.id] ?? null,
      is_blocked: blockedItems.has(w.id),
    }));
  }, [workItems, statesById, typesById, projectsById, usersById, labelIdsByItem, labelsById, parentByItem, blockedItems]);
  const itemsById = useMemo(() => byId(items), [items]);
  const itemByKey = useMemo(() => {
    const out: Record<string, ItemRow> = {};
    for (const i of items) if (i.number > 0) out[i.key] = i;
    return out;
  }, [items]);

  const commentsSorted = useMemo(() => [...(comments ?? EMPTY)].sort((a, b) => a.created_at.localeCompare(b.created_at)), [comments]);
  const commentsByItem = useMemo(() => {
    const out: Record<string, Comment[]> = {};
    for (const c of commentsSorted) (out[c.item_id] ??= []).push(c);
    return out;
  }, [commentsSorted]);

  const watchersByItem = useMemo(() => {
    const out: Record<string, ItemWatcher[]> = {};
    for (const w of watchers ?? EMPTY) (out[w.item_id] ??= []).push(w);
    return out;
  }, [watchers]);

  const viewsSorted = useMemo(() => [...(views ?? EMPTY)].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)), [views]);
  const notificationsSorted = useMemo(
    () => [...(notifications ?? EMPTY)].filter((n) => !n.archived_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [notifications],
  );

  const lookups = useMemo<EvalLookups>(
    () => ({ states: statesById, types: typesById, projects: projectsById, labels: labelsById, users: usersById, labelIdsByItem, parentByItem, blockedItems }),
    [statesById, typesById, projectsById, labelsById, usersById, labelIdsByItem, parentByItem, blockedItems],
  );

  const store = useMemo<Store>(
    () => ({
      ready,
      users: users ?? EMPTY,
      usersById,
      teams: teams ?? EMPTY,
      projects: projectsSorted,
      projectsById,
      projectByKey,
      members: members ?? EMPTY,
      membersByProject,
      types: typesSorted,
      typesById,
      workflows,
      workflowsById,
      statesById,
      items,
      itemsById,
      itemByKey,
      labels: labelsSorted,
      labelsById,
      labelIdsByItem,
      comments: commentsSorted,
      commentsByItem,
      relations: relationsSorted,
      relationsByItem,
      childrenByItem,
      parentByItem,
      views: viewsSorted,
      watchers: watchers ?? EMPTY,
      watchersByItem,
      notifications: notificationsSorted,
      preferences: preferences ?? EMPTY,
      lookups,
    }),
    [
      ready, users, usersById, teams, projectsSorted, projectsById, projectByKey, members, membersByProject, typesSorted, typesById,
      workflows, workflowsById, statesById, items, itemsById, itemByKey, labelsSorted, labelsById, labelIdsByItem, commentsSorted,
      commentsByItem, relationsSorted, relationsByItem, childrenByItem, parentByItem, viewsSorted, watchers, watchersByItem,
      notificationsSorted, preferences, lookups,
    ],
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
