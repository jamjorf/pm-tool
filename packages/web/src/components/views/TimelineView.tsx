// Gantt timeline: rows = items (or grouped), zoom week/month/quarter, today line, drag to move/resize,
// dependency arrows for `blocks` relations, unscheduled list below.
import { useMemo, useRef, useState } from 'react';
import { addDays, differenceInCalendarDays, eachMonthOfInterval, eachWeekOfInterval, format, max as maxDate, min as minDate, parseISO, startOfDay, startOfMonth, startOfWeek, startOfQuarter, addMonths, addWeeks, eachQuarterOfInterval, addQuarters } from 'date-fns';
import type { ItemRow, Project, ViewSpec } from '@pm/core';
import { useStore } from '../../store/hooks';
import { useUI } from '../../state';
import { useActions } from '../items/useActions';
import type { Group } from './query';
import { cn, stateColor, todayIso } from '../../lib/util';
import { Button } from '../ui';

const PX: Record<'week' | 'month' | 'quarter', number> = { week: 36, month: 12, quarter: 4 };
const ROW_H = 32;
const LABEL_W = 260;

type Drag = { id: string; mode: 'move' | 'start' | 'end'; originX: number; start: Date; end: Date; dx: number };

export function TimelineView({ items, groups, spec, project, onZoom }: { items: ItemRow[]; groups: Group[] | null; spec: ViewSpec; project?: Project; onZoom: (z: 'week' | 'month' | 'quarter') => void }) {
  const { statesById, relations, itemsById } = useStore();
  const { openItem } = useUI();
  const a = useActions();
  const zoom = spec.timeline?.zoom ?? 'month';
  const startField = (spec.timeline?.start_field ?? 'start_date') as keyof ItemRow;
  const endField = (spec.timeline?.end_field ?? 'due_date') as keyof ItemRow;
  const showDeps = spec.timeline?.show_dependencies ?? true;
  const px = PX[zoom];
  const [drag, setDrag] = useState<Drag | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  void project;

  const dateOf = (it: ItemRow, f: keyof ItemRow): Date | null => {
    const v = it[f];
    if (typeof v !== 'string' || !v) return null;
    return startOfDay(v.length > 10 ? new Date(v) : parseISO(v));
  };

  const rows = useMemo(() => {
    const rs: ({ kind: 'header'; label: string; count: number } | { kind: 'item'; item: ItemRow; start: Date; end: Date })[] = [];
    const unscheduled: ItemRow[] = [];
    const push = (it: ItemRow) => {
      const s = dateOf(it, startField);
      const e = dateOf(it, endField);
      if (!s && !e) { unscheduled.push(it); return; }
      const start = s ?? e!;
      const end = e ?? s!;
      rs.push({ kind: 'item', item: it, start, end: end < start ? start : end });
    };
    if (groups) for (const g of groups) { rs.push({ kind: 'header', label: g.label || '—', count: g.items.length }); g.items.forEach(push); }
    else items.forEach(push);
    return { rows: rs, unscheduled };
  }, [items, groups, startField, endField]);

  const today = startOfDay(new Date());
  const dates = rows.rows.filter((r): r is Extract<typeof r, { kind: 'item' }> => r.kind === 'item');
  const rangeStart = useMemo(() => {
    const m = dates.length ? minDate([...dates.map((d) => d.start), today]) : today;
    return zoom === 'week' ? startOfWeek(addDays(m, -7), { weekStartsOn: 1 }) : zoom === 'month' ? startOfMonth(addDays(m, -14)) : startOfQuarter(addDays(m, -30));
  }, [dates, today, zoom]);
  const rangeEnd = useMemo(() => {
    const m = dates.length ? maxDate([...dates.map((d) => d.end), addDays(today, 30)]) : addDays(today, 60);
    return zoom === 'week' ? addWeeks(m, 2) : zoom === 'month' ? addMonths(m, 1) : addQuarters(m, 1);
  }, [dates, today, zoom]);
  const totalDays = differenceInCalendarDays(rangeEnd, rangeStart) + 1;
  const width = totalDays * px;
  const x = (d: Date) => differenceInCalendarDays(d, rangeStart) * px;

  const ticks = useMemo(() => {
    if (zoom === 'week') return eachWeekOfInterval({ start: rangeStart, end: rangeEnd }, { weekStartsOn: 1 }).map((d) => ({ d, label: format(d, 'd MMM') }));
    if (zoom === 'month') return eachMonthOfInterval({ start: rangeStart, end: rangeEnd }).map((d) => ({ d, label: format(d, 'MMM yyyy') }));
    return eachQuarterOfInterval({ start: rangeStart, end: rangeEnd }).map((d) => ({ d, label: format(d, 'QQQ yyyy') }));
  }, [zoom, rangeStart, rangeEnd]);

  const rowIndex = new Map<string, number>();
  rows.rows.forEach((r, i) => { if (r.kind === 'item') rowIndex.set(r.item.id, i); });

  const deps = useMemo(() => {
    if (!showDeps) return [];
    return relations.filter((r) => r.type === 'blocks' && r.to_item_id && rowIndex.has(r.from_item_id) && rowIndex.has(r.to_item_id)).map((r) => ({ from: r.from_item_id, to: r.to_item_id! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relations, showDeps, rows.rows]);

  const barFor = (id: string) => {
    const r = rows.rows[rowIndex.get(id) ?? -1];
    if (!r || r.kind !== 'item') return null;
    let { start, end } = r;
    if (drag?.id === id) {
      const days = Math.round(drag.dx / px);
      if (drag.mode === 'move') { start = addDays(drag.start, days); end = addDays(drag.end, days); }
      else if (drag.mode === 'start') start = minDate([addDays(drag.start, days), drag.end]);
      else end = maxDate([addDays(drag.end, days), drag.start]);
    }
    return { start, end, left: x(start), width: Math.max(px, (differenceInCalendarDays(end, start) + 1) * px) };
  };

  const onPointerDown = (e: React.PointerEvent, r: Extract<(typeof rows.rows)[number], { kind: 'item' }>, mode: Drag['mode']) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: r.item.id, mode, originX: e.clientX, start: r.start, end: r.end, dx: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.originX }); };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const bar = barFor(drag.id);
    const moved = Math.abs(drag.dx) >= px / 2;
    setDrag(null);
    if (!bar) return;
    if (!moved) { const it = itemsById[drag.id]; if (it) openItem(it.number > 0 ? it.key : it.id); return; }
    const patch: Record<string, string> = {};
    if (drag.mode !== 'end') patch[startField as string] = todayIso(bar.start);
    if (drag.mode !== 'start') patch[endField as string] = todayIso(bar.end);
    void a.update(drag.id, patch);
    void e;
  };

  const height = rows.rows.length * ROW_H;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1">
        <span className="text-xs text-fg-muted">Zoom</span>
        {(['week', 'month', 'quarter'] as const).map((z) => (
          <Button key={z} size="xs" variant={zoom === z ? 'secondary' : 'ghost'} onClick={() => onZoom(z)}>{z}</Button>
        ))}
        <Button size="xs" variant="ghost" className="ml-2" onClick={() => scrollRef.current?.scrollTo({ left: Math.max(0, x(today) - 300), behavior: 'smooth' })}>Today</Button>
        <span className="ml-auto text-xs text-fg-faint">{startField} → {endField} · drag to move, edges to resize</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <div className="relative" style={{ width: LABEL_W + width, minHeight: '100%' }}>
          {/* header */}
          <div className="sticky top-0 z-20 flex h-8 border-b border-border bg-bg-subtle">
            <div className="sticky left-0 z-30 w-[260px] shrink-0 border-r border-border bg-bg-subtle px-3 text-[11px] font-medium uppercase leading-8 tracking-wider text-fg-faint">Item</div>
            <div className="relative" style={{ width }}>
              {ticks.map((t) => (
                <div key={t.d.toISOString()} className="absolute top-0 h-8 border-l border-border pl-1.5 text-[11px] leading-8 text-fg-muted" style={{ left: x(t.d) }}>{t.label}</div>
              ))}
            </div>
          </div>
          {/* body */}
          <div className="relative" style={{ height: Math.max(height, 200) }}>
            <div className="absolute inset-y-0 tl-grid" style={{ left: LABEL_W, width, backgroundSize: `${(zoom === 'week' ? 7 : zoom === 'month' ? 7 : 30) * px}px 100%` }} />
            <div className="absolute inset-y-0 z-10 w-px bg-danger" style={{ left: LABEL_W + x(today) + px / 2 }} title="Today" />
            {rows.rows.map((r, i) => {
              const top = i * ROW_H;
              if (r.kind === 'header') return (
                <div key={'h' + i} className="absolute left-0 flex items-center border-b border-border bg-bg text-xs font-semibold text-fg-muted" style={{ top, height: ROW_H, width: LABEL_W + width }}>
                  <span className="sticky left-0 px-3">{r.label} <span className="font-normal text-fg-faint">{r.count}</span></span>
                </div>
              );
              const st = statesById[r.item.state_id];
              const bar = barFor(r.item.id)!;
              return (
                <div key={r.item.id} className="absolute left-0 border-b border-border/60" style={{ top, height: ROW_H, width: LABEL_W + width }}>
                  <button className="sticky left-0 z-10 flex h-full w-[260px] items-center gap-2 truncate border-r border-border bg-bg px-3 text-left text-[13px] hover:bg-bg-subtle" onClick={() => openItem(r.item.number > 0 ? r.item.key : r.item.id)}>
                    <span className="font-mono text-[11px] text-fg-muted">{r.item.key}</span>
                    <span className="truncate">{r.item.title}</span>
                  </button>
                  <div
                    className={cn('absolute top-1.5 flex h-5 cursor-grab items-center rounded-md text-[11px] text-white select-none', drag?.id === r.item.id && 'opacity-80 ring-2 ring-accent')}
                    style={{ left: LABEL_W + bar.left, width: bar.width, background: stateColor(st) }}
                    onPointerDown={(e) => onPointerDown(e, r, 'move')}
                    title={`${r.item.key}: ${format(bar.start, 'd MMM')} → ${format(bar.end, 'd MMM')}`}
                  >
                    <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md hover:bg-black/20" onPointerDown={(e) => onPointerDown(e, r, 'start')} />
                    <span className="truncate px-2">{bar.width > 60 ? r.item.title : ''}</span>
                    <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md hover:bg-black/20" onPointerDown={(e) => onPointerDown(e, r, 'end')} />
                  </div>
                </div>
              );
            })}
            {deps.length > 0 && (
              <svg className="pointer-events-none absolute top-0 z-[5]" style={{ left: LABEL_W, width, height: Math.max(height, 200) }}>
                <defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--fg-muted)" /></marker></defs>
                {deps.map((d) => {
                  const from = barFor(d.from); const to = barFor(d.to);
                  if (!from || !to) return null;
                  const y1 = rowIndex.get(d.from)! * ROW_H + ROW_H / 2;
                  const y2 = rowIndex.get(d.to)! * ROW_H + ROW_H / 2;
                  const x1 = from.left + from.width; const x2 = to.left;
                  const mid = x1 + Math.max(12, (x2 - x1) / 2);
                  return <path key={d.from + d.to} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none" stroke="var(--fg-muted)" strokeWidth="1.5" strokeDasharray={x2 < x1 ? '4 3' : undefined} markerEnd="url(#arrow)" />;
                })}
              </svg>
            )}
          </div>
          {rows.unscheduled.length > 0 && (
            <div className="sticky left-0 border-t border-border px-3 py-2" style={{ width: 'min(100%, 900px)' }}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-fg-faint">Unscheduled ({rows.unscheduled.length})</div>
              <ul className="space-y-0.5">
                {rows.unscheduled.map((it) => (
                  <li key={it.id}><button className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-bg-muted" onClick={() => openItem(it.number > 0 ? it.key : it.id)}><span className="font-mono text-[11px] text-fg-muted">{it.key}</span>{it.title}</button></li>
                ))}
              </ul>
            </div>
          )}
          {items.length === 0 && <div className="p-12 text-center text-sm text-fg-muted">No items match this view.</div>}
        </div>
      </div>
    </div>
  );
}
