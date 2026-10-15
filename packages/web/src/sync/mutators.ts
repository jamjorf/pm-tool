// Replicache mutators: one per key of MutationArgs. Each validates args with the
// zod schema and applies the optimistic local write that mirrors the server.
// KV key for every row = rowKey(table, row) from @pm/core.
import type { ReadonlyJSONValue, ReadTransaction, WriteTransaction } from 'replicache';
import {
  MutationArgs,
  rowKey,
  workflowEngine,
  permissions,
  type MutationArgsOf,
  type MutationName,
  type SyncedTable,
  type WorkItem,
  type WorkflowState,
  type WorkflowTransition,
  type Project,
  type ItemType,
  type Label,
  type WorkItemLabel,
  type Relation,
  type Comment,
  type ItemWatcher,
  type Notification,
  type View,
  type ProjectMember,
  type User,
  type Workflow,
  type NotificationPreference,
  type WorkflowDefinition,
  type GuardContext,
  type GuardFailure,
  type StateCategory,
  type ProjectRole,
  type Effect,
} from '@pm/core';
import { nowIso, uuid } from '../lib/util';

export type Mutators = { [N in MutationName]: (tx: WriteTransaction, args: MutationArgsOf<N>) => Promise<void> };

export class GuardError extends Error {
  constructor(public readonly failures: GuardFailure[]) {
    super(failures.map((f) => f.reason).join('; ') || 'transition not allowed');
    this.name = 'GuardError';
  }
}

// ---- KV helpers -------------------------------------------------------------
export async function getRow<T>(tx: ReadTransaction, key: string): Promise<T | undefined> {
  return (await tx.get(key)) as T | undefined;
}

export async function scanTable<T>(tx: ReadTransaction, table: SyncedTable): Promise<T[]> {
  const out: T[] = [];
  for await (const v of tx.scan({ prefix: `${table}/` })) out.push(v as T);
  return out;
}

/** Strip `undefined` (not valid JSON) so Replicache accepts the row. */
function clean<T extends object>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function putRow<T extends Record<string, unknown>>(tx: WriteTransaction, table: SyncedTable, row: T): Promise<void> {
  return tx.set(rowKey(table, row), clean(row) as unknown as ReadonlyJSONValue);
}

const synced = (now: string) => ({ version: 0, created_at: now, updated_at: now, deleted_at: null });

// ---- Local lookups used by several mutators ---------------------------------
async function loadWorkflowDef(tx: ReadTransaction, workflowId: string): Promise<WorkflowDefinition> {
  const wf = await getRow<Workflow>(tx, `workflows/${workflowId}`);
  const states = (await scanTable<WorkflowState>(tx, 'workflow_states')).filter((s) => s.workflow_id === workflowId && !s.deleted_at);
  const transitions = (await scanTable<WorkflowTransition>(tx, 'workflow_transitions')).filter((t) => t.workflow_id === workflowId && !t.deleted_at);
  states.sort((a, b) => a.sort - b.sort);
  transitions.sort((a, b) => a.sort - b.sort);
  return { id: workflowId, key: wf?.key ?? workflowId, states, transitions };
}

function localEffectiveRole(user: User | undefined, project: Project | undefined, membership: ProjectMember | undefined): ProjectRole | null {
  if (!user) return null;
  if (user.firm_role === 'owner' || user.firm_role === 'admin') return 'admin';
  if (membership) return membership.role;
  if (project?.visibility === 'firm' && user.firm_role === 'member') return 'editor';
  return null;
}

export async function effectiveRoleFor(tx: ReadTransaction, userId: string, projectId: string): Promise<ProjectRole | null> {
  const user = await getRow<User>(tx, `users/${userId}`);
  const project = await getRow<Project>(tx, `projects/${projectId}`);
  const membership = await getRow<ProjectMember>(tx, `project_members/${projectId}/${userId}`);
  if (user && project) {
    try {
      const memberships: Record<string, ProjectRole> = membership ? { [projectId]: membership.role } : {};
      return permissions.effectiveRole({ id: user.id, firmRole: user.firm_role, memberships, isActive: user.is_active, isService: user.is_service }, { id: project.id, visibility: project.visibility });
    } catch {
      /* core stub or unexpected shape: fall back */
    }
  }
  return localEffectiveRole(user, project, membership);
}

/** Best-effort GuardContext from local data (mirrors the server's loader). */
export async function buildGuardContext(tx: ReadTransaction, item: WorkItem, actorId: string): Promise<GuardContext> {
  const relations = (await scanTable<Relation>(tx, 'relations')).filter((r) => !r.deleted_at);
  const states = new Map((await scanTable<WorkflowState>(tx, 'workflow_states')).map((s) => [s.id, s]));
  const itemCategory = async (id: string): Promise<StateCategory | undefined> => {
    const it = await getRow<WorkItem>(tx, `work_items/${id}`);
    if (!it || it.deleted_at) return undefined;
    return states.get(it.state_id)?.category;
  };
  let openBlockerCount = 0;
  for (const r of relations) {
    if (r.type === 'blocks' && r.to_item_id === item.id) {
      const cat = await itemCategory(r.from_item_id);
      if (cat && cat !== 'done' && cat !== 'canceled') openBlockerCount++;
    }
  }
  const childrenCategories: StateCategory[] = [];
  for (const r of relations) {
    if (r.type === 'parent_of' && r.from_item_id === item.id && r.to_item_id) {
      const cat = await itemCategory(r.to_item_id);
      if (cat) childrenCategories.push(cat);
    }
  }
  const labelRows = (await scanTable<WorkItemLabel>(tx, 'work_item_labels')).filter((l) => l.item_id === item.id && !l.deleted_at);
  const labelNames: string[] = [];
  for (const l of labelRows) {
    const lab = await getRow<Label>(tx, `labels/${l.label_id}`);
    if (lab) labelNames.push(lab.name);
  }
  return {
    actorId,
    actorRole: await effectiveRoleFor(tx, actorId, item.project_id),
    now: new Date(),
    openBlockerCount,
    childrenCategories,
    labelNames,
  };
}

async function findLabelByName(tx: ReadTransaction, projectId: string, name: string): Promise<Label | undefined> {
  const labels = (await scanTable<Label>(tx, 'labels')).filter((l) => !l.deleted_at && l.name.toLowerCase() === name.toLowerCase());
  return labels.find((l) => l.project_id === projectId) ?? labels.find((l) => l.project_id === null);
}

async function applyLabel(tx: WriteTransaction, itemId: string, labelId: string): Promise<void> {
  const key = `work_item_labels/${itemId}/${labelId}`;
  if (await tx.has(key)) return;
  const now = nowIso();
  await putRow(tx, 'work_item_labels', { item_id: itemId, label_id: labelId, ...synced(now) });
}

async function ensureWatcher(tx: WriteTransaction, itemId: string, userId: string, reason: ItemWatcher['reason']): Promise<void> {
  const key = `item_watchers/${itemId}/${userId}`;
  if (await tx.has(key)) return;
  const now = nowIso();
  await putRow(tx, 'item_watchers', { item_id: itemId, user_id: userId, reason, muted: false, ...synced(now) });
}

async function applyItemPatch(tx: WriteTransaction, id: string, patch: MutationArgsOf<'updateItem'>['patch'], userId: string): Promise<void> {
  const item = await getRow<WorkItem>(tx, `work_items/${id}`);
  if (!item) return; // not visible locally; the server will apply it
  const { fields, ...rest } = patch;
  const next: WorkItem = { ...item, ...clean(rest), updated_at: nowIso() };
  if (fields) next.fields = { ...item.fields, ...fields };
  await putRow(tx, 'work_items', next);
  if (patch.assignee_id) await ensureWatcher(tx, id, patch.assignee_id, 'assignee');
  if (patch.reporter_id) await ensureWatcher(tx, id, patch.reporter_id, 'reporter');
  void userId;
}

/** Apply a transition locally; returns failures (empty = applied). */
async function applyTransition(tx: WriteTransaction, id: string, transitionKey: string, userId: string): Promise<GuardFailure[]> {
  const item = await getRow<WorkItem>(tx, `work_items/${id}`);
  if (!item) return [];
  const type = await getRow<ItemType>(tx, `item_types/${item.type_id}`);
  if (!type) return [];
  const def = await loadWorkflowDef(tx, type.workflow_id);
  const transition = def.transitions.find((t) => t.key === transitionKey);
  if (!transition) return [{ guard: { type: 'no_open_blockers' }, reason: `Unknown transition "${transitionKey}"` }];
  if (transition.from_state_id && transition.from_state_id !== item.state_id) {
    return [{ guard: { type: 'no_open_blockers' }, reason: `Transition "${transition.name}" is not available from the current state` }];
  }
  const ctx = await buildGuardContext(tx, item, userId);
  const result = workflowEngine.evaluate(def, item, transitionKey, ctx);
  if (!result.ok) return result.failures;
  const next: WorkItem = { ...item, ...clean(result.patch), state_id: result.toState.id, updated_at: nowIso() };
  await putRow(tx, 'work_items', next);
  // Simple deferred effects we can mirror locally; the rest arrive with the pull.
  for (const eff of result.deferredEffects as Effect[]) {
    if (eff.type === 'add_label') {
      const lab = await findLabelByName(tx, item.project_id, eff.label);
      if (lab) await applyLabel(tx, id, lab.id);
    } else if (eff.type === 'remove_label') {
      const lab = await findLabelByName(tx, item.project_id, eff.label);
      if (lab) await tx.del(`work_item_labels/${id}/${lab.id}`);
    }
  }
  return [];
}

// ---- The mutators -----------------------------------------------------------
export function createMutators(userId: string): Mutators {
  const parse = <N extends MutationName>(name: N, args: unknown): MutationArgsOf<N> => MutationArgs[name].parse(args) as MutationArgsOf<N>;

  return {
    async createItem(tx, raw) {
      const a = parse('createItem', raw);
      const project = await getRow<Project>(tx, `projects/${a.project_id}`);
      const type = await getRow<ItemType>(tx, `item_types/${a.type_id}`);
      let stateId = a.state_id;
      if (!stateId && type) {
        const def = await loadWorkflowDef(tx, type.workflow_id);
        let initial: WorkflowState | undefined;
        try {
          initial = workflowEngine.initialState(def);
        } catch {
          initial = def.states.find((s) => s.is_initial) ?? def.states[0];
        }
        stateId = initial?.id;
      }
      if (!stateId) throw new Error('No initial state for this item type');
      const now = nowIso();
      const fields: Record<string, unknown> = { ...(a.fields ?? {}) };
      for (const def of type?.field_defs ?? []) {
        if (def.default !== undefined && fields[def.key] === undefined) fields[def.key] = def.default;
      }
      const row: WorkItem = {
        id: a.id,
        project_id: a.project_id,
        type_id: a.type_id,
        number: 0,
        key: `${project?.key ?? '?'}-?`,
        title: a.title,
        description: a.description ?? '',
        state_id: stateId,
        priority: a.priority ?? 0,
        assignee_id: a.assignee_id ?? null,
        reporter_id: userId,
        start_date: a.start_date ?? null,
        due_date: a.due_date ?? null,
        estimate: a.estimate ?? null,
        fields,
        confidential: a.confidential ?? false,
        sort_order: Date.now(),
        created_by: userId,
        completed_at: null,
        canceled_at: null,
        archived_at: null,
        ...synced(now),
      };
      await putRow(tx, 'work_items', row);
      for (const labelId of a.label_ids ?? []) await applyLabel(tx, a.id, labelId);
      if (a.parent_id) {
        await putRow(tx, 'relations', {
          id: uuid(),
          type: 'parent_of',
          from_item_id: a.parent_id,
          to_item_id: a.id,
          external_kind: null,
          external_ref: null,
          external_key: null,
          meta: {},
          created_by: userId,
          ...synced(now),
        } satisfies Relation);
      }
      await ensureWatcher(tx, a.id, userId, 'reporter');
      if (a.assignee_id && a.assignee_id !== userId) await ensureWatcher(tx, a.id, a.assignee_id, 'assignee');
    },

    async updateItem(tx, raw) {
      const a = parse('updateItem', raw);
      await applyItemPatch(tx, a.id, a.patch, userId);
    },

    async bulkUpdateItems(tx, raw) {
      const a = parse('bulkUpdateItems', raw);
      for (const id of a.ids) await applyItemPatch(tx, id, a.patch, userId);
    },

    async transitionItem(tx, raw) {
      const a = parse('transitionItem', raw);
      const failures = await applyTransition(tx, a.id, a.transition_key, userId);
      if (failures.length) throw new GuardError(failures);
      if (a.comment) {
        const now = nowIso();
        await putRow(tx, 'comments', {
          id: uuid(),
          item_id: a.id,
          author_id: userId,
          body: a.comment,
          parent_id: null,
          source: 'web',
          external_ref: null,
          edited_at: null,
          ...synced(now),
        } satisfies Comment);
      }
    },

    async bulkTransitionItems(tx, raw) {
      const a = parse('bulkTransitionItems', raw);
      // Apply to the items that pass; the server reports per-item failures.
      for (const id of a.ids) await applyTransition(tx, id, a.transition_key, userId);
    },

    async deleteItem(tx, raw) {
      const a = parse('deleteItem', raw);
      await tx.del(`work_items/${a.id}`);
    },

    async restoreItem(tx, raw) {
      const a = parse('restoreItem', raw);
      const item = await getRow<WorkItem>(tx, `work_items/${a.id}`);
      if (item?.deleted_at) await putRow(tx, 'work_items', { ...item, deleted_at: null, updated_at: nowIso() });
    },

    async moveItem(tx, raw) {
      const a = parse('moveItem', raw);
      const item = await getRow<WorkItem>(tx, `work_items/${a.id}`);
      const project = await getRow<Project>(tx, `projects/${a.project_id}`);
      if (!item || item.project_id === a.project_id) return;
      // The server re-keys the item; show a placeholder key until the pull.
      await putRow(tx, 'work_items', { ...item, project_id: a.project_id, number: 0, key: `${project?.key ?? '?'}-?`, updated_at: nowIso() });
    },

    async reorderItem(tx, raw) {
      const a = parse('reorderItem', raw);
      await applyItemPatch(tx, a.id, { sort_order: a.sort_order }, userId);
    },

    async addLabel(tx, raw) {
      const a = parse('addLabel', raw);
      await applyLabel(tx, a.item_id, a.label_id);
    },

    async removeLabel(tx, raw) {
      const a = parse('removeLabel', raw);
      await tx.del(`work_item_labels/${a.item_id}/${a.label_id}`);
    },

    async createLabel(tx, raw) {
      const a = parse('createLabel', raw);
      const now = nowIso();
      await putRow(tx, 'labels', { id: a.id, project_id: a.project_id, name: a.name, color: a.color ?? null, ...synced(now) } satisfies Label);
    },

    async addRelation(tx, raw) {
      const a = parse('addRelation', raw);
      const now = nowIso();
      if (a.type === 'parent_of' && a.to_item_id) {
        // single parent: drop any existing parent edge for the child
        const existing = (await scanTable<Relation>(tx, 'relations')).filter((r) => r.type === 'parent_of' && r.to_item_id === a.to_item_id && !r.deleted_at);
        for (const r of existing) await tx.del(`relations/${r.id}`);
      }
      await putRow(tx, 'relations', {
        id: a.id,
        type: a.type,
        from_item_id: a.from_item_id,
        to_item_id: a.to_item_id ?? null,
        external_kind: a.external_kind ?? null,
        external_ref: a.external_ref ?? null,
        external_key: null,
        meta: {},
        created_by: userId,
        ...synced(now),
      } satisfies Relation);
    },

    async removeRelation(tx, raw) {
      const a = parse('removeRelation', raw);
      await tx.del(`relations/${a.id}`);
    },

    async setParent(tx, raw) {
      const a = parse('setParent', raw);
      const existing = (await scanTable<Relation>(tx, 'relations')).filter((r) => r.type === 'parent_of' && r.to_item_id === a.id && !r.deleted_at);
      for (const r of existing) await tx.del(`relations/${r.id}`);
      if (a.parent_id) {
        const now = nowIso();
        await putRow(tx, 'relations', {
          id: uuid(),
          type: 'parent_of',
          from_item_id: a.parent_id,
          to_item_id: a.id,
          external_kind: null,
          external_ref: null,
          external_key: null,
          meta: {},
          created_by: userId,
          ...synced(now),
        } satisfies Relation);
      }
    },

    async addComment(tx, raw) {
      const a = parse('addComment', raw);
      const now = nowIso();
      await putRow(tx, 'comments', {
        id: a.id,
        item_id: a.item_id,
        author_id: userId,
        body: a.body,
        parent_id: a.parent_id ?? null,
        source: 'web',
        external_ref: null,
        edited_at: null,
        ...synced(now),
      } satisfies Comment);
      await ensureWatcher(tx, a.item_id, userId, 'commenter');
    },

    async editComment(tx, raw) {
      const a = parse('editComment', raw);
      const c = await getRow<Comment>(tx, `comments/${a.id}`);
      if (!c) return;
      const now = nowIso();
      await putRow(tx, 'comments', { ...c, body: a.body, edited_at: now, updated_at: now });
    },

    async deleteComment(tx, raw) {
      const a = parse('deleteComment', raw);
      await tx.del(`comments/${a.id}`);
    },

    async watchItem(tx, raw) {
      const a = parse('watchItem', raw);
      const key = `item_watchers/${a.item_id}/${userId}`;
      const existing = await getRow<ItemWatcher>(tx, key);
      if (existing) {
        if (existing.muted) await putRow(tx, 'item_watchers', { ...existing, muted: false, updated_at: nowIso() });
        return;
      }
      await ensureWatcher(tx, a.item_id, userId, 'manual');
    },

    async unwatchItem(tx, raw) {
      const a = parse('unwatchItem', raw);
      await tx.del(`item_watchers/${a.item_id}/${userId}`);
    },

    async markNotificationRead(tx, raw) {
      const a = parse('markNotificationRead', raw);
      const n = await getRow<Notification>(tx, `notifications/${a.id}`);
      if (!n || n.read_at) return;
      const now = nowIso();
      await putRow(tx, 'notifications', { ...n, read_at: now, updated_at: now });
    },

    async markAllNotificationsRead(tx, raw) {
      parse('markAllNotificationsRead', raw);
      const now = nowIso();
      for (const n of await scanTable<Notification>(tx, 'notifications')) {
        if (n.user_id === userId && !n.read_at) await putRow(tx, 'notifications', { ...n, read_at: now, updated_at: now });
      }
    },

    async createView(tx, raw) {
      const a = parse('createView', raw);
      const now = nowIso();
      const siblings = (await scanTable<View>(tx, 'views')).filter((v) => v.project_id === a.project_id);
      await putRow(tx, 'views', {
        id: a.id,
        project_id: a.project_id,
        owner_id: userId,
        name: a.name,
        kind: a.kind,
        spec: a.spec as Record<string, unknown>,
        is_shared: a.is_shared ?? false,
        is_default: false,
        icon: a.icon ?? null,
        sort: siblings.length,
        ...synced(now),
      } satisfies View);
    },

    async updateView(tx, raw) {
      const a = parse('updateView', raw);
      const v = await getRow<View>(tx, `views/${a.id}`);
      if (!v) return;
      const { spec, ...rest } = a.patch;
      const next: View = { ...v, ...clean(rest), updated_at: nowIso() };
      if (spec) next.spec = spec as Record<string, unknown>;
      if (a.patch.is_default) {
        for (const other of await scanTable<View>(tx, 'views')) {
          if (other.id !== v.id && other.project_id === v.project_id && other.is_default) await putRow(tx, 'views', { ...other, is_default: false });
        }
      }
      await putRow(tx, 'views', next);
    },

    async deleteView(tx, raw) {
      const a = parse('deleteView', raw);
      await tx.del(`views/${a.id}`);
    },

    async createProject(tx, raw) {
      const a = parse('createProject', raw);
      const now = nowIso();
      await putRow(tx, 'projects', {
        id: a.id,
        key: a.key,
        name: a.name,
        description: a.description ?? null,
        status: 'active',
        visibility: a.visibility ?? 'firm',
        lead_id: a.lead_id ?? null,
        team_id: a.team_id ?? null,
        item_seq: 0,
        default_type_id: null,
        allowed_type_ids: null,
        settings: {},
        start_date: null,
        target_date: null,
        archived_at: null,
        ...synced(now),
      } satisfies Project);
      await putRow(tx, 'project_members', { project_id: a.id, user_id: userId, role: 'admin', ...synced(now) } satisfies ProjectMember);
    },

    async updateProject(tx, raw) {
      const a = parse('updateProject', raw);
      const p = await getRow<Project>(tx, `projects/${a.id}`);
      if (!p) return;
      await putRow(tx, 'projects', { ...p, ...clean(a.patch), updated_at: nowIso() } as Project);
    },

    async setProjectMember(tx, raw) {
      const a = parse('setProjectMember', raw);
      const existing = await getRow<ProjectMember>(tx, `project_members/${a.project_id}/${a.user_id}`);
      const now = nowIso();
      await putRow(tx, 'project_members', { ...(existing ?? synced(now)), project_id: a.project_id, user_id: a.user_id, role: a.role, updated_at: now } as ProjectMember);
    },

    async removeProjectMember(tx, raw) {
      const a = parse('removeProjectMember', raw);
      await tx.del(`project_members/${a.project_id}/${a.user_id}`);
    },

    async upsertItemType(tx, raw) {
      const a = parse('upsertItemType', raw);
      const existing = await getRow<ItemType>(tx, `item_types/${a.id}`);
      const now = nowIso();
      await putRow(tx, 'item_types', {
        ...(existing ?? synced(now)),
        id: a.id,
        key: a.key,
        name: a.name,
        plural_name: a.plural_name ?? existing?.plural_name ?? null,
        icon: a.icon ?? existing?.icon ?? null,
        color: a.color ?? existing?.color ?? null,
        description: a.description ?? existing?.description ?? null,
        workflow_id: a.workflow_id,
        field_defs: a.field_defs,
        is_container: a.is_container ?? existing?.is_container ?? false,
        sort: a.sort ?? existing?.sort ?? 0,
        is_active: a.is_active ?? existing?.is_active ?? true,
        updated_at: now,
      } as ItemType);
    },

    async upsertWorkflow(tx, raw) {
      const a = parse('upsertWorkflow', raw);
      const now = nowIso();
      const existing = await getRow<Workflow>(tx, `workflows/${a.id}`);
      await putRow(tx, 'workflows', { ...(existing ?? synced(now)), id: a.id, key: a.key, name: a.name, description: a.description ?? existing?.description ?? null, updated_at: now } as Workflow);
      const keepStates = new Set(a.states.map((s) => s.id));
      const keepTransitions = new Set(a.transitions.map((t) => t.id));
      for (const s of await scanTable<WorkflowState>(tx, 'workflow_states')) {
        if (s.workflow_id === a.id && !keepStates.has(s.id)) await tx.del(`workflow_states/${s.id}`);
      }
      for (const t of await scanTable<WorkflowTransition>(tx, 'workflow_transitions')) {
        if (t.workflow_id === a.id && !keepTransitions.has(t.id)) await tx.del(`workflow_transitions/${t.id}`);
      }
      for (const s of a.states) {
        const prev = await getRow<WorkflowState>(tx, `workflow_states/${s.id}`);
        await putRow(tx, 'workflow_states', { ...(prev ?? synced(now)), ...s, color: s.color ?? null, workflow_id: a.id, updated_at: now } as WorkflowState);
      }
      for (const t of a.transitions) {
        const prev = await getRow<WorkflowTransition>(tx, `workflow_transitions/${t.id}`);
        await putRow(tx, 'workflow_transitions', { ...(prev ?? synced(now)), ...t, workflow_id: a.id, updated_at: now } as WorkflowTransition);
      }
    },

    async updateNotificationPreference(tx, raw) {
      const a = parse('updateNotificationPreference', raw);
      const key = `notification_preferences/${userId}/${a.channel}`;
      const existing = await getRow<NotificationPreference>(tx, key);
      const now = nowIso();
      await putRow(tx, 'notification_preferences', {
        ...(existing ?? { ...synced(now), rules: {}, quiet_hours: null, cadence: 'immediate' }),
        user_id: userId,
        channel: a.channel,
        cadence: a.cadence ?? existing?.cadence ?? 'immediate',
        rules: a.rules ? { ...(existing?.rules ?? {}), ...a.rules } : (existing?.rules ?? {}),
        quiet_hours: a.quiet_hours === undefined ? (existing?.quiet_hours ?? null) : a.quiet_hours,
        updated_at: now,
      } as NotificationPreference);
    },
  };
}
