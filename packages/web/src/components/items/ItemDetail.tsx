// Item detail (full page and peek panel): title, transitions, properties, typed fields, description,
// parent/children with rollup, relations, comments, activity, watch.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, Plus, ChevronRight, Trash2, X, CornerLeftUp } from 'lucide-react';
import type { ItemRow } from '@pm/core';
import { useChildren, useStore, useTransitions, useWatchers } from '../../store/hooks';
import { useSession } from '../../session';
import { useUI } from '../../state';
import { useActions } from './useActions';
import { AssigneeChip, PriorityChip, StateChip, DueDateChip, LabelsChip, TypeChip } from './properties';
import { FieldsEditor } from './FieldsForm';
import { Markdown } from './Markdown';
import { CommentsSection } from './Comments';
import { ActivitySection } from './Activity';
import { RelationsSection } from './Relations';
import { ItemPicker } from './ItemPicker';
import { Button, StateDot, Tooltip, ConfirmDialog, Avatar, Kbd } from '../ui';
import { cn, isDone, stateColor } from '../../lib/util';
import { ITEM_SHORTCUT_EVENT } from '../shell/useGlobalShortcuts';
import { Link } from 'react-router-dom';

function TitleEditor({ item }: { item: ItemRow }) {
  const a = useActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(item.title), [item.title]);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail === 'edit_title') setEditing(true);
    };
    window.addEventListener(ITEM_SHORTCUT_EVENT, on);
    return () => window.removeEventListener(ITEM_SHORTCUT_EVENT, on);
  }, []);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== item.title) void a.setTitle(item.id, t);
    else setDraft(item.title);
  };
  if (editing)
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.stopPropagation(); setDraft(item.title); setEditing(false); }
        }}
        className="w-full resize-none rounded-md border border-accent bg-bg px-2 py-1 text-xl font-semibold leading-snug outline-none"
      />
    );
  return (
    <h1 className="cursor-text rounded-md px-2 py-1 text-xl font-semibold leading-snug hover:bg-bg-muted" onClick={() => setEditing(true)} title="Edit title (e)">
      {item.title}
    </h1>
  );
}

function DescriptionEditor({ item }: { item: ItemRow }) {
  const a = useActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.description);
  useEffect(() => setDraft(item.description), [item.description]);
  if (editing)
    return (
      <div>
        <textarea
          autoFocus
          value={draft}
          rows={Math.max(6, draft.split('\n').length + 1)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setDraft(item.description); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { void a.setDescription(item.id, draft); setEditing(false); }
          }}
          className="w-full rounded-md border border-accent bg-bg px-2.5 py-2 font-mono text-[13px] leading-relaxed outline-none"
          placeholder="Markdown supported"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <Button variant="primary" onClick={() => { void a.setDescription(item.id, draft); setEditing(false); }}>Save</Button>
          <Button variant="ghost" onClick={() => { setEditing(false); setDraft(item.description); }}>Cancel</Button>
          <span className="text-xs text-fg-faint">⌘↵ to save · markdown</span>
        </div>
      </div>
    );
  return (
    <div className="group min-h-[48px] cursor-text rounded-md px-2 py-1.5 hover:bg-bg-subtle" onClick={() => setEditing(true)}>
      {item.description ? <Markdown text={item.description} /> : <span className="text-sm text-fg-faint">Add a description…</span>}
    </div>
  );
}

function Transitions({ item }: { item: ItemRow }) {
  const options = useTransitions(item);
  const a = useActions();
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Tooltip key={o.transition.id} content={o.allowed ? null : <ul className="list-disc pl-3 text-left">{o.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}>
          <Button size="sm" variant="outline" disabled={!o.allowed} onClick={() => void a.transition(item.id, o.transition.key)} icon={<StateDot color={o.toState.color ?? stateColor(undefined)} category={o.toState.category} />}>
            {o.transition.name}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

function Rollup({ children }: { children: ItemRow[] }) {
  const { statesById } = useStore();
  if (children.length === 0) return null;
  const done = children.filter((c) => statesById[c.state_id]?.category === 'done').length;
  const canceled = children.filter((c) => statesById[c.state_id]?.category === 'canceled').length;
  const prog = children.filter((c) => statesById[c.state_id]?.category === 'in_progress').length;
  const total = children.length - canceled;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted" title={`${done} done, ${prog} in progress, ${canceled} canceled`}>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-bg-muted">
        <div className="flex h-full">
          <div className="h-full bg-ok" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          <div className="h-full bg-warn" style={{ width: `${total ? (prog / total) * 100 : 0}%` }} />
        </div>
      </div>
      <span>{pct}% · {done}/{total}</span>
    </div>
  );
}

function ParentAndChildren({ item }: { item: ItemRow }) {
  const children = useChildren(item.id);
  const { itemsById, statesById, typesById } = useStore();
  const { openItem, openQuickCreate } = useUI();
  const a = useActions();
  const parent = item.parent_id ? itemsById[item.parent_id] : undefined;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const type = typesById[item.type_id];
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Parent</span>
        {parent ? (
          <>
            <button className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-bg-muted" onClick={() => openItem(parent.key)}>
              <CornerLeftUp size={13} className="text-fg-faint" />
              <span className="font-mono text-xs text-fg-muted">{parent.key}</span>
              <span className="truncate">{parent.title}</span>
            </button>
            <button className="text-fg-faint hover:text-danger" title="Remove parent" onClick={() => void a.setParent(item.id, null)}><X size={13} /></button>
          </>
        ) : (
          <Button size="xs" variant="ghost" onClick={(e) => setAnchor(e.currentTarget)}>Set parent…</Button>
        )}
        <ItemPicker open={!!anchor} onClose={() => setAnchor(null)} anchor={anchor} exclude={new Set([item.id, ...children.map((c) => c.id)])} onPick={(p) => void a.setParent(item.id, p.id)} />
      </div>
      {(children.length > 0 || type?.is_container) && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Children ({children.length})</span>
              <Rollup children={children} />
            </div>
            <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => openQuickCreate({ project_id: item.project_id, parent_id: item.id })}>Add child</Button>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {children.map((c) => {
              const st = statesById[c.state_id];
              return (
                <li key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg-subtle">
                  <StateDot color={stateColor(st)} category={st?.category} />
                  <button className="font-mono text-xs text-fg-muted" onClick={() => openItem(c.key)}>{c.key}</button>
                  <button className={cn('min-w-0 flex-1 truncate text-left', isDone(st?.category) && 'text-fg-faint line-through')} onClick={() => openItem(c.key)}>{c.title}</button>
                  <AssigneeChip item={c} compact showName={false} />
                  <StateChip item={c} compact />
                </li>
              );
            })}
            {children.length === 0 && <li className="px-2 py-2 text-xs text-fg-faint">No children yet.</li>}
          </ul>
        </div>
      )}
    </section>
  );
}

function Watchers({ item }: { item: ItemRow }) {
  const watchers = useWatchers(item.id).filter((w) => !w.muted);
  const { usersById } = useStore();
  const { me } = useSession();
  const a = useActions();
  const watching = watchers.some((w) => w.user_id === me?.user.id);
  return (
    <div className="flex items-center gap-2">
      <Button size="xs" variant={watching ? 'secondary' : 'ghost'} icon={watching ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => (watching ? void a.unwatch(item.id) : void a.watch(item.id))}>
        {watching ? 'Unwatch' : 'Watch'}
      </Button>
      <div className="flex -space-x-1">
        {watchers.slice(0, 6).map((w) => (
          <Avatar key={w.user_id} user={usersById[w.user_id]} size={18} className="ring-2 ring-bg" />
        ))}
      </div>
      {watchers.length > 6 && <span className="text-xs text-fg-faint">+{watchers.length - 6}</span>}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[28px] items-center gap-2">
      <div className="w-24 shrink-0 text-xs text-fg-muted">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ItemDetail({ item, compact }: { item: ItemRow; compact?: boolean }) {
  const { typesById, projectsById, statesById } = useStore();
  const a = useActions();
  const { setOpenItemId } = useUI();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [estimate, setEstimate] = useState(item.estimate?.toString() ?? '');
  useEffect(() => setEstimate(item.estimate?.toString() ?? ''), [item.estimate]);
  useEffect(() => {
    setOpenItemId(item.id);
    return () => setOpenItemId(null);
  }, [item.id, setOpenItemId]);
  const type = typesById[item.type_id];
  const project = projectsById[item.project_id];
  const state = statesById[item.state_id];
  const defs = useMemo(() => type?.field_defs ?? [], [type]);

  const properties = (
    <div className={cn('space-y-1', !compact && 'rounded-lg border border-border p-3')}>
      <PropRow label="State">
        <div className="flex items-center gap-2"><StateChip item={item} /><span className="text-xs text-fg-faint">{state?.category.replace('_', ' ')}</span></div>
      </PropRow>
      <PropRow label="Assignee"><AssigneeChip item={item} /></PropRow>
      <PropRow label="Priority"><PriorityChip item={item} /></PropRow>
      <PropRow label="Start"><DueDateChip item={item} field="start_date" /></PropRow>
      <PropRow label="Due"><DueDateChip item={item} /></PropRow>
      <PropRow label="Estimate">
        <input
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          onBlur={() => { const v = estimate === '' ? null : Number(estimate); if (v !== item.estimate && (v === null || !Number.isNaN(v))) void a.setEstimate(item.id, v); }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          placeholder="—"
          className="h-7 w-20 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] hover:border-border focus:border-accent focus:outline-none"
          type="number"
          step="0.5"
        />
      </PropRow>
      <PropRow label="Labels"><LabelsChip item={item} max={6} /></PropRow>
      <PropRow label="Type"><TypeChip item={item} /></PropRow>
      <PropRow label="Project"><Link to={`/p/${project?.key}`} className="text-[13px] hover:underline">{project?.name ?? '—'}</Link></PropRow>
      <PropRow label="Confidential">
        <button className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] hover:bg-bg-muted', item.confidential ? 'text-warn' : 'text-fg-faint')} onClick={() => void a.setConfidential(item.id, !item.confidential)}>
          <Lock size={13} /> {item.confidential ? 'Yes — members only' : 'No'}
        </button>
      </PropRow>
      {defs.length > 0 && (
        <div className="mt-2 border-t border-border pt-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-faint">{type?.name} fields</div>
          <FieldsEditor defs={defs} fields={item.fields} onCommit={(patch) => void a.setFields(item.id, patch)} />
        </div>
      )}
      <div className="mt-2 border-t border-border pt-3">
        <Watchers item={item} />
      </div>
    </div>
  );

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', compact ? 'p-4' : 'p-6')}>
      <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
        {project && <Link to={`/p/${project.key}`} className="hover:text-fg">{project.name}</Link>}
        <ChevronRight size={12} className="text-fg-faint" />
        <span className="font-mono">{item.key}</span>
        <span className="rounded bg-bg-muted px-1.5 py-0.5" style={{ color: type?.color ?? undefined }}>{type?.name}</span>
        {item.confidential && <Lock size={12} className="text-warn" />}
        {item.is_blocked && <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger">Blocked</span>}
        <span className="ml-auto flex items-center gap-1">
          {!compact && <Kbd keys="e" />}
          <Button size="xs" variant="ghost" className="text-fg-faint hover:text-danger" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)} title="Delete item" />
        </span>
      </div>
      <TitleEditor item={item} />
      <div className="mt-2 mb-4"><Transitions item={item} /></div>

      <div className={cn(compact ? 'space-y-5' : 'grid grid-cols-[minmax(0,1fr)_300px] gap-8')}>
        <div className="space-y-6">
          {compact && properties}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-faint">Description</h3>
            <DescriptionEditor item={item} />
          </section>
          <ParentAndChildren item={item} />
          <RelationsSection item={item} />
          <CommentsSection itemId={item.id} />
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-faint">Activity</h3>
            <ActivitySection item={item} />
          </section>
        </div>
        {!compact && <div>{properties}</div>}
      </div>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${item.key}?`} body="The item is soft-deleted; you can undo from the toast." onConfirm={() => void a.remove([item.id])} />
    </div>
  );
}
