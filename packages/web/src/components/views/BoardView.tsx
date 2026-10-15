// Kanban board: columns from board.column_field (default state_id). Drag between columns = transition
// (guards evaluated locally; failures toast + snap back); drag within a column = reorderItem.
import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, closestCorners, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, Lock, Ban } from 'lucide-react';
import { PRIORITY_LABELS, STATE_CATEGORY_ORDER, type ItemRow, type Project, type ViewSpec, type WorkflowState } from '@pm/core';
import { useStore } from '../../store/hooks';
import { useSession } from '../../session';
import { useUI } from '../../state';
import { useActions } from '../items/useActions';
import { evaluateMoveToState } from '../../store/guards';
import { AssigneeChip, PriorityIcon, DueDateLabel } from '../items/properties';
import { Badge, StateDot } from '../ui';
import { toastError } from '../../lib/toast';
import { cn, CATEGORY_LABEL, CATEGORY_COLOR, stateColor } from '../../lib/util';

interface Column { key: string; label: string; color?: string; stateIds?: string[]; category?: string; items: ItemRow[] }

function Card({ item, overlay }: { item: ItemRow; overlay?: boolean }) {
  const { typesById, labelsById, statesById } = useStore();
  const { openItem, selected } = useUI();
  const type = typesById[item.type_id];
  const st = statesById[item.state_id];
  return (
    <div
      className={cn('cursor-grab rounded-lg border border-border bg-bg-elevated p-2.5 text-[13px] shadow-sm hover:border-border-strong', overlay && 'rotate-1 shadow-[var(--shadow)]', selected.has(item.id) && 'ring-2 ring-accent')}
      onClick={() => openItem(item.number > 0 ? item.key : item.id)}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
        <span className="font-mono">{item.key}</span>
        <span className="rounded px-1" style={{ background: (type?.color ?? '#999') + '22', color: type?.color ?? undefined }}>{type?.name}</span>
        {item.confidential && <Lock size={11} className="text-warn" />}
        {item.is_blocked && <span className="flex items-center gap-0.5 text-danger"><Ban size={11} /> blocked</span>}
        <span className="ml-auto"><PriorityIcon priority={item.priority} size={12} /></span>
      </div>
      <div className="leading-snug">{item.title}</div>
      {(item.label_ids?.length ?? 0) > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.label_ids!.slice(0, 4).map((id) => labelsById[id] && <Badge key={id} color={labelsById[id]!.color ?? 'var(--fg-faint)'}>{labelsById[id]!.name}</Badge>)}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
        <span className="flex items-center gap-1"><StateDot color={stateColor(st)} category={st?.category} /> {st?.name}</span>
        <span className="flex items-center gap-2">
          {item.due_date && <DueDateLabel date={item.due_date} done={st?.category === 'done' || st?.category === 'canceled'} />}
          <span onClick={(e) => e.stopPropagation()}><AssigneeChip item={item} compact showName={false} /></span>
        </span>
      </div>
    </div>
  );
}

function SortableCard({ item }: { item: ItemRow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners} className={cn(isDragging && 'opacity-30')}>
      <Card item={item} />
    </div>
  );
}

function ColumnView({ col, laneKey, onAdd }: { col: Column; laneKey: string; onAdd?: () => void }) {
  const id = `${laneKey}::${col.key}`;
  const { setNodeRef, isOver } = useDroppable({ id, data: { col, laneKey } });
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg bg-bg-subtle">
      <div className="flex h-9 items-center gap-2 px-3 text-[13px] font-medium">
        {col.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: col.color }} />}
        <span className="truncate">{col.label}</span>
        <span className="text-xs text-fg-faint">{col.items.length}</span>
        {onAdd && <button className="ml-auto text-fg-faint hover:text-fg" onClick={onAdd} title="New item here"><Plus size={14} /></button>}
      </div>
      <div ref={setNodeRef} className={cn('flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2', isOver && 'rounded-b-lg ring-2 ring-inset ring-accent/40')}>
        <SortableContext id={id} items={col.items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {col.items.map((it) => <SortableCard key={it.id} item={it} />)}
        </SortableContext>
      </div>
    </div>
  );
}

export function BoardView({ items, spec, project }: { items: ItemRow[]; spec: ViewSpec; project?: Project }) {
  const store = useStore();
  const { me } = useSession();
  const a = useActions();
  const { openQuickCreate } = useUI();
  const [active, setActive] = useState<ItemRow | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const field = spec.board?.column_field ?? 'state_id';
  const swim = spec.board?.swimlane_field ?? null;
  const hideEmpty = spec.board?.hide_empty ?? false;

  // Column definitions
  const columnDefs = useMemo<Omit<Column, 'items'>[]>(() => {
    if (field === 'state_id') {
      const typeIds = new Set(items.map((i) => i.type_id));
      if (project?.allowed_type_ids?.length) project.allowed_type_ids.forEach((t) => typeIds.add(t));
      if (typeIds.size === 0) store.types.forEach((t) => typeIds.add(t.id));
      const wfIds = new Set([...typeIds].map((t) => store.typesById[t]?.workflow_id).filter((x): x is string => !!x));
      if (wfIds.size === 1) {
        const wf = store.workflowsById[[...wfIds][0]!];
        return (wf?.states ?? []).map((s: WorkflowState) => ({ key: s.id, label: s.name, color: stateColor(s), stateIds: [s.id], category: s.category }));
      }
      // mixed workflows: group by category
      return STATE_CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_LABEL[c]!, color: CATEGORY_COLOR[c], category: c, stateIds: [...wfIds].flatMap((id) => (store.workflowsById[id]?.states ?? []).filter((s) => s.category === c).map((s) => s.id)) }));
    }
    if (field === 'state.category') return STATE_CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_LABEL[c]!, color: CATEGORY_COLOR[c], category: c }));
    if (field === 'priority') return [1, 2, 3, 4, 0].map((p) => ({ key: String(p), label: PRIORITY_LABELS[p]! }));
    if (field === 'assignee_id') return [{ key: '', label: 'Unassigned' }, ...store.users.filter((u) => u.is_active && !u.is_service).map((u) => ({ key: u.id, label: u.name }))];
    if (field === 'type_id') return store.types.map((t) => ({ key: t.id, label: t.name, color: t.color ?? undefined }));
    if (field === 'project_id') return store.projects.map((p) => ({ key: p.id, label: p.name }));
    if (field.startsWith('fields.')) {
      const key = field.slice(7);
      const def = store.types.flatMap((t) => t.field_defs).find((d) => d.key === key);
      if (def?.options) return [{ key: '', label: '—' }, ...def.options.map((o) => ({ key: o.value, label: o.label, color: o.color }))];
    }
    // generic: distinct values
    const vals = new Set(items.map((i) => String(valueOf(i, field) ?? '')));
    return [...vals].sort().map((v) => ({ key: v, label: v || '—' }));
  }, [field, items, project, store]);

  const order = spec.board?.column_order;
  const orderedDefs = useMemo(() => (order?.length ? [...columnDefs].sort((x, y) => idx(order, x) - idx(order, y)) : columnDefs), [columnDefs, order]);

  const laneDefs = useMemo(() => {
    if (!swim) return [{ key: '*', label: '' }];
    const vals = new Map<string, string>();
    for (const it of items) {
      const v = valueOf(it, swim);
      const k = String(v ?? '');
      if (!vals.has(k)) vals.set(k, labelFor(store, swim, v));
    }
    return [...vals.entries()].sort((x, y) => x[1].localeCompare(y[1])).map(([key, label]) => ({ key, label: label || '—' }));
  }, [swim, items, store]);

  const columnsByLane = useMemo(() => {
    const out: Record<string, Column[]> = {};
    for (const lane of laneDefs) {
      const laneItems = swim ? items.filter((i) => String(valueOf(i, swim) ?? '') === lane.key) : items;
      const cols: Column[] = orderedDefs.map((d) => ({ ...d, items: [] }));
      const byKey = new Map(cols.map((c) => [c.key, c]));
      const byState = new Map<string, Column>();
      for (const c of cols) for (const s of c.stateIds ?? []) byState.set(s, c);
      for (const it of laneItems) {
        let col: Column | undefined;
        if (field === 'state_id') col = byState.get(it.state_id);
        else col = byKey.get(String(valueOf(it, field) ?? ''));
        if (!col) continue;
        col.items.push(it);
      }
      for (const c of cols) c.items.sort((x, y) => x.sort_order - y.sort_order || x.created_at.localeCompare(y.created_at));
      out[lane.key] = hideEmpty ? cols.filter((c) => c.items.length) : cols;
    }
    return out;
  }, [laneDefs, orderedDefs, items, field, swim, hideEmpty]);

  const findColumn = (lane: string, itemId: string) => columnsByLane[lane]?.find((c) => c.items.some((i) => i.id === itemId));

  const onDragEnd = async (e: DragEndEvent) => {
    setActive(null);
    const { active: act, over } = e;
    if (!over) return;
    const item = store.itemsById[String(act.id)];
    if (!item) return;
    const overData = over.data.current as { col?: Column; laneKey?: string; sortable?: { containerId: string; index: number } } | undefined;
    const containerId = overData?.sortable?.containerId ?? String(over.id);
    const [laneKey, colKey] = containerId.split('::') as [string, string];
    const target = columnsByLane[laneKey]?.find((c) => c.key === colKey);
    if (!target) return;
    const source = findColumn(laneKey, item.id) ?? Object.values(columnsByLane).flat().find((c) => c.items.some((i) => i.id === item.id));
    const overItem = overData?.sortable ? store.itemsById[String(over.id)] : undefined;

    // 1. Column change
    if (source?.key !== target.key) {
      if (field === 'state_id') {
        const toStateId = target.stateIds?.find((s) => store.statesById[s]?.workflow_id === store.typesById[item.type_id]?.workflow_id) ?? target.stateIds?.[0];
        if (!toStateId) return;
        const ev = evaluateMoveToState(store, me!, item, toStateId);
        if (!ev) { toastError('No transition', `There is no transition from "${store.statesById[item.state_id]?.name}" to "${target.label}".`); return; }
        if (ev.result && !ev.result.ok) { toastError(`"${ev.transition.name}" blocked`, ev.result.failures.map((f) => '• ' + f.reason).join('\n')); return; }
        await a.transition(item.id, ev.transition.key);
      } else if (field === 'priority') await a.setPriority([item.id], Number(target.key));
      else if (field === 'assignee_id') await a.setAssignee([item.id], target.key || null);
      else if (field === 'type_id') await a.setType(item.id, target.key);
      else if (field === 'project_id') await a.move([item.id], target.key);
      else if (field.startsWith('fields.')) await a.setFields(item.id, { [field.slice(7)]: target.key || null });
      else return;
    }
    // 2. Reorder within target (sort_order between neighbours)
    const list = target.items.filter((i) => i.id !== item.id);
    let index = overItem ? list.findIndex((i) => i.id === overItem.id) : list.length;
    if (index < 0) index = list.length;
    const prev = list[index - 1];
    const next = list[index];
    let sortOrder: number;
    if (prev && next) sortOrder = (prev.sort_order + next.sort_order) / 2;
    else if (prev) sortOrder = prev.sort_order + 1000;
    else if (next) sortOrder = next.sort_order - 1000;
    else sortOrder = item.sort_order;
    if (sortOrder !== item.sort_order) await a.reorder(item.id, sortOrder);
  };

  const onDragStart = (e: DragStartEvent) => setActive(store.itemsById[String(e.active.id)] ?? null);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={(e) => void onDragEnd(e)} onDragCancel={() => setActive(null)}>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {laneDefs.map((lane) => (
          <div key={lane.key} className="mb-4">
            {swim && <div className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-fg-faint">{lane.label}</div>}
            <div className="flex items-start gap-3">
              {(columnsByLane[lane.key] ?? []).map((col) => (
                <ColumnView key={col.key} col={col} laneKey={lane.key} onAdd={field === 'state_id' && project ? () => openQuickCreate({ project_id: project.id, state_id: col.stateIds?.[0] }) : undefined} />
              ))}
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="p-12 text-center text-sm text-fg-muted">No items match this view.</div>}
      </div>
      <DragOverlay>{active ? <div className="w-72"><Card item={active} overlay /></div> : null}</DragOverlay>
    </DndContext>
  );
}

function idx(order: string[], c: { key: string }): number {
  const i = order.indexOf(c.key);
  return i < 0 ? 1e6 : i;
}

function valueOf(item: ItemRow, field: string): unknown {
  if (field.startsWith('fields.')) return item.fields[field.slice(7)];
  if (field === 'state.category') return item.state_category;
  return (item as unknown as Record<string, unknown>)[field];
}

function labelFor(store: ReturnType<typeof useStore>, field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  switch (field) {
    case 'assignee_id': case 'reporter_id': case 'created_by': return store.usersById[s]?.name ?? s;
    case 'type_id': return store.typesById[s]?.name ?? s;
    case 'project_id': return store.projectsById[s]?.name ?? s;
    case 'state_id': return store.statesById[s]?.name ?? s;
    case 'priority': return PRIORITY_LABELS[Number(s)] ?? s;
    case 'state.category': return CATEGORY_LABEL[s] ?? s;
    default: return s;
  }
}
