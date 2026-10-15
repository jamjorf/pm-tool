// ============================================================================
// Entity types mirroring packages/db/migrations/0001_init.sql
// These are the canonical row shapes shared by API, web (local store), MCP.
// Keep column names identical to the SQL (snake_case) so sync is a straight copy.
// ============================================================================
import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD
export const isoDateTime = z.string(); // ISO 8601 timestamptz

export const FirmRole = z.enum(['owner', 'admin', 'member', 'guest']);
export type FirmRole = z.infer<typeof FirmRole>;
export const ProjectRole = z.enum(['admin', 'editor', 'viewer']);
export type ProjectRole = z.infer<typeof ProjectRole>;
export const ProjectVisibility = z.enum(['firm', 'private']);
export type ProjectVisibility = z.infer<typeof ProjectVisibility>;
export const ProjectStatus = z.enum(['planned', 'active', 'paused', 'completed', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;
export const StateCategory = z.enum(['backlog', 'todo', 'in_progress', 'done', 'canceled']);
export type StateCategory = z.infer<typeof StateCategory>;
export const ViewKind = z.enum(['list', 'board', 'timeline', 'dashboard']);
export type ViewKind = z.infer<typeof ViewKind>;
export const ActorKind = z.enum(['user', 'api_key', 'integration', 'system', 'agent']);
export type ActorKind = z.infer<typeof ActorKind>;
export const WatchReason = z.enum(['assignee', 'reporter', 'mention', 'commenter', 'manual']);
export type WatchReason = z.infer<typeof WatchReason>;
export const NotifyChannel = z.enum(['in_app', 'email', 'slack']);
export type NotifyChannel = z.infer<typeof NotifyChannel>;
export const NotifyCadence = z.enum(['immediate', 'hourly', 'daily', 'off']);
export type NotifyCadence = z.infer<typeof NotifyCadence>;

/** Common sync columns present on every synced row */
const synced = {
  version: z.number().int(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  deleted_at: isoDateTime.nullable(),
};

export const User = z.object({
  id: uuid,
  email: z.string().email(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  firm_role: FirmRole,
  is_active: z.boolean(),
  is_service: z.boolean(),
  settings: z.record(z.unknown()),
  ...synced,
});
export type User = z.infer<typeof User>;

export const Team = z.object({
  id: uuid, key: z.string(), name: z.string(), description: z.string().nullable(), ...synced,
});
export type Team = z.infer<typeof Team>;

export const Workflow = z.object({
  id: uuid, key: z.string(), name: z.string(), description: z.string().nullable(), ...synced,
});
export type Workflow = z.infer<typeof Workflow>;

export const WorkflowState = z.object({
  id: uuid,
  workflow_id: uuid,
  key: z.string(),
  name: z.string(),
  category: StateCategory,
  color: z.string().nullable(),
  sort: z.number().int(),
  is_initial: z.boolean(),
  ...synced,
});
export type WorkflowState = z.infer<typeof WorkflowState>;

// ---- Guards & effects (stored as JSON in workflow_transitions) -------------
export const Guard = z.discriminatedUnion('type', [
  z.object({ type: z.literal('require_field'), field: z.string() }),           // field must be non-null/non-empty
  z.object({ type: z.literal('field_equals'), field: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('field_in'), field: z.string(), values: z.array(z.unknown()) }),
  z.object({ type: z.literal('no_open_blockers') }),
  z.object({ type: z.literal('children_in_category'), categories: z.array(StateCategory) }), // all children in one of these
  z.object({ type: z.literal('require_role'), roles: z.array(ProjectRole) }),
  z.object({ type: z.literal('require_assignee_is_actor') }),
  z.object({ type: z.literal('require_label'), label: z.string() }),
]);
export type Guard = z.infer<typeof Guard>;

export const Effect = z.discriminatedUnion('type', [
  // value may be a literal or a macro: "$now" | "$today" | "$actor" | null
  z.object({ type: z.literal('set_field'), field: z.string(), value: z.unknown(), only_if_null: z.boolean().optional() }),
  z.object({ type: z.literal('notify'), audience: z.array(z.enum(['watchers', 'assignee', 'reporter', 'project_admins'])), template: z.string() }),
  z.object({ type: z.literal('webhook'), event: z.string() }),
  z.object({ type: z.literal('add_label'), label: z.string() }),
  z.object({ type: z.literal('remove_label'), label: z.string() }),
  z.object({ type: z.literal('transition_parent_if'), all_children_category: z.array(StateCategory), to: z.string() }), // to = state key
  z.object({ type: z.literal('transition_children'), to: z.string() }),
]);
export type Effect = z.infer<typeof Effect>;

export const WorkflowTransition = z.object({
  id: uuid,
  workflow_id: uuid,
  key: z.string(),
  name: z.string(),
  from_state_id: uuid.nullable(), // null = from any state
  to_state_id: uuid,
  guards: z.array(Guard),
  effects: z.array(Effect),
  sort: z.number().int(),
  ...synced,
});
export type WorkflowTransition = z.infer<typeof WorkflowTransition>;

// ---- Item type field registry ----------------------------------------------
export const FieldKind = z.enum(['text', 'long_text', 'number', 'bool', 'date', 'datetime', 'select', 'multi_select', 'user', 'url']);
export type FieldKind = z.infer<typeof FieldKind>;

export const FieldDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  kind: FieldKind,
  required: z.boolean().optional(),
  multi: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string(), color: z.string().optional() })).optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  show_in_list: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const ItemType = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  plural_name: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  workflow_id: uuid,
  field_defs: z.array(FieldDef),
  is_container: z.boolean(),
  sort: z.number().int(),
  is_active: z.boolean(),
  ...synced,
});
export type ItemType = z.infer<typeof ItemType>;

export const Project = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatus,
  visibility: ProjectVisibility,
  lead_id: uuid.nullable(),
  team_id: uuid.nullable(),
  item_seq: z.number().int(),
  default_type_id: uuid.nullable(),
  allowed_type_ids: z.array(uuid).nullable(),
  settings: z.record(z.unknown()),
  start_date: isoDate.nullable(),
  target_date: isoDate.nullable(),
  archived_at: isoDateTime.nullable(),
  ...synced,
});
export type Project = z.infer<typeof Project>;

export const ProjectMember = z.object({
  project_id: uuid, user_id: uuid, role: ProjectRole, ...synced,
});
export type ProjectMember = z.infer<typeof ProjectMember>;

export const WorkItem = z.object({
  id: uuid,
  project_id: uuid,
  type_id: uuid,
  number: z.number().int(),
  key: z.string(),
  title: z.string().min(1).max(500),
  description: z.string(),
  state_id: uuid,
  priority: z.number().int().min(0).max(4), // 0 none, 1 urgent, 2 high, 3 medium, 4 low
  assignee_id: uuid.nullable(),
  reporter_id: uuid.nullable(),
  start_date: isoDate.nullable(),
  due_date: isoDate.nullable(),
  estimate: z.number().nullable(),
  fields: z.record(z.unknown()),
  confidential: z.boolean(),
  sort_order: z.number(),
  created_by: uuid.nullable(),
  completed_at: isoDateTime.nullable(),
  canceled_at: isoDateTime.nullable(),
  archived_at: isoDateTime.nullable(),
  ...synced,
});
export type WorkItem = z.infer<typeof WorkItem>;

export const Label = z.object({
  id: uuid, project_id: uuid.nullable(), name: z.string(), color: z.string().nullable(), ...synced,
});
export type Label = z.infer<typeof Label>;

export const WorkItemLabel = z.object({ item_id: uuid, label_id: uuid, ...synced });
export type WorkItemLabel = z.infer<typeof WorkItemLabel>;

export const Comment = z.object({
  id: uuid,
  item_id: uuid,
  author_id: uuid.nullable(),
  body: z.string(),
  parent_id: uuid.nullable(),
  source: z.string(),
  external_ref: z.record(z.unknown()).nullable(),
  edited_at: isoDateTime.nullable(),
  ...synced,
});
export type Comment = z.infer<typeof Comment>;

export const RelationTypeKey = z.enum(['parent_of', 'blocks', 'duplicates', 'relates_to', 'links_to']);
export type RelationTypeKey = z.infer<typeof RelationTypeKey>;

export const Relation = z.object({
  id: uuid,
  type: z.string(), // RelationTypeKey or custom registered key
  from_item_id: uuid,
  to_item_id: uuid.nullable(),
  external_kind: z.string().nullable(),
  external_ref: z.record(z.unknown()).nullable(),
  external_key: z.string().nullable(),
  meta: z.record(z.unknown()),
  created_by: uuid.nullable(),
  ...synced,
});
export type Relation = z.infer<typeof Relation>;

export const ActivityEvent = z.object({
  id: z.number().int(),
  txn_id: uuid,
  entity_type: z.string(),
  entity_id: uuid,
  item_id: uuid.nullable(),
  project_id: uuid.nullable(),
  actor_kind: ActorKind,
  actor_id: uuid.nullable(),
  actor_label: z.string().nullable(),
  action: z.string(),
  field: z.string().nullable(),
  old_value: z.unknown(),
  new_value: z.unknown(),
  mutation_name: z.string().nullable(),
  source: z.string(),
  created_at: isoDateTime,
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const View = z.object({
  id: uuid,
  project_id: uuid.nullable(),
  owner_id: uuid.nullable(),
  name: z.string(),
  kind: ViewKind,
  spec: z.record(z.unknown()), // validated as ViewSpec in query/spec.ts
  is_shared: z.boolean(),
  is_default: z.boolean(),
  icon: z.string().nullable(),
  sort: z.number().int(),
  ...synced,
});
export type View = z.infer<typeof View>;

export const ItemWatcher = z.object({ item_id: uuid, user_id: uuid, reason: WatchReason, muted: z.boolean(), ...synced });
export type ItemWatcher = z.infer<typeof ItemWatcher>;

export const Notification = z.object({
  id: uuid,
  user_id: uuid,
  item_id: uuid.nullable(),
  event_id: z.number().int().nullable(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  actor_id: uuid.nullable(),
  read_at: isoDateTime.nullable(),
  archived_at: isoDateTime.nullable(),
  ...synced,
});
export type Notification = z.infer<typeof Notification>;

export const NotificationPreference = z.object({
  user_id: uuid, channel: NotifyChannel, cadence: NotifyCadence,
  rules: z.record(z.boolean()), quiet_hours: z.record(z.unknown()).nullable(), ...synced,
});
export type NotificationPreference = z.infer<typeof NotificationPreference>;

/** Names of tables that are synced to clients (and their primary keys). */
export const SYNCED_TABLES = {
  users: ['id'],
  teams: ['id'],
  workflows: ['id'],
  workflow_states: ['id'],
  workflow_transitions: ['id'],
  item_types: ['id'],
  projects: ['id'],
  project_members: ['project_id', 'user_id'],
  work_items: ['id'],
  labels: ['id'],
  work_item_labels: ['item_id', 'label_id'],
  comments: ['id'],
  relations: ['id'],
  views: ['id'],
  item_watchers: ['item_id', 'user_id'],
  notifications: ['id'],
  notification_preferences: ['user_id', 'channel'],
} as const;
export type SyncedTable = keyof typeof SYNCED_TABLES;

/** Key in the client KV store for a row: `<table>/<pk1>[/<pk2>]` */
export function rowKey(table: SyncedTable, row: Record<string, unknown>): string {
  const pks = SYNCED_TABLES[table] as readonly string[];
  return `${table}/${pks.map((k) => String(row[k])).join('/')}`;
}

export const PRIORITY_LABELS: Record<number, string> = { 0: 'None', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
