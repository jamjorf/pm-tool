// Virtualized list/table with inline editing, collapsible groups, row selection (x, shift+click, ⌘A).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Lock, Ban } from 'lucide-react';
import { fieldLabel, type ItemRow, type Project } from '@pm/core';
import { useStore } from '../../store/hooks';
import { useUI } from '../../state';
import { AssigneeChip, PriorityChip, StateChip, DueDateChip, LabelsChip, TypeChip, DueDateLabel } from '../items/properties';
import { DEFAULT_COLUMNS } from './filter';
import type { Group } from './query';
import { cn, relTime } from '../../lib/util';
import { format } from 'date-fns';

export interface ListViewProps {
  items: ItemRow[];
  groups: Group[] | null;
  columns?: string[];
  project?: Project;
  emptyText?: ReactNode;
  /** Height-constrained container (default: fill parent). */
  className?: string;
}

type Row = { kind: 'header'; group: Group; collapsed: boolean } | { kind: 'item'; item: ItemRow };

const WIDTHS: Record<string, string> = { key: '92px', title: 'minmax(240px,1fr)', state_id: '150px', assignee_id: '160px', priority: '110px', due_date: '110px', start_date: '110px', labels: '200px', type_id: '120px', estimate: '80px', created_at: '110px', updated_at: '110px', project_id: '110px', 'state.category': '110px', reporter_id: '150px', created_by: '150px', confidential: '60px', is_blocked: '70px' };

export function ListView({ items, groups, columns = DEFAULT_COLUMNS, project, emptyText, className }: ListViewProps) {
  const { types, usersById, projectsById, statesById, typesById, labelsById, itemsById } = useStore();
  const ui = useUI();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    if (!groups) return items.map((item) => ({ kind: 'item', item }));
    const out: Row[] = [];
    for (const g of groups) {
      const c = collapsed.has(g.key);
      out.push({ kind: 'header', group: g, collapsed: c });
      if (!c) for (const item of g.items) out.push({ kind: 'item', item });
    }
    return out;
  }, [items, groups, collapsed]);

  const visibleIds = useMemo(() => rows.filter((r): r is Extract<Row, { kind: 'item' }> => r.kind === 'item').map((r) => r.item.id), [rows]);
  const { setVisibleIds, focusedId, setFocused, selected, toggleSelected, selectRange, setAnchorId, anchorId, openItem } = ui;
  useEffect(() => {
    setVisibleIds(visibleIds);
    return () => setVisibleIds([]);
  }, [visibleIds, setVisibleIds]);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: (i) => (rows[i]?.kind === 'header' ? 32 : 36), overscan: 12 });
  useEffect(() => {
    if (!focusedId) return;
    const idx = rows.findIndex((r) => r.kind === 'item' && r.item.id === focusedId);
    if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' });
  }, [focusedId, rows, virt]);

  const allDefs = useMemo(() => types.flatMap((t) => t.field_defs), [types]);
  const colLabel = (c: string) => {
    try { return fieldLabel(c, allDefs); } catch { return c.replace(/^fields\./, '').replace(/_id$/, '').replace(/_/g, ' '); }
  };
  const gridTemplate = `28px ${columns.map((c) => WIDTHS[c] ?? '140px').join(' ')}`;

  const onRowClick = (e: React.MouseEvent, item: ItemRow) => {
    if (e.shiftKey && anchorId) {
      const a = visibleIds.indexOf(anchorId);
      const b = visibleIds.indexOf(item.id);
      if (a >= 0 && b >= 0) selectRange(visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1));
      setFocused(item.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) { toggleSelected(item.id); setFocused(item.id); return; }
    setFocused(item.id);
    setAnchorId(item.id);
    openItem(item.number > 0 ? item.key : item.id);
  };

  const cell = (item: ItemRow, c: string): ReactNode => {
    switch (c) {
      case 'key': return <span className="font-mono text-xs text-fg-muted">{item.key}</span>;
      case 'title': return (
        <span className="flex min-w-0 items-center gap-1.5">
          {item.confidential && <Lock size={12} className="shrink-0 text-warn" />}
          {item.is_blocked && <Ban size={12} className="shrink-0 text-danger" />}
          <span className={cn('truncate', (item.state_category === 'done' || item.state_category === 'canceled') && 'text-fg-muted')}>{item.title}</span>
        </span>
      );
      case 'state_id': return <StateChip item={item} compact />;
      case 'assignee_id': return <AssigneeChip item={item} compact />;
      case 'priority': return <PriorityChip item={item} compact />;
      case 'due_date': return <DueDateChip item={item} compact />;
      case 'start_date': return <DueDateChip item={item} compact field="start_date" />;
      case 'labels': return <LabelsChip item={item} compact />;
      case 'type_id': return <TypeChip item={item} compact />;
      case 'estimate': return <span className="text-fg-muted">{item.estimate ?? '—'}</span>;
      case 'project_id': return <span className="text-fg-muted">{projectsById[item.project_id]?.key}</span>;
      case 'state.category': return <span className="text-fg-muted">{item.state_category?.replace('_', ' ')}</span>;
      case 'reporter_id': case 'created_by': { const u = item[c] ? usersById[item[c]!] : undefined; return <span className="truncate text-fg-muted">{u?.name ?? '—'}</span>; }
      case 'created_at': case 'updated_at': case 'completed_at': return <span className="text-fg-muted" title={item[c] ?? ''}>{item[c] ? relTime(item[c]!) : '—'}</span>;
      case 'confidential': return <span className="text-fg-muted">{item.confidential ? 'yes' : ''}</span>;
      case 'is_blocked': return <span className="text-danger">{item.is_blocked ? 'blocked' : ''}</span>;
      case 'parent_id': return <span className="text-fg-muted">{item.parent_id ? itemsById[item.parent_id]?.key ?? '…' : '—'}</span>;
      default: {
        if (c.startsWith('fields.')) {
          const v = item.fields[c.slice(7)];
          const def = typesById[item.type_id]?.field_defs.find((d) => d.key === c.slice(7));
          if (v === null || v === undefined || v === '') return <span className="text-fg-faint">—</span>;
          if (def?.options) { const arr = Array.isArray(v) ? v : [v]; return <span className="truncate text-fg-muted">{arr.map((x) => def.options!.find((o) => o.value === x)?.label ?? String(x)).join(', ')}</span>; }
          if (def?.kind === 'user') return <span className="text-fg-muted">{usersById[String(v)]?.name ?? '—'}</span>;
          if (def?.kind === 'bool') return <span className="text-fg-muted">{v ? 'yes' : 'no'}</span>;
          if (def?.kind === 'date') return <DueDateLabel date={String(v)} done />;
          if (def?.kind === 'datetime') return <span className="text-fg-muted">{format(new Date(String(v)), 'd MMM HH:mm')}</span>;
          return <span className="truncate text-fg-muted">{String(v)}</span>;
        }
        const v = (item as unknown as Record<string, unknown>)[c];
        return <span className="truncate text-fg-muted">{v === null || v === undefined ? '—' : String(v)}</span>;
      }
    }
  };
  void labelsById; void statesById;

  if (items.length === 0) {
    return <div className="flex flex-1 items-center justify-center p-12 text-sm text-fg-muted">{emptyText ?? 'No items match this view.'}</div>;
  }

  return (
    <div ref={parentRef} className={cn('min-h-0 flex-1 overflow-auto', className)}>
      <div className="sticky top-0 z-10 grid h-8 min-w-max items-center border-b border-border bg-bg-subtle text-[11px] font-medium uppercase tracking-wider text-fg-faint" style={{ gridTemplateColumns: gridTemplate }}>
        <div className="flex justify-center">
          <input type="checkbox" className="h-3 w-3" checked={visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))} onChange={(e) => (e.target.checked ? ui.setSelected(visibleIds) : ui.clearSelection())} aria-label="Select all" />
        </div>
        {columns.map((c) => <div key={c} className="truncate px-2">{colLabel(c)}</div>)}
      </div>
      <div style={{ height: virt.getTotalSize(), position: 'relative' }} className="min-w-max">
        {virt.getVirtualItems().map((vr) => {
          const row = rows[vr.index]!;
          if (row.kind === 'header') {
            return (
              <button key={'g' + row.group.key} className="absolute left-0 flex w-full items-center gap-1.5 border-b border-border bg-bg px-2 text-left text-xs font-semibold text-fg-muted hover:bg-bg-subtle" style={{ top: vr.start, height: vr.size }} onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(row.group.key) ? n.delete(row.group.key) : n.add(row.group.key); return n; })}>
                {row.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {row.group.label || '—'} <span className="font-normal text-fg-faint">{row.group.items.length}</span>
              </button>
            );
          }
          const item = row.item;
          const isSel = selected.has(item.id);
          const isFocus = focusedId === item.id;
          return (
            <div
              key={item.id}
              data-row={item.id}
              className={cn('absolute left-0 grid w-full cursor-default items-center border-b border-border text-[13px] hover:bg-bg-subtle', isSel && 'bg-selection hover:bg-selection', isFocus && 'ring-1 ring-inset ring-accent')}
              style={{ top: vr.start, height: vr.size, gridTemplateColumns: gridTemplate }}
              onClick={(e) => onRowClick(e, item)}
              onMouseEnter={() => !focusedId && undefined}
            >
              <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" className="h-3 w-3" checked={isSel} onChange={() => toggleSelected(item.id)} aria-label={`Select ${item.key}`} />
              </div>
              {columns.map((c) => <div key={c} className="min-w-0 truncate px-2">{cell(item, c)}</div>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

