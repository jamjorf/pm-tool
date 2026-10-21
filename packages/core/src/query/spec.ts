// ============================================================================
// QuerySpec: the ONE composable query layer.
// Lists, boards, timelines, dashboards, the API `/items/query` endpoint, MCP
// `search_items`, saved views, and the command palette all speak this spec.
//   - Server: compileQuery(spec) -> parameterized SQL  (query/compile.ts)
//   - Client: matchesSpec(spec, item, ctx) -> boolean, sortItems, groupItems
//             over the local synced store  (query/evaluate.ts)
// ============================================================================
import { z } from 'zod';
import { StateCategory, ViewKind } from '../schema/entities.js';

/**
 * Field references. Dotted paths resolve through joins/lookups:
 *   "title" | "state_id" | "priority" | "assignee_id" | "due_date" ...  (work_items columns)
 *   "state.category" | "state.key"       (via workflow_states)
 *   "type.key"                           (via item_types)
 *   "project.key"                        (via projects)
 *   "fields.<key>"                       (JSON type-specific field)
 *   "labels"                             (array of label ids; ops: has / has_any / has_all / is_empty)
 *   "parent_id"                          (derived from relations parent_of)
 *   "is_blocked"                         (derived: has open blockers)
 *   "search"                             (full text; op: match)
 */
export const FieldRef = z.string().regex(/^[a-z_]+(\.[a-z0-9_]+)?$/);
export type FieldRef = z.infer<typeof FieldRef>;

export const FilterOp = z.enum([
  'eq', 'neq', 'in', 'nin', 'lt', 'lte', 'gt', 'gte',
  'contains', 'starts_with',           // text
  'is_null', 'not_null', 'is_empty', 'not_empty',
  'has', 'has_any', 'has_all',         // arrays (labels, multi_select fields)
  'match',                             // full-text search (field = "search")
  'before', 'after', 'within_days',    // dates; value may be a macro
]);
export type FilterOp = z.infer<typeof FilterOp>;

/**
 * Value macros resolved at evaluation time (both server and client):
 *   "$me"          current user id
 *   "$today"       YYYY-MM-DD in ctx.tz
 *   "$now"         ISO timestamp
 *   "$start_of_week" / "$end_of_week" / "$start_of_month"
 */
export const ValueMacro = z.enum(['$me', '$today', '$now', '$start_of_week', '$end_of_week', '$start_of_month']);
export type ValueMacro = z.infer<typeof ValueMacro>;

export type FilterExpr =
  | { field: FieldRef; op: FilterOp; value?: unknown }
  | { and: FilterExpr[] }
  | { or: FilterExpr[] }
  | { not: FilterExpr };

export const FilterExpr: z.ZodType<FilterExpr> = z.lazy(() =>
  z.union([
    z.object({ field: FieldRef, op: FilterOp, value: z.unknown().optional() }),
    z.object({ and: z.array(FilterExpr) }),
    z.object({ or: z.array(FilterExpr) }),
    z.object({ not: FilterExpr }),
  ]),
);

export const SortSpec = z.object({ field: FieldRef, dir: z.enum(['asc', 'desc']).default('asc'), nulls: z.enum(['first', 'last']).optional() });
export type SortSpec = z.infer<typeof SortSpec>;

export const Measure = z.enum(['count', 'sum_estimate', 'avg_estimate', 'sum_field', 'avg_field']);

/** The core query: what rows, in what order, grouped how. */
export const QuerySpec = z.object({
  filter: FilterExpr.optional(),
  sort: z.array(SortSpec).optional(),
  group_by: FieldRef.nullable().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().nonnegative().optional(),
  include_archived: z.boolean().optional(),
});
export type QuerySpec = z.infer<typeof QuerySpec>;

/** Dashboard widget: a QuerySpec + a visualization over it. */
export const Widget = z.object({
  id: z.string(),
  title: z.string(),
  viz: z.enum(['number', 'bar', 'pie', 'line', 'table', 'list']),
  query: QuerySpec,                   // filter scope for the widget
  group_by: FieldRef.optional(),      // for bar/pie/line
  measure: Measure.default('count'),
  measure_field: FieldRef.optional(), // for sum_field/avg_field
  time_bucket: z.enum(['day', 'week', 'month']).optional(), // for line charts on date fields
  w: z.number().int().min(1).max(12).default(4),
  h: z.number().int().min(1).max(12).default(3),
});
export type Widget = z.infer<typeof Widget>;

/** views.spec — kind-specific presentation on top of the same QuerySpec. */
export const ViewSpec = QuerySpec.extend({
  kind: ViewKind.optional(),
  columns: z.array(FieldRef).optional(),                 // list
  board: z.object({
    column_field: FieldRef.default('state_id'),
    swimlane_field: FieldRef.nullable().optional(),
    column_order: z.array(z.string()).optional(),
    hide_empty: z.boolean().optional(),
  }).optional(),
  timeline: z.object({
    start_field: FieldRef.default('start_date'),
    end_field: FieldRef.default('due_date'),
    zoom: z.enum(['week', 'month', 'quarter']).default('month'),
    show_dependencies: z.boolean().optional(),
  }).optional(),
  dashboard: z.object({ widgets: z.array(Widget) }).optional(),
});
export type ViewSpec = z.infer<typeof ViewSpec>;

/** Context needed to resolve macros and permission scope. */
export interface QueryContext {
  userId: string;
  tz?: string;            // IANA, default UTC
  now?: Date;             // injectable for tests
  /** Project ids the user may see; server fills from visible_project_ids(). Client: all local. */
  visibleProjectIds?: string[] | 'all';
}

/** Result of compiling a QuerySpec to SQL (server side). */
export interface CompiledQuery {
  text: string;            // SELECT ... FROM work_items_v w ... WHERE ... ORDER BY ... LIMIT ...
  values: unknown[];       // positional `?` params, in order (plain SQLite scalars)
  /** For group_by queries: SELECT <group>, count(*), ... */
  isAggregate: boolean;
}

/** Fields that sort/filter can target, with their storage kind (used by compiler + UI pickers). */
export const BUILTIN_FIELDS: Record<string, { kind: 'text' | 'number' | 'bool' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array' | 'fts'; label: string; sortable: boolean }> = {
  id: { kind: 'uuid', label: 'Id', sortable: false },
  key: { kind: 'text', label: 'Key', sortable: true },
  number: { kind: 'number', label: 'Number', sortable: true },
  title: { kind: 'text', label: 'Title', sortable: true },
  description: { kind: 'text', label: 'Description', sortable: false },
  project_id: { kind: 'uuid', label: 'Project', sortable: true },
  type_id: { kind: 'uuid', label: 'Type', sortable: true },
  state_id: { kind: 'uuid', label: 'State', sortable: true },
  priority: { kind: 'number', label: 'Priority', sortable: true },
  assignee_id: { kind: 'uuid', label: 'Assignee', sortable: true },
  reporter_id: { kind: 'uuid', label: 'Reporter', sortable: true },
  created_by: { kind: 'uuid', label: 'Created by', sortable: true },
  start_date: { kind: 'date', label: 'Start date', sortable: true },
  due_date: { kind: 'date', label: 'Due date', sortable: true },
  estimate: { kind: 'number', label: 'Estimate', sortable: true },
  confidential: { kind: 'bool', label: 'Confidential', sortable: true },
  sort_order: { kind: 'number', label: 'Manual order', sortable: true },
  created_at: { kind: 'datetime', label: 'Created', sortable: true },
  updated_at: { kind: 'datetime', label: 'Updated', sortable: true },
  completed_at: { kind: 'datetime', label: 'Completed', sortable: true },
  canceled_at: { kind: 'datetime', label: 'Canceled', sortable: true },
  archived_at: { kind: 'datetime', label: 'Archived', sortable: true },
  'state.category': { kind: 'enum', label: 'State category', sortable: true },
  'state.key': { kind: 'text', label: 'State key', sortable: true },
  'type.key': { kind: 'text', label: 'Type key', sortable: true },
  'project.key': { kind: 'text', label: 'Project key', sortable: true },
  labels: { kind: 'array', label: 'Labels', sortable: false },
  parent_id: { kind: 'uuid', label: 'Parent', sortable: true },
  is_blocked: { kind: 'bool', label: 'Blocked', sortable: true },
  search: { kind: 'fts', label: 'Search', sortable: false },
};

export const STATE_CATEGORY_ORDER: StateCategory[] = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
