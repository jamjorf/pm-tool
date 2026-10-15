// ============================================================================
// Mutations: the single write vocabulary shared by the web client (optimistic,
// via Replicache mutators), the API (REST maps onto these), and MCP tools.
// Each mutation is validated with zod here; the server is the authority.
// ============================================================================
import { z } from 'zod';
import { uuid, isoDate, FieldDef, Guard, Effect, StateCategory, ProjectRole, ProjectVisibility, ProjectStatus, ViewKind } from './schema/entities.js';
import { ViewSpec } from './query/spec.js';

export const ItemPatch = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  type_id: uuid.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignee_id: uuid.nullable().optional(),
  reporter_id: uuid.nullable().optional(),
  start_date: isoDate.nullable().optional(),
  due_date: isoDate.nullable().optional(),
  estimate: z.number().nullable().optional(),
  fields: z.record(z.unknown()).optional(),     // merged (shallow) into existing fields
  confidential: z.boolean().optional(),
  sort_order: z.number().optional(),
  archived_at: z.string().nullable().optional(),
});
export type ItemPatch = z.infer<typeof ItemPatch>;

export const MutationArgs = {
  createItem: z.object({
    id: uuid,                                    // client-generated so optimistic UI has a stable id
    project_id: uuid,
    type_id: uuid,
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    state_id: uuid.optional(),                  // default: workflow initial state
    priority: z.number().int().min(0).max(4).optional(),
    assignee_id: uuid.nullable().optional(),
    start_date: isoDate.nullable().optional(),
    due_date: isoDate.nullable().optional(),
    estimate: z.number().nullable().optional(),
    fields: z.record(z.unknown()).optional(),
    label_ids: z.array(uuid).optional(),
    parent_id: uuid.nullable().optional(),
    confidential: z.boolean().optional(),
  }),
  updateItem: z.object({ id: uuid, patch: ItemPatch }),
  /** Bulk edit: same patch applied to many items in one txn (one activity txn_id). */
  bulkUpdateItems: z.object({ ids: z.array(uuid).min(1).max(500), patch: ItemPatch }),
  /** Explicit state machine transition (server enforces guards + runs effects). */
  transitionItem: z.object({ id: uuid, transition_key: z.string(), comment: z.string().optional() }),
  bulkTransitionItems: z.object({ ids: z.array(uuid).min(1).max(500), transition_key: z.string() }),
  deleteItem: z.object({ id: uuid }),            // soft delete
  restoreItem: z.object({ id: uuid }),
  moveItem: z.object({ id: uuid, project_id: uuid }),
  reorderItem: z.object({ id: uuid, sort_order: z.number() }),

  addLabel: z.object({ item_id: uuid, label_id: uuid }),
  removeLabel: z.object({ item_id: uuid, label_id: uuid }),
  createLabel: z.object({ id: uuid, project_id: uuid.nullable(), name: z.string().min(1), color: z.string().nullable().optional() }),

  addRelation: z.object({
    id: uuid,
    type: z.string(),
    from_item_id: uuid,
    to_item_id: uuid.nullable().optional(),
    external_kind: z.string().nullable().optional(),
    external_ref: z.record(z.unknown()).nullable().optional(),
  }),
  removeRelation: z.object({ id: uuid }),
  setParent: z.object({ id: uuid, parent_id: uuid.nullable() }),

  addComment: z.object({ id: uuid, item_id: uuid, body: z.string().min(1), parent_id: uuid.nullable().optional() }),
  editComment: z.object({ id: uuid, body: z.string().min(1) }),
  deleteComment: z.object({ id: uuid }),

  watchItem: z.object({ item_id: uuid }),
  unwatchItem: z.object({ item_id: uuid }),
  markNotificationRead: z.object({ id: uuid }),
  markAllNotificationsRead: z.object({}),

  createView: z.object({ id: uuid, project_id: uuid.nullable(), name: z.string().min(1), kind: ViewKind, spec: ViewSpec, is_shared: z.boolean().optional(), icon: z.string().nullable().optional() }),
  updateView: z.object({ id: uuid, patch: z.object({ name: z.string().min(1).optional(), kind: ViewKind.optional(), spec: ViewSpec.optional(), is_shared: z.boolean().optional(), is_default: z.boolean().optional(), icon: z.string().nullable().optional(), sort: z.number().int().optional() }) }),
  deleteView: z.object({ id: uuid }),

  createProject: z.object({ id: uuid, key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), name: z.string().min(1), description: z.string().optional(), visibility: ProjectVisibility.optional(), lead_id: uuid.nullable().optional(), team_id: uuid.nullable().optional() }),
  updateProject: z.object({ id: uuid, patch: z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional(), status: ProjectStatus.optional(), visibility: ProjectVisibility.optional(), lead_id: uuid.nullable().optional(), team_id: uuid.nullable().optional(), default_type_id: uuid.nullable().optional(), allowed_type_ids: z.array(uuid).nullable().optional(), start_date: isoDate.nullable().optional(), target_date: isoDate.nullable().optional(), settings: z.record(z.unknown()).optional() }) }),
  setProjectMember: z.object({ project_id: uuid, user_id: uuid, role: ProjectRole }),
  removeProjectMember: z.object({ project_id: uuid, user_id: uuid }),

  // Admin: workflows & types are data
  upsertItemType: z.object({ id: uuid, key: z.string(), name: z.string(), plural_name: z.string().nullable().optional(), icon: z.string().nullable().optional(), color: z.string().nullable().optional(), description: z.string().nullable().optional(), workflow_id: uuid, field_defs: z.array(FieldDef), is_container: z.boolean().optional(), sort: z.number().int().optional(), is_active: z.boolean().optional() }),
  upsertWorkflow: z.object({
    id: uuid, key: z.string(), name: z.string(), description: z.string().nullable().optional(),
    states: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), category: StateCategory, color: z.string().nullable().optional(), sort: z.number().int(), is_initial: z.boolean() })),
    transitions: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), from_state_id: uuid.nullable(), to_state_id: uuid, guards: z.array(Guard), effects: z.array(Effect), sort: z.number().int() })),
  }),
  updateNotificationPreference: z.object({ channel: z.enum(['in_app', 'email', 'slack']), cadence: z.enum(['immediate', 'hourly', 'daily', 'off']).optional(), rules: z.record(z.boolean()).optional(), quiet_hours: z.record(z.unknown()).nullable().optional() }),
} as const;

export type MutationName = keyof typeof MutationArgs;
export type MutationArgsOf<N extends MutationName> = z.infer<(typeof MutationArgs)[N]>;
export type Mutation = { [N in MutationName]: { name: N; args: MutationArgsOf<N> } }[MutationName];

export const MUTATION_NAMES = Object.keys(MutationArgs) as MutationName[];

export function parseMutation(name: string, args: unknown): Mutation {
  if (!(name in MutationArgs)) throw new Error(`unknown mutation: ${name}`);
  const schema = MutationArgs[name as MutationName];
  return { name, args: schema.parse(args) } as Mutation;
}

/** Replicache wire format for a push request (client -> server). */
export const PushRequest = z.object({
  pushVersion: z.literal(1),
  clientGroupID: z.string(),
  profileID: z.string().optional(),
  schemaVersion: z.string().optional(),
  mutations: z.array(z.object({ id: z.number().int(), clientID: z.string(), name: z.string(), args: z.unknown(), timestamp: z.number().optional() })),
});
export type PushRequest = z.infer<typeof PushRequest>;

/** Replicache wire format for a pull request (client -> server). */
export const PullRequest = z.object({
  pullVersion: z.literal(1),
  clientGroupID: z.string(),
  cookie: z.union([z.number(), z.string(), z.null(), z.object({ version: z.number(), order: z.number().optional() })]).optional(),
  profileID: z.string().optional(),
  schemaVersion: z.string().optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export type PatchOp =
  | { op: 'clear' }
  | { op: 'put'; key: string; value: unknown }
  | { op: 'del'; key: string };

export interface PullResponse {
  cookie: number;
  lastMutationIDChanges: Record<string, number>;
  patch: PatchOp[];
}
