// STUB — replaced by the core build-out. Signature is the contract.
import { z } from 'zod';
import type { FieldDef } from './schema/entities.js';
/** Build a zod object schema for work_items.fields from an item type's field_defs (strict: unknown keys rejected). */
export function fieldsSchemaFor(_defs: FieldDef[]): z.ZodTypeAny { throw new Error('not implemented'); }
/** Validate + coerce a fields object; returns {ok, value|errors}. */
export function validateFields(_defs: FieldDef[], _fields: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; errors: { field: string; message: string }[] } { throw new Error('not implemented'); }
/** Human label for a field ref, given type defs (e.g. "fields.severity" -> "Severity"). */
export function fieldLabel(_field: string, _defs?: FieldDef[]): string { throw new Error('not implemented'); }
