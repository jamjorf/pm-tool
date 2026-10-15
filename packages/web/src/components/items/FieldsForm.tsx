// Typed `fields` form generated from an item type's field_defs, validated with validateFields().
import { useEffect, useState } from 'react';
import { validateFields, type FieldDef } from '@pm/core';
import { Input, Textarea, Select, Checkbox, Field } from '../ui';
import { useStore } from '../../store/hooks';
import { cn } from '../../lib/util';

export function runValidate(defs: FieldDef[], fields: Record<string, unknown>): { ok: boolean; errors: Record<string, string>; value: Record<string, unknown> } {
  try {
    const r = validateFields(defs, fields);
    if (r.ok) return { ok: true, errors: {}, value: r.value };
    const errors: Record<string, string> = {};
    for (const e of r.errors) errors[e.field.replace(/^fields\./, '')] = e.message;
    return { ok: false, errors, value: fields };
  } catch {
    // core not built yet: minimal local check (required)
    const errors: Record<string, string> = {};
    for (const d of defs) {
      const v = fields[d.key];
      if (d.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) errors[d.key] = 'Required';
    }
    return { ok: Object.keys(errors).length === 0, errors, value: fields };
  }
}

export function FieldsForm({ defs, value, onChange, errors, layout = 'grid', compact }: { defs: FieldDef[]; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; errors?: Record<string, string>; layout?: 'grid' | 'stack'; compact?: boolean }) {
  const { users } = useStore();
  if (defs.length === 0) return null;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className={cn(layout === 'grid' ? 'grid grid-cols-2 gap-3' : 'space-y-3', compact && 'gap-2')}>
      {defs.map((d) => {
        const v = value[d.key];
        const err = errors?.[d.key];
        const label = d.label + (d.required ? ' *' : '');
        const wide = d.kind === 'long_text' || d.kind === 'multi_select';
        const wrap = (node: React.ReactNode) => (
          <Field key={d.key} label={label} error={err} hint={d.description} className={cn(wide && layout === 'grid' && 'col-span-2')}>
            {node}
          </Field>
        );
        switch (d.kind) {
          case 'text':
          case 'url':
            return wrap(<Input type={d.kind === 'url' ? 'url' : 'text'} value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)} placeholder={d.kind === 'url' ? 'https://' : ''} />);
          case 'long_text':
            return wrap(<Textarea value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)} rows={3} />);
          case 'number':
            return wrap(<Input type="number" value={v === null || v === undefined ? '' : String(v)} min={d.min} max={d.max} onChange={(e) => set(d.key, e.target.value === '' ? null : Number(e.target.value))} />);
          case 'bool':
            return (
              <div key={d.key} className="flex items-end pb-1.5">
                <Checkbox checked={!!v} onChange={(c) => set(d.key, c)} label={label} />
                {err && <span className="ml-2 text-xs text-danger">{err}</span>}
              </div>
            );
          case 'date':
            return wrap(<Input type="date" value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)} />);
          case 'datetime':
            return wrap(<Input type="datetime-local" value={v ? String(v).slice(0, 16) : ''} onChange={(e) => set(d.key, e.target.value ? new Date(e.target.value).toISOString() : null)} />);
          case 'select':
            if (d.multi) return wrap(<MultiSelect options={d.options ?? []} value={Array.isArray(v) ? (v as string[]) : []} onChange={(xs) => set(d.key, xs)} />);
            return wrap(
              <Select value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)}>
                <option value="">—</option>
                {(d.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>,
            );
          case 'multi_select':
            return wrap(<MultiSelect options={d.options ?? []} value={Array.isArray(v) ? (v as string[]) : []} onChange={(xs) => set(d.key, xs)} />);
          case 'user':
            return wrap(
              <Select value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)}>
                <option value="">—</option>
                {users.filter((u) => u.is_active).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>,
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function MultiSelect({ options, value, onChange }: { options: { value: string; label: string; color?: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className={cn('h-6 rounded-full border px-2 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-bg-muted')}
          >
            {o.label}
          </button>
        );
      })}
      {options.length === 0 && <span className="text-xs text-fg-faint">No options</span>}
    </div>
  );
}

/** Edit-on-blur wrapper: keeps a local draft, validates, commits only the changed keys. */
export function FieldsEditor({ defs, fields, onCommit }: { defs: FieldDef[]; fields: Record<string, unknown>; onCommit: (patch: Record<string, unknown>) => void }) {
  const [draft, setDraft] = useState(fields);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setDraft(fields), [fields]);
  if (defs.length === 0) return null;
  const commit = (next: Record<string, unknown>) => {
    setDraft(next);
    const merged = { ...fields, ...next };
    const r = runValidate(defs, merged);
    setErrors(r.errors);
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(next)) if (next[k] !== fields[k] && !r.errors[k]) patch[k] = next[k];
    if (Object.keys(patch).length) onCommit(patch);
  };
  return <FieldsForm defs={defs} value={draft} onChange={commit} errors={errors} layout="stack" compact />;
}
