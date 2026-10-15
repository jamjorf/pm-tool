// Dashboard: grid of widgets computed locally (runSpec + group_by + measure). Simple SVG charts, no chart lib.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { runSpec, type ItemRow, type Project, type ViewSpec, type Widget, type FilterExpr } from '@pm/core';
import { useLookups, useQueryContext, useStore } from '../../store/hooks';
import { buildFieldCatalog } from './filter';
import { FilterBuilder } from './FilterBuilder';
import { encodeState } from '../../lib/urlState';
import { Button, Dialog, Input, Select, Field } from '../ui';
import { ListView } from './ListView';
import { cn, uuid, CATEGORY_LABEL } from '../../lib/util';
import { PRIORITY_LABELS } from '@pm/core';
import { useUI } from '../../state';

const PALETTE = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#65a30d', '#0284c7', '#9333ea'];

type Row = { key: string; label: string; value: number; items: ItemRow[] };

function measure(items: ItemRow[], w: Widget): number {
  const field = w.measure_field?.startsWith('fields.') ? w.measure_field.slice(7) : w.measure_field;
  const nums = (f: (i: ItemRow) => unknown) => items.map(f).filter((v): v is number => typeof v === 'number');
  switch (w.measure) {
    case 'count': return items.length;
    case 'sum_estimate': return nums((i) => i.estimate).reduce((a, b) => a + b, 0);
    case 'avg_estimate': { const xs = nums((i) => i.estimate); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
    case 'sum_field': return field ? nums((i) => i.fields[field]).reduce((a, b) => a + b, 0) : 0;
    case 'avg_field': { if (!field) return 0; const xs = nums((i) => i.fields[field]); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function useWidgetRows(w: Widget, scope: ItemRow[]): { rows: Row[]; total: number; items: ItemRow[]; fallback: boolean } {
  const ctx = useQueryContext();
  const lookups = useLookups();
  const store = useStore();
  return useMemo(() => {
    let items: ItemRow[] = scope;
    let groups: { key: string; label: string; items: ItemRow[] }[] | null = null;
    let fallback = false;
    try {
      const r = runSpec({ ...w.query, group_by: w.group_by ?? null, limit: undefined }, scope, ctx, lookups);
      items = r.items;
      groups = r.groups;
    } catch {
      fallback = true;
      if (w.group_by) {
        const m = new Map<string, ItemRow[]>();
        for (const it of scope) { const k = String(valueOf(it, w.group_by) ?? ''); (m.get(k) ?? m.set(k, []).get(k)!).push(it); }
        groups = [...m.entries()].map(([key, xs]) => ({ key, label: key, items: xs }));
      }
    }
    const resolve = (g: { key: string; label: string }) => {
      if (g.label && g.label !== g.key) return g.label;
      const k = g.key;
      if (!k) return '—';
      switch (w.group_by) {
        case 'assignee_id': case 'reporter_id': case 'created_by': return store.usersById[k]?.name ?? k;
        case 'state_id': return store.statesById[k]?.name ?? k;
        case 'type_id': return store.typesById[k]?.name ?? k;
        case 'project_id': return store.projectsById[k]?.key ?? k;
        case 'priority': return PRIORITY_LABELS[Number(k)] ?? k;
        case 'state.category': return CATEGORY_LABEL[k] ?? k;
        case 'labels': return store.labelsById[k]?.name ?? k;
        default: return k;
      }
    };
    const rows: Row[] = (groups ?? []).map((g) => ({ key: g.key, label: resolve(g), value: measure(g.items, w), items: g.items }));
    return { rows, total: measure(items, w), items, fallback };
  }, [w, scope, ctx, lookups, store]);
}

function valueOf(item: ItemRow, field: string): unknown {
  if (field.startsWith('fields.')) return item.fields[field.slice(7)];
  if (field === 'state.category') return item.state_category;
  return (item as unknown as Record<string, unknown>)[field];
}

function Bar({ rows, onPick }: { rows: Row[]; onPick: (r: Row) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex h-full flex-col justify-end gap-1 overflow-hidden">
      {rows.map((r, i) => (
        <button key={r.key} className="group flex items-center gap-2 text-left text-xs" onClick={() => onPick(r)} title={`${r.label}: ${fmt(r.value)}`}>
          <span className="w-24 shrink-0 truncate text-fg-muted group-hover:text-fg">{r.label}</span>
          <span className="h-4 flex-1 rounded-sm bg-bg-muted"><span className="block h-full rounded-sm transition-all group-hover:opacity-80" style={{ width: `${(r.value / max) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></span>
          <span className="w-8 shrink-0 text-right tabular-nums">{fmt(r.value)}</span>
        </button>
      ))}
      {rows.length === 0 && <span className="text-xs text-fg-faint">No data</span>}
    </div>
  );
}

function Pie({ rows, onPick }: { rows: Row[]; onPick: (r: Row) => void }) {
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  let acc = 0;
  const R = 44; const C = 2 * Math.PI * R;
  return (
    <div className="flex h-full items-center gap-4">
      <svg viewBox="0 0 110 110" className="h-28 w-28 shrink-0 -rotate-90">
        {rows.map((r, i) => {
          const frac = r.value / total;
          const dash = `${frac * C} ${C}`;
          const offset = -acc * C;
          acc += frac;
          return <circle key={r.key} cx="55" cy="55" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="18" strokeDasharray={dash} strokeDashoffset={offset} className="cursor-pointer hover:opacity-80" onClick={() => onPick(r)}><title>{r.label}: {fmt(r.value)}</title></circle>;
        })}
      </svg>
      <ul className="min-w-0 flex-1 space-y-0.5 overflow-auto text-xs">
        {rows.map((r, i) => (
          <li key={r.key}><button className="flex w-full items-center gap-2 rounded px-1 hover:bg-bg-muted" onClick={() => onPick(r)}><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} /><span className="flex-1 truncate text-left text-fg-muted">{r.label}</span><span className="tabular-nums">{fmt(r.value)}</span><span className="w-9 text-right text-fg-faint">{Math.round((r.value / total) * 100)}%</span></button></li>
        ))}
      </ul>
    </div>
  );
}

function Line({ rows, w }: { rows: Row[]; w: Widget }) {
  // bucket by time on the group_by (date) field
  const bucket = w.time_bucket ?? 'week';
  const sorted = [...rows].filter((r) => r.key).sort((a, b) => a.key.localeCompare(b.key));
  const byBucket = new Map<string, number>();
  for (const r of sorted) {
    const d = new Date(r.key);
    if (Number.isNaN(d.getTime())) continue;
    const k = bucket === 'day' ? r.key.slice(0, 10) : bucket === 'month' ? r.key.slice(0, 7) : `${d.getFullYear()}-W${String(Math.ceil(((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)).padStart(2, '0')}`;
    byBucket.set(k, (byBucket.get(k) ?? 0) + r.value);
  }
  const pts = [...byBucket.entries()];
  if (pts.length === 0) return <span className="text-xs text-fg-faint">No data</span>;
  const max = Math.max(1, ...pts.map(([, v]) => v));
  const W = 300; const H = 90;
  const path = pts.map(([, v], i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, pts.length - 1)) * W},${H - (v / max) * (H - 10)}`).join(' ');
  return (
    <div className="h-full">
      <svg viewBox={`0 0 ${W} ${H + 16}`} className="h-full w-full" preserveAspectRatio="none">
        <path d={path} fill="none" stroke={PALETTE[0]} strokeWidth="2" />
        {pts.map(([k, v], i) => <circle key={k} cx={(i / Math.max(1, pts.length - 1)) * W} cy={H - (v / max) * (H - 10)} r="3" fill={PALETTE[0]}><title>{k}: {fmt(v)}</title></circle>)}
        <text x="0" y={H + 13} fontSize="9" fill="var(--fg-faint)">{pts[0]![0]}</text>
        <text x={W} y={H + 13} fontSize="9" fill="var(--fg-faint)" textAnchor="end">{pts[pts.length - 1]![0]}</text>
      </svg>
    </div>
  );
}

function WidgetCard({ w, scope, project, editable, onEdit, onRemove }: { w: Widget; scope: ItemRow[]; project?: Project; editable: boolean; onEdit: () => void; onRemove: () => void }) {
  const { rows, total, items } = useWidgetRows(w, scope);
  const { views } = useStore();
  const navigate = useNavigate();
  const [drill, setDrill] = useState<{ title: string; items: ItemRow[] } | null>(null);
  const { openItem } = useUI();

  const pick = (r: Row) => {
    // Open a list filtered to this slice: navigate to the project's first list view with a URL filter override; else inline dialog.
    const listView = views.find((v) => v.project_id === (project?.id ?? null) && v.kind === 'list');
    if (listView && project && w.group_by) {
      const cond: FilterExpr = r.key === '' ? { field: w.group_by, op: 'is_null' } : w.group_by === 'labels' ? { field: 'labels', op: 'has', value: r.key } : { field: w.group_by, op: 'eq', value: w.group_by === 'priority' ? Number(r.key) : r.key };
      const filter: FilterExpr = w.query.filter ? { and: [w.query.filter, cond] } : cond;
      navigate(`/p/${project.key}/v/${listView.id}?filter=${encodeState(filter)}`);
    } else setDrill({ title: `${w.title} · ${r.label}`, items: r.items });
  };

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-border bg-bg-elevated p-3" style={{ gridColumn: `span ${Math.min(12, w.w)}`, minHeight: w.h * 60 }}>
      <div className="mb-2 flex items-center gap-1">
        <h3 className="truncate text-sm font-medium">{w.title}</h3>
        <span className="text-[10px] uppercase text-fg-faint">{w.viz}</span>
        {editable && (
          <span className="ml-auto flex gap-1 text-fg-faint">
            <button onClick={onEdit} className="hover:text-fg" title="Edit widget"><Pencil size={12} /></button>
            <button onClick={onRemove} className="hover:text-danger" title="Remove widget"><Trash2 size={12} /></button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {w.viz === 'number' && <button className="text-4xl font-semibold tabular-nums hover:text-accent" onClick={() => setDrill({ title: w.title, items })}>{fmt(total)}</button>}
        {w.viz === 'bar' && <Bar rows={rows} onPick={pick} />}
        {w.viz === 'pie' && <Pie rows={rows} onPick={pick} />}
        {w.viz === 'line' && <Line rows={rows} w={w} />}
        {w.viz === 'table' && (
          <table className="w-full text-xs">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border last:border-0 hover:bg-bg-muted"><td className="py-1"><button onClick={() => pick(r)}>{r.label}</button></td><td className="py-1 text-right tabular-nums">{fmt(r.value)}</td></tr>
              ))}
              {rows.length === 0 && <tr><td className="text-fg-faint">No data</td></tr>}
            </tbody>
          </table>
        )}
        {w.viz === 'list' && (
          <ul className="space-y-0.5 text-[13px]">
            {items.slice(0, 15).map((it) => (
              <li key={it.id}><button className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-bg-muted" onClick={() => openItem(it.number > 0 ? it.key : it.id)}><span className="font-mono text-[11px] text-fg-muted">{it.key}</span><span className="truncate">{it.title}</span></button></li>
            ))}
            {items.length > 15 && <li className="text-xs text-fg-faint">+{items.length - 15} more</li>}
            {items.length === 0 && <li className="text-xs text-fg-faint">No items</li>}
          </ul>
        )}
      </div>
      <Dialog open={!!drill} onClose={() => setDrill(null)} title={drill?.title} width={900} className="h-[70vh]">
        <div className="flex h-full flex-col"><ListView items={drill?.items ?? []} groups={null} className="h-full" /></div>
      </Dialog>
    </div>
  );
}

const EMPTY_WIDGET = (): Widget => ({ id: uuid(), title: 'Open items by state', viz: 'bar', query: { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } }, group_by: 'state_id', measure: 'count', w: 4, h: 3 });

export function DashboardView({ spec, scopeItems, project, onSpecChange, editable }: { spec: ViewSpec; scopeItems: ItemRow[]; project?: Project; onSpecChange: (s: ViewSpec) => void; editable: boolean }) {
  const widgets = spec.dashboard?.widgets ?? [];
  const [editing, setEditing] = useState<Widget | null>(null);
  const { types } = useStore();
  const catalog = useMemo(() => buildFieldCatalog(types), [types]);
  const save = (w: Widget) => {
    const next = widgets.some((x) => x.id === w.id) ? widgets.map((x) => (x.id === w.id ? w : x)) : [...widgets, w];
    onSpecChange({ ...spec, dashboard: { widgets: next } });
    setEditing(null);
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="grid grid-cols-12 gap-3">
        {widgets.map((w) => (
          <WidgetCard key={w.id} w={w} scope={scopeItems} project={project} editable={editable} onEdit={() => setEditing(w)} onRemove={() => onSpecChange({ ...spec, dashboard: { widgets: widgets.filter((x) => x.id !== w.id) } })} />
        ))}
        {editable && (
          <button className="flex min-h-[120px] items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong text-sm text-fg-muted hover:bg-bg-subtle" style={{ gridColumn: 'span 4' }} onClick={() => setEditing(EMPTY_WIDGET())}>
            <Plus size={16} /> Add widget
          </button>
        )}
      </div>
      {widgets.length === 0 && !editable && <div className="p-12 text-center text-sm text-fg-muted">This dashboard has no widgets.</div>}
      {editing && (
        <Dialog open onClose={() => setEditing(null)} title={widgets.some((x) => x.id === editing.id) ? 'Edit widget' : 'Add widget'} width={640} footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => save(editing)}>Save widget</Button></>}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Title"><Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
              <Field label="Visualization">
                <Select value={editing.viz} onChange={(e) => setEditing({ ...editing, viz: e.target.value as Widget['viz'] })}>
                  {['number', 'bar', 'pie', 'line', 'table', 'list'].map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Group by">
                <Select value={editing.group_by ?? ''} onChange={(e) => setEditing({ ...editing, group_by: e.target.value || undefined })}>
                  <option value="">—</option>
                  {catalog.filter((f) => f.kind !== 'fts' && f.kind !== 'array' && f.ref !== 'title' && f.ref !== 'key').map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                </Select>
              </Field>
              <Field label="Measure">
                <Select value={editing.measure} onChange={(e) => setEditing({ ...editing, measure: e.target.value as Widget['measure'] })}>
                  {['count', 'sum_estimate', 'avg_estimate', 'sum_field', 'avg_field'].map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </Field>
              {(editing.measure === 'sum_field' || editing.measure === 'avg_field') && (
                <Field label="Measure field">
                  <Select value={editing.measure_field ?? ''} onChange={(e) => setEditing({ ...editing, measure_field: e.target.value || undefined })}>
                    <option value="">—</option>
                    {catalog.filter((f) => f.kind === 'number').map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                  </Select>
                </Field>
              )}
              {editing.viz === 'line' && (
                <Field label="Time bucket">
                  <Select value={editing.time_bucket ?? 'week'} onChange={(e) => setEditing({ ...editing, time_bucket: e.target.value as Widget['time_bucket'] })}>
                    {['day', 'week', 'month'].map((b) => <option key={b} value={b}>{b}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Width (1–12)"><Input type="number" min={1} max={12} value={editing.w} onChange={(e) => setEditing({ ...editing, w: Math.max(1, Math.min(12, Number(e.target.value) || 4)) })} /></Field>
              <Field label="Height (1–12)"><Input type="number" min={1} max={12} value={editing.h} onChange={(e) => setEditing({ ...editing, h: Math.max(1, Math.min(12, Number(e.target.value) || 3)) })} /></Field>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-fg-muted">Filter</div>
              <FilterBuilder value={editing.query.filter} onChange={(f) => setEditing({ ...editing, query: { ...editing.query, filter: f } })} projectId={project?.id} />
            </div>
          </div>
        </Dialog>
      )}
      <span className={cn('hidden')} />
    </div>
  );
}
