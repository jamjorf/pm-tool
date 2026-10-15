// Relations: blocks / blocked by / duplicates / relates / external links; add via palette-style picker.
import { useState } from 'react';
import { Plus, X, GitPullRequest, MessageSquare, Mail, ExternalLink, Link2, Ban, Copy, Shuffle } from 'lucide-react';
import type { ItemRow, Relation } from '@pm/core';
import { useRelations, useStore } from '../../store/hooks';
import { useActions } from './useActions';
import { useUI } from '../../state';
import { ItemPicker } from './ItemPicker';
import { Button, Input, Picker, Popover, StateDot, type PickerItem } from '../ui';
import { stateColor, cn } from '../../lib/util';

type Group = { key: string; title: string; icon: React.ReactNode; rows: { rel: Relation; otherId: string | null }[] };

export function externalIcon(kind: string | null) {
  switch (kind) {
    case 'github_pr':
    case 'github':
    case 'pr':
      return <GitPullRequest size={13} />;
    case 'slack':
      return <MessageSquare size={13} />;
    case 'email':
      return <Mail size={13} />;
    default:
      return <ExternalLink size={13} />;
  }
}

function externalHref(rel: Relation): string | undefined {
  const ref = rel.external_ref as Record<string, unknown> | null;
  const url = ref?.url ?? ref?.html_url ?? ref?.permalink;
  return typeof url === 'string' ? url : undefined;
}
function externalLabel(rel: Relation): string {
  const ref = rel.external_ref as Record<string, unknown> | null;
  const t = ref?.title ?? ref?.subject ?? ref?.name;
  if (typeof t === 'string') return t;
  return rel.external_key ?? (typeof ref?.id === 'string' || typeof ref?.id === 'number' ? `${rel.external_kind}#${ref.id}` : rel.external_kind ?? 'link');
}

export function RelationsSection({ item }: { item: ItemRow }) {
  const rels = useRelations(item.id).filter((r) => r.type !== 'parent_of');
  const { itemsById, statesById } = useStore();
  const a = useActions();
  const { openItem } = useUI();
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [mode, setMode] = useState<{ type: string; direction: 'out' | 'in' } | null>(null);
  const [extOpen, setExtOpen] = useState(false);
  const [ext, setExt] = useState({ kind: 'url', url: '', title: '' });

  const groups: Group[] = [
    { key: 'blocks', title: 'Blocks', icon: <Ban size={13} />, rows: [] },
    { key: 'blocked_by', title: 'Blocked by', icon: <Ban size={13} className="text-danger" />, rows: [] },
    { key: 'duplicates', title: 'Duplicates', icon: <Copy size={13} />, rows: [] },
    { key: 'duplicated_by', title: 'Duplicated by', icon: <Copy size={13} />, rows: [] },
    { key: 'relates_to', title: 'Relates to', icon: <Shuffle size={13} />, rows: [] },
    { key: 'links_to', title: 'Links', icon: <Link2 size={13} />, rows: [] },
  ];
  const g = (k: string) => groups.find((x) => x.key === k)!;
  for (const r of rels) {
    const out = r.from_item_id === item.id;
    const otherId = out ? r.to_item_id : r.from_item_id;
    if (r.type === 'blocks') g(out ? 'blocks' : 'blocked_by').rows.push({ rel: r, otherId });
    else if (r.type === 'duplicates') g(out ? 'duplicates' : 'duplicated_by').rows.push({ rel: r, otherId });
    else if (r.type === 'links_to' || r.external_kind) g('links_to').rows.push({ rel: r, otherId });
    else g('relates_to').rows.push({ rel: r, otherId });
  }

  const addItems: PickerItem[] = [
    { id: 'blocks:out', label: 'Blocks…', icon: <Ban size={13} /> },
    { id: 'blocks:in', label: 'Blocked by…', icon: <Ban size={13} /> },
    { id: 'duplicates:out', label: 'Duplicates…', icon: <Copy size={13} /> },
    { id: 'relates_to:out', label: 'Relates to…', icon: <Shuffle size={13} /> },
    { id: 'external', label: 'External link…', icon: <ExternalLink size={13} /> },
  ];

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Relations</h3>
        <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={(e) => setAddAnchor(e.currentTarget)}>Add</Button>
      </div>
      {rels.length === 0 && <div className="text-sm text-fg-faint">No relations.</div>}
      <div className="space-y-2">
        {groups.filter((gr) => gr.rows.length).map((gr) => (
          <div key={gr.key}>
            <div className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">{gr.icon}{gr.title}</div>
            <ul className="space-y-0.5">
              {gr.rows.map(({ rel, otherId }) => {
                const other = otherId ? itemsById[otherId] : undefined;
                const st = other ? statesById[other.state_id] : undefined;
                const href = externalHref(rel);
                return (
                  <li key={rel.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-bg-muted">
                    {other ? (
                      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => openItem(other.key)}>
                        <StateDot color={stateColor(st)} category={st?.category} />
                        <span className="font-mono text-xs text-fg-muted">{other.key}</span>
                        <span className={cn('truncate', (st?.category === 'done' || st?.category === 'canceled') && 'text-fg-faint line-through')}>{other.title}</span>
                      </button>
                    ) : rel.external_kind ? (
                      <a href={href} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                        <span className="text-fg-muted">{externalIcon(rel.external_kind)}</span>
                        <span className="truncate">{externalLabel(rel)}</span>
                        <span className="text-[10px] text-fg-faint">{rel.external_kind}</span>
                      </a>
                    ) : (
                      <span className="flex-1 text-fg-faint">{otherId?.slice(0, 8)} (not visible)</span>
                    )}
                    <button className="text-fg-faint opacity-0 hover:text-danger group-hover:opacity-100" title="Remove" onClick={() => void a.removeRelation(rel.id)}>
                      <X size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <Picker open={!!addAnchor && !mode && !extOpen} onClose={() => setAddAnchor(null)} anchor={addAnchor} items={addItems} width={220} placeholder="Relation type…" onSelect={(p) => {
        if (p.id === 'external') { setExtOpen(true); return; }
        const [type, dir] = p.id.split(':') as [string, 'out' | 'in'];
        setMode({ type, direction: dir });
      }} />
      <ItemPicker
        open={!!mode}
        onClose={() => { setMode(null); setAddAnchor(null); }}
        anchor={addAnchor}
        exclude={new Set([item.id])}
        projectId={item.project_id}
        placeholder={`${mode?.direction === 'in' ? 'Blocked by' : mode?.type ?? ''}: search items…`}
        onPick={(other) => {
          if (!mode) return;
          const from = mode.direction === 'out' ? item.id : other.id;
          const to = mode.direction === 'out' ? other.id : item.id;
          void a.addRelation({ type: mode.type, from_item_id: from, to_item_id: to });
          setMode(null);
          setAddAnchor(null);
        }}
      />
      <Popover open={extOpen} onClose={() => { setExtOpen(false); setAddAnchor(null); }} anchor={addAnchor} width={300} className="space-y-2 p-3">
        <div className="text-xs font-medium text-fg-muted">External link</div>
        <select value={ext.kind} onChange={(e) => setExt({ ...ext, kind: e.target.value })} className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm">
          <option value="url">URL</option>
          <option value="github_pr">GitHub PR</option>
          <option value="slack">Slack thread</option>
          <option value="email">Email</option>
        </select>
        <Input placeholder="https://…" value={ext.url} onChange={(e) => setExt({ ...ext, url: e.target.value })} autoFocus />
        <Input placeholder="Title (optional)" value={ext.title} onChange={(e) => setExt({ ...ext, title: e.target.value })} />
        <div className="flex justify-end gap-2">
          <Button size="xs" variant="ghost" onClick={() => { setExtOpen(false); setAddAnchor(null); }}>Cancel</Button>
          <Button size="xs" variant="primary" disabled={!ext.url} onClick={() => {
            void a.addRelation({ type: 'links_to', from_item_id: item.id, to_item_id: null, external_kind: ext.kind, external_ref: { url: ext.url, title: ext.title || undefined } });
            setExt({ kind: 'url', url: '', title: '' });
            setExtOpen(false);
            setAddAnchor(null);
          }}>Add</Button>
        </div>
      </Popover>
    </section>
  );
}
