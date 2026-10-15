// STUB — replaced by the core build-out. Signature is the contract.
import type { FilterExpr, QuerySpec, QueryContext, SortSpec, FieldRef, ValueMacro } from './spec.js';
import type { WorkItem, WorkflowState, ItemType, Project } from '../schema/entities.js';

/** A work item joined with what the client has locally. Same shape the server's work_items_v exposes. */
export interface ItemRow extends WorkItem {
  state_category?: string;
  state_key?: string;
  type_key?: string;
  project_key?: string;
  label_ids?: string[];
  parent_id?: string | null;
  is_blocked?: boolean;
}

/** Lookup tables the client passes so dotted fields resolve without joins. */
export interface EvalLookups {
  states: Record<string, WorkflowState>;
  types: Record<string, ItemType>;
  projects: Record<string, Project>;
  labelIdsByItem?: Record<string, string[]>;
  parentByItem?: Record<string, string>;
  blockedItems?: Set<string>;
}

export function resolveMacro(_value: unknown, _ctx: QueryContext): unknown { throw new Error('not implemented'); }
export function getField(_item: ItemRow, _field: FieldRef, _lookups: EvalLookups): unknown { throw new Error('not implemented'); }
export function matchesFilter(_expr: FilterExpr | undefined, _item: ItemRow, _ctx: QueryContext, _lookups: EvalLookups): boolean { throw new Error('not implemented'); }
export function matchesSpec(_spec: QuerySpec, _item: ItemRow, _ctx: QueryContext, _lookups: EvalLookups): boolean { throw new Error('not implemented'); }
export function sortItems(_items: ItemRow[], _sort: SortSpec[] | undefined, _lookups: EvalLookups): ItemRow[] { throw new Error('not implemented'); }
export function groupItems(_items: ItemRow[], _groupBy: FieldRef | null | undefined, _lookups: EvalLookups): { key: string; label: string; items: ItemRow[] }[] { throw new Error('not implemented'); }
/** Run a full spec over local rows: filter + sort + group + limit. */
export function runSpec(_spec: QuerySpec, _items: ItemRow[], _ctx: QueryContext, _lookups: EvalLookups): { items: ItemRow[]; groups: { key: string; label: string; items: ItemRow[] }[] | null } { throw new Error('not implemented'); }
export const VALUE_MACROS: ValueMacro[] = ['$me', '$today', '$now', '$start_of_week', '$end_of_week', '$start_of_month'];
