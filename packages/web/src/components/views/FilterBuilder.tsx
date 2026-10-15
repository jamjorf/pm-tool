// Filter builder: field picker (builtin + fields.<key> + labels + state.category), op per kind, value editor.
import { useMemo, useState } from 'react';
import { Plus, X, Filter } from 'lucide-react';
import type { FilterExpr, FilterOp } from '@pm/core';
import { useStore } from '../../store/hooks';
import { buildFieldCatalog, toConditions, fromConditions, OPS_BY_KIND, OP_LABELS, NO_VALUE_OPS, MULTI_VALUE_OPS, DATE_MACROS, defaultOpFor, defaultValueFor, type Condition, type FieldInfo } from './filter';
import { Popover, Button, Picker, type PickerItem } from '../ui';
import { cn } from '../../lib/util';

function useCatalog(): FieldInfo[] {
  const { types } = useStore();
  return useMemo(() => buildFieldCatalog(types), [types]);
}

function useEntityOptions(info: FieldInfo | undefined, projectId: string | null | undefined): { value: string; label: string }[] | null {
  const { users, statesById, workflows, types, projects, labels } = useStore();
  return useMemo(() => {
    if (!info) return null;
    if (info.options) return info.options;
    switch (info.entity) {
      case 'user': return [{ value: '$me', label: 'Me ($me)' }, ...users.filter((u) => u.is_active).map((u) => ({ value: u.id, label: u.name }))];
      case 'state': return workflows.flatMap((w) => w.states.map((s) => ({ value: s.id, label: `${s.name}${workflows.length > 1 ? ` (${w.name})` : ''}` })));
      case 'type': return types.map((t) => ({ value: t.id, label: t.name }));
      case 'project': return projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }));
      case 'label': return labels.filter((l) => !l.project_id || !projectId || l.project_id === projectId).map((l) => ({ value: l.id, label: l.name }));
      default: void statesById; return null;
    }
  }, [info, users, statesById, workflows, types, projects, labels, projectId]);
}

function ValueEditor({ info, op, value, onChange, projectId }: { info: FieldInfo | undefined; op: FilterOp; value: unknown; onChange: (v: unknown) => void; projectId: string | null | undefined }) {
  const options = useEntityOptions(info, projectId);
  if (NO_VALUE_OPS.has(op)) return null;
  const multi = MULTI_VALUE_OPS.has(op);
  const cls = 'h-7 rounded-md border border-border bg-bg px-1.5 text-[13px] focus:border-accent focus:outline-none';
  if (options) {
    if (multi) {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => {
            const on = arr.includes(o.value);
            return (
              <button key={o.value} type="button" className={cn('h-6 rounded-full border px-2 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-bg-muted')} onClick={() => onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])}>
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    const v = info?.kind === 'enum' && info.ref === 'priority' ? String(value ?? '') : String(value ?? '');
    return (
      <select className={cls} value={v} onChange={(e) => onChange(info?.ref === 'priority' ? Number(e.target.value) : e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  switch (info?.kind) {
    case 'bool':
      return <select className={cls} value={String(!!value)} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">true</option><option value="false">false</option></select>;
    case 'number':
      return <input type="number" className={cn(cls, 'w-24')} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'date':
    case 'datetime': {
      if (op === 'within_days') return <input type="number" className={cn(cls, 'w-20')} value={Number(value ?? 7)} onChange={(e) => onChange(Number(e.target.value))} />;
      const isMacro = typeof value === 'string' && value.startsWith('$');
      return (
        <span className="flex items-center gap-1">
          <select className={cls} value={isMacro ? (value as string) : 'date'} onChange={(e) => onChange(e.target.value === 'date' ? new Date().toISOString().slice(0, 10) : e.target.value)}>
            <option value="date">specific date</option>
            {DATE_MACROS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {!isMacro && <input type="date" className={cls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />}
        </span>
      );
    }
    default:
      if (multi) return <input className={cn(cls, 'w-40')} placeholder="a, b, c" value={Array.isArray(value) ? (value as string[]).join(', ') : ''} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
      return <input className={cn(cls, 'w-40')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="value" />;
  }
}

export function FilterBuilder({ value, onChange, projectId }: { value: FilterExpr | undefined; onChange: (next: FilterExpr | undefined) => void; projectId: string | null | undefined }) {
  const catalog = useCatalog();
  const { conditions, rest } = useMemo(() => toConditions(value), [value]);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const byRef = useMemo(() => new Map(catalog.map((c) => [c.ref, c])), [catalog]);

  const setConds = (next: Condition[]) => onChange(fromConditions(next, rest));
  const updateAt = (i: number, patch: Partial<Condition>) => setConds(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const fieldItems: PickerItem[] = catalog.map((f) => ({ id: f.ref, label: f.label, hint: f.group === 'Fields' ? 'field' : f.kind, keywords: f.ref }));

  return (
    <div className="space-y-1.5">
      {conditions.map((c, i) => {
        const info = byRef.get(c.field);
        const ops = info ? OPS_BY_KIND[info.kind] : (Object.keys(OP_LABELS) as FilterOp[]);
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2 py-1.5">
            <span className="text-xs text-fg-faint">{i === 0 ? 'Where' : 'and'}</span>
            <FieldButton value={c.field} label={info?.label ?? c.field} items={fieldItems} onPick={(ref) => { const ni = byRef.get(ref); const op = defaultOpFor(ni); updateAt(i, { field: ref, op, value: defaultValueFor(ni, op) }); }} />
            <select className="h-7 rounded-md border border-border bg-bg px-1.5 text-[13px]" value={c.op} onChange={(e) => { const op = e.target.value as FilterOp; updateAt(i, { op, value: NO_VALUE_OPS.has(op) ? undefined : MULTI_VALUE_OPS.has(op) && !Array.isArray(c.value) ? (c.value === undefined || c.value === '' ? [] : [c.value]) : !MULTI_VALUE_OPS.has(op) && Array.isArray(c.value) ? (c.value as unknown[])[0] : (c.value ?? defaultValueFor(info, op)) }); }}>
              {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
            </select>
            <ValueEditor info={info} op={c.op} value={c.value} onChange={(v) => updateAt(i, { value: v })} projectId={projectId} />
            <button className="ml-auto text-fg-faint hover:text-danger" onClick={() => setConds(conditions.filter((_, j) => j !== i))} aria-label="Remove condition"><X size={13} /></button>
          </div>
        );
      })}
      {rest.length > 0 && (
        <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-fg-muted">
          + {rest.length} advanced clause{rest.length > 1 ? 's' : ''} (or/not groups) kept as-is: <code className="text-[11px]">{JSON.stringify(rest).slice(0, 120)}</code>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={(e) => setAddAnchor(e.currentTarget)}>Add condition</Button>
        {(conditions.length > 0 || rest.length > 0) && <Button size="xs" variant="ghost" onClick={() => onChange(undefined)}>Clear</Button>}
      </div>
      <Picker open={!!addAnchor} onClose={() => setAddAnchor(null)} anchor={addAnchor} items={fieldItems} placeholder="Field…" width={300} onSelect={(p) => { const ni = byRef.get(p.id); const op = defaultOpFor(ni); setConds([...conditions, { field: p.id, op, value: defaultValueFor(ni, op) }]); }} />
    </div>
  );
}

function FieldButton({ value, label, items, onPick }: { value: string; label: string; items: PickerItem[]; onPick: (ref: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className="h-7 rounded-md border border-border bg-bg px-2 text-[13px] font-medium hover:bg-bg-muted" onClick={(e) => setAnchor(e.currentTarget)} title={value}>{label}</button>
      <Picker open={!!anchor} onClose={() => setAnchor(null)} anchor={anchor} items={items.map((i) => ({ ...i, selected: i.id === value }))} placeholder="Field…" width={300} onSelect={(p) => onPick(p.id)} />
    </>
  );
}

/** Button + popover wrapper used by the toolbar. */
export function FilterPopover({ value, onChange, projectId, count }: { value: FilterExpr | undefined; onChange: (next: FilterExpr | undefined) => void; projectId: string | null | undefined; count: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button variant={count ? 'secondary' : 'ghost'} icon={<Filter size={14} />} onClick={(e) => setAnchor(e.currentTarget)}>
        Filter{count ? ` · ${count}` : ''}
      </Button>
      <Popover open={!!anchor} onClose={() => setAnchor(null)} anchor={anchor} width={560} className="p-3">
        <FilterBuilder value={value} onChange={onChange} projectId={projectId} />
      </Popover>
    </>
  );
}
