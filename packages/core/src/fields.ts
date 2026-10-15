// ============================================================================
// Typed JSONB fields: zod schema from an item type's field_defs + validation.
// ============================================================================
import { z } from 'zod';
import type { FieldDef } from './schema/entities.js';
import { BUILTIN_FIELDS } from './query/spec.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function baseSchema(def: FieldDef): z.ZodTypeAny {
  switch (def.kind) {
    case 'text': case 'long_text': return z.string();
    case 'number': {
      let n = z.number();
      if (def.min !== undefined) n = n.min(def.min, `must be >= ${def.min}`);
      if (def.max !== undefined) n = n.max(def.max, `must be <= ${def.max}`);
      return n;
    }
    case 'bool': return z.boolean();
    case 'date': return z.string().regex(DATE_RE, 'must be a date (YYYY-MM-DD)');
    case 'datetime': return z.string().regex(DATETIME_RE, 'must be an ISO 8601 timestamp');
    case 'select': return optionEnum(def);
    case 'multi_select': return z.array(optionEnum(def));
    case 'user': return z.string().uuid('must be a user id');
    case 'url': return z.string().url('must be a URL');
    default: return z.unknown();
  }
}

function optionEnum(def: FieldDef): z.ZodTypeAny {
  const values = def.options?.map((o) => o.value) ?? [];
  if (values.length === 0) return z.string();
  return z.enum(values as [string, ...string[]], { errorMap: () => ({ message: `must be one of ${values.join(', ')}` }) });
}

/** Schema for one field (multi → array, optional/nullable unless required). */
export function fieldSchemaFor(def: FieldDef): z.ZodTypeAny {
  let s = baseSchema(def);
  if (def.multi && def.kind !== 'multi_select') s = z.array(s);
  return def.required ? s : s.nullable().optional();
}

/** Build a zod object schema for work_items.fields from an item type's field_defs (strict: unknown keys rejected). */
export function fieldsSchemaFor(defs: FieldDef[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of defs) shape[def.key] = fieldSchemaFor(def);
  return z.object(shape).strict();
}

/** Light coercion before validation: numeric strings → numbers, 'true'/'false' → booleans, apply defaults. */
function preprocess(defs: FieldDef[], fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  for (const def of defs) {
    let v = out[def.key];
    if (v === undefined && def.default !== undefined) { out[def.key] = def.default; continue; }
    if (v === undefined || v === null) continue;
    const coerce = (x: unknown): unknown => {
      if (def.kind === 'number' && typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) return Number(x);
      if (def.kind === 'bool' && (x === 'true' || x === 'false')) return x === 'true';
      if ((def.kind === 'date' || def.kind === 'datetime') && x instanceof Date) return def.kind === 'date' ? x.toISOString().slice(0, 10) : x.toISOString();
      if (def.kind === 'date' && typeof x === 'string' && DATETIME_RE.test(x)) return x.slice(0, 10);
      return x;
    };
    if (def.multi || def.kind === 'multi_select') {
      if (!Array.isArray(v)) v = [v];
      v = (v as unknown[]).map(coerce);
    } else {
      v = coerce(v);
    }
    out[def.key] = v;
  }
  return out;
}

/** Validate + coerce a fields object; returns {ok, value|errors}. */
export function validateFields(defs: FieldDef[], fields: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; errors: { field: string; message: string }[] } {
  const input = preprocess(defs, fields ?? {});
  const result = fieldsSchemaFor(defs).safeParse(input);
  if (result.success) {
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.data as Record<string, unknown>)) if (v !== undefined) value[k] = v;
    return { ok: true, value };
  }
  const errors: { field: string; message: string }[] = [];
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) errors.push({ field: k, message: `unknown field "${k}"` });
      continue;
    }
    const field = String(issue.path[0] ?? '');
    const def = defs.find((d) => d.key === field);
    let message = issue.message;
    if (issue.code === 'invalid_type' && issue.received === 'undefined') message = 'is required';
    else if (issue.code === 'invalid_type' && issue.received === 'null' && def?.required) message = 'is required';
    else if (issue.code === 'invalid_type') message = `must be a ${issue.expected}`;
    errors.push({ field, message });
  }
  return { ok: false, errors };
}

/** Human label for a field ref, given type defs (e.g. "fields.severity" -> "Severity"). */
export function fieldLabel(field: string, defs?: FieldDef[]): string {
  if (field.startsWith('fields.')) {
    const key = field.slice(7);
    const def = defs?.find((d) => d.key === key);
    return def?.label ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
  const b = Object.prototype.hasOwnProperty.call(BUILTIN_FIELDS, field) ? BUILTIN_FIELDS[field] : undefined;
  if (b) return b.label;
  return field.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
