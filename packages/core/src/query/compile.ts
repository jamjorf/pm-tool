// STUB — replaced by the core build-out. Signature is the contract.
import type { QuerySpec, QueryContext, CompiledQuery, Widget } from './spec.js';
import type { FieldDef } from '../schema/entities.js';

export interface CompileOptions {
  /** Base relation; default "work_items_v w" (has state_category, type_key, label ids etc.) */
  from?: string;
  /** Field defs by item type key, to type JSONB fields (fields.<key>) correctly */
  fieldDefs?: Record<string, FieldDef[]>;
  /** Extra WHERE fragments already parameterized, e.g. permission scope. */
  extraWhere?: { text: string; values: unknown[] }[];
  select?: string; // default "w.*"
}

/** Compile a QuerySpec to parameterized SQL over work_items_v. */
export function compileQuery(_spec: QuerySpec, _ctx: QueryContext, _opts: CompileOptions = {}): CompiledQuery {
  throw new Error('not implemented');
}

/** Compile a dashboard widget into an aggregate query (group_by + measure). */
export function compileWidget(_widget: Widget, _ctx: QueryContext, _opts: CompileOptions = {}): CompiledQuery {
  throw new Error('not implemented');
}

/** Build the permission-scope WHERE fragment for a user (mirrors can_view_item). */
export function visibilityWhere(_userId: string, _paramOffset: number): { text: string; values: unknown[] } {
  throw new Error('not implemented');
}
