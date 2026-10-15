// View toolbar: filter / sort / group / columns / kind, Save, Save as, share toggle, delete. Edits ViewSpec only.
import { useMemo, useState } from 'react';
import { ArrowUpDown, Group, Columns3, List, GanttChart, LayoutDashboard, Save, Copy, Share2, Lock, Trash2, RotateCcw, Plus, X, ChevronDown, Download } from 'lucide-react';
import type { View, ViewKind, ViewSpec, SortSpec, Project } from '@pm/core';
import { useStore } from '../../store/hooks';
import { buildFieldCatalog, toConditions, DEFAULT_COLUMNS } from './filter';
import { FilterPopover } from './FilterBuilder';
import type { ViewOverrides } from '../../lib/urlState';
import { Button, Popover, Picker, Dialog, Input, Checkbox, ConfirmDialog, type PickerItem } from '../ui';
import { useActions } from '../items/useActions';
import { api } from '../../api';
import { cn } from '../../lib/util';

const KINDS: { kind: ViewKind; icon: typeof List; label: string }[] = [
  { kind: 'list', icon: List, label: 'List' },
  { kind: 'board', icon: Columns3, label: 'Board' },
  { kind: 'timeline', icon: GanttChart, label: 'Timeline' },
  { kind: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
];

export interface ViewToolbarProps {
  view: View | null;
  project: Project | undefined;
  spec: ViewSpec;
  kind: ViewKind;
  dirty: boolean;
  count: number;
  onOverride: (o: ViewOverrides) => void;
  onReset: () => void;
  onKindChange: (k: ViewKind) => void;
  onSpecEdit?: (spec: ViewSpec) => void;
  extra?: React.ReactNode;
}

export function ViewToolbar({ view, project, spec, kind, dirty, count, onOverride, onReset, onKindChange, onSpecEdit, extra }: ViewToolbarProps) {
  const { types } = useStore();
  const a = useActions();
  const catalog = useMemo(() => buildFieldCatalog(types), [types]);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const [groupAnchor, setGroupAnchor] = useState<HTMLElement | null>(null);
  const [colAnchor, setColAnchor] = useState<HTMLElement | null>(null);
  const [kindAnchor, setKindAnchor] = useState<HTMLElement | null>(null);
  const [saveAs, setSaveAs] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveShared, setSaveShared] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const filterCount = toConditions(spec.filter).conditions.length + toConditions(spec.filter).rest.length;
  const sort: SortSpec[] = spec.sort ?? [];
  const sortable = catalog.filter((f) => f.sortable);
  const groupable = catalog.filter((f) => ['uuid', 'enum', 'bool', 'text', 'date'].includes(f.kind) && f.ref !== 'title' && f.ref !== 'key' && f.ref !== 'parent_id');
  const columns = spec.columns ?? DEFAULT_COLUMNS;
  const label = (ref: string) => catalog.find((f) => f.ref === ref)?.label ?? ref;
  const KindIcon = KINDS.find((k) => k.kind === kind)?.icon ?? List;

  const saveSpec = () => {
    if (!view) return;
    void a.updateView(view.id, { spec: { ...spec, kind }, kind }, 'View saved').then(() => onReset());
  };
  const doSaveAs = async () => {
    const id = await a.createView({ project_id: project?.id ?? null, name: saveName.trim() || `${view?.name ?? 'View'} copy`, kind, spec: { ...spec, kind }, is_shared: saveShared });
    setSaveAs(false);
    if (id) location.assign(project ? `/p/${project.key}/v/${id}` : `/v/${id}`);
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
      <Button variant="ghost" icon={<KindIcon size={14} />} onClick={(e) => setKindAnchor(e.currentTarget)}>
        {KINDS.find((k) => k.kind === kind)?.label} <ChevronDown size={12} className="text-fg-faint" />
      </Button>
      <Picker open={!!kindAnchor} onClose={() => setKindAnchor(null)} anchor={kindAnchor} width={180} placeholder="Layout…" items={KINDS.map((k) => ({ id: k.kind, label: k.label, icon: <k.icon size={14} />, selected: k.kind === kind }))} onSelect={(p) => onKindChange(p.id as ViewKind)} />
      <span className="mx-1 h-4 w-px bg-border" />

      <FilterPopover value={spec.filter} count={filterCount} projectId={project?.id} onChange={(f) => onOverride({ filter: f ?? null })} />

      <Button variant={sort.length ? 'secondary' : 'ghost'} icon={<ArrowUpDown size={14} />} onClick={(e) => setSortAnchor(e.currentTarget)}>
        Sort{sort.length ? ` · ${sort.map((s) => label(s.field)).join(', ')}` : ''}
      </Button>
      <Popover open={!!sortAnchor} onClose={() => setSortAnchor(null)} anchor={sortAnchor} width={340} className="p-2">
        <div className="space-y-1">
          {sort.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <select className="h-7 flex-1 rounded-md border border-border bg-bg px-1.5 text-[13px]" value={s.field} onChange={(e) => onOverride({ sort: sort.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
                {sortable.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
              </select>
              <select className="h-7 rounded-md border border-border bg-bg px-1.5 text-[13px]" value={s.dir} onChange={(e) => onOverride({ sort: sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })}>
                <option value="asc">asc</option><option value="desc">desc</option>
              </select>
              <button className="text-fg-faint hover:text-danger" onClick={() => onOverride({ sort: sort.filter((_, j) => j !== i) })}><X size={13} /></button>
            </div>
          ))}
          <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => onOverride({ sort: [...sort, { field: sort.length ? 'created_at' : 'priority', dir: 'asc' }] })}>Add sort</Button>
        </div>
      </Popover>

      {kind !== 'dashboard' && (
        <>
          <Button variant={spec.group_by ? 'secondary' : 'ghost'} icon={<Group size={14} />} onClick={(e) => setGroupAnchor(e.currentTarget)}>
            Group{spec.group_by ? ` · ${label(spec.group_by)}` : ''}
          </Button>
          <Picker open={!!groupAnchor} onClose={() => setGroupAnchor(null)} anchor={groupAnchor} width={260} placeholder="Group by…" items={[{ id: '', label: 'No grouping', selected: !spec.group_by }, ...groupable.map((f): PickerItem => ({ id: f.ref, label: f.label, selected: spec.group_by === f.ref }))]} onSelect={(p) => onOverride({ group: p.id || null })} />
        </>
      )}

      {kind === 'list' && (
        <>
          <Button variant="ghost" icon={<Columns3 size={14} />} onClick={(e) => setColAnchor(e.currentTarget)}>Columns</Button>
          <Picker open={!!colAnchor} onClose={() => setColAnchor(null)} anchor={colAnchor} width={280} multi placeholder="Columns…" items={catalog.filter((f) => f.kind !== 'fts').map((f): PickerItem => ({ id: f.ref, label: f.label, selected: columns.includes(f.ref) }))} onSelect={(p) => onOverride({ columns: columns.includes(p.id) ? columns.filter((c) => c !== p.id) : [...columns, p.id] })} />
        </>
      )}

      {extra}
      <span className="ml-auto text-xs text-fg-faint">{count} item{count === 1 ? '' : 's'}</span>

      {dirty && (
        <>
          <Button variant="ghost" icon={<RotateCcw size={13} />} onClick={onReset} title="Discard unsaved changes">Reset</Button>
          {view && <Button variant="primary" icon={<Save size={13} />} onClick={saveSpec}>Save</Button>}
        </>
      )}
      <Button variant="ghost" icon={<Copy size={13} />} onClick={() => { setSaveName(view ? `${view.name} copy` : 'New view'); setSaveShared(view?.is_shared ?? false); setSaveAs(true); }} title="Save as new view">Save as</Button>
      {view && (
        <>
          <Button variant="ghost" icon={view.is_shared ? <Share2 size={13} /> : <Lock size={13} />} onClick={() => void a.updateView(view.id, { is_shared: !view.is_shared }, view.is_shared ? 'View is now private' : 'View shared with the project')} title={view.is_shared ? 'Shared — click to make private' : 'Private — click to share'}>
            {view.is_shared ? 'Shared' : 'Private'}
          </Button>
          {!view.is_default && <Button variant="ghost" onClick={() => void a.updateView(view.id, { is_default: true }, 'Set as default view')} title="Make this the project's default view" className="text-fg-faint">Default</Button>}
          <Button variant="ghost" icon={<Trash2 size={13} />} className="text-fg-faint hover:text-danger" onClick={() => setConfirmDelete(true)} title="Delete view" />
        </>
      )}
      <a href={api.exportCsvUrl(project?.key)} className={cn('inline-flex h-7 items-center rounded-md px-2 text-fg-faint hover:bg-bg-muted hover:text-fg')} title="Export CSV" download><Download size={13} /></a>
      {onSpecEdit && null}

      <Dialog open={saveAs} onClose={() => setSaveAs(false)} title="Save as new view" width={380} footer={<><Button variant="ghost" onClick={() => setSaveAs(false)}>Cancel</Button><Button variant="primary" onClick={() => void doSaveAs()}>Save view</Button></>}>
        <div className="space-y-3">
          <Input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="View name" onKeyDown={(e) => e.key === 'Enter' && void doSaveAs()} />
          <Checkbox checked={saveShared} onChange={setSaveShared} label="Share with the project" />
        </div>
      </Dialog>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete view "${view?.name}"?`} onConfirm={() => { if (view) void a.deleteView(view.id).then(() => location.assign(project ? `/p/${project.key}` : '/')); }} />
    </div>
  );
}
