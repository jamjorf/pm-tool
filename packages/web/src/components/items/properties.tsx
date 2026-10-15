// Property pickers + inline chips shared by list cells, item detail, bulk bar and the palette.
import { useRef, useState, type ReactNode } from 'react';
import { Calendar, Check, Flag, Tag, Hash, Folder, CircleDashed } from 'lucide-react';
import { PRIORITY_LABELS, type ItemRow, type ItemType, type Label, type Project, type User } from '@pm/core';
import { Avatar, Badge, Picker, Popover, StateDot, type PickerItem } from '../ui';
import { useStore, useTransitions, useProjectLabels, useProjectTypes } from '../../store/hooks';
import { useActions } from './useActions';
import { cn, PRIORITY_COLOR, stateColor, todayIso } from '../../lib/util';
import { addDays, format, parseISO, isBefore, startOfDay } from 'date-fns';
import { useSession } from '../../session';

// ---------------------------------------------------------------------------
// Pickers (controlled popovers)
// ---------------------------------------------------------------------------
interface PickerBase {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
}

export function AssigneePicker({ open, onClose, anchor, value, onChange, projectId }: PickerBase & { value?: string | null; onChange: (userId: string | null) => void; projectId?: string }) {
  const { users, membersByProject } = useStore();
  const { me } = useSession();
  const memberIds = new Set((projectId && membersByProject[projectId]?.map((m) => m.user_id)) || []);
  const sorted = [...users.filter((u) => u.is_active && !u.is_service)].sort((a, b) => {
    const am = memberIds.has(a.id) ? 0 : 1;
    const bm = memberIds.has(b.id) ? 0 : 1;
    if (a.id === me?.user.id) return -1;
    if (b.id === me?.user.id) return 1;
    return am - bm || a.name.localeCompare(b.name);
  });
  const items: PickerItem[] = [
    { id: '', label: 'Unassigned', icon: <Avatar user={null} size={16} />, selected: value === null },
    ...sorted.map((u) => ({ id: u.id, label: u.id === me?.user.id ? `${u.name} (me)` : u.name, hint: u.email, icon: <Avatar user={u} size={16} />, selected: value === u.id, keywords: u.email })),
  ];
  return <Picker open={open} onClose={onClose} anchor={anchor} items={items} placeholder="Assign to…" onSelect={(i) => onChange(i.id || null)} />;
}

export function PriorityPicker({ open, onClose, anchor, value, onChange }: PickerBase & { value?: number; onChange: (p: number) => void }) {
  const items: PickerItem[] = [1, 2, 3, 4, 0].map((p) => ({ id: String(p), label: PRIORITY_LABELS[p]!, icon: <PriorityIcon priority={p} />, selected: value === p, hint: p === 0 ? '' : `P${p}` }));
  return <Picker open={open} onClose={onClose} anchor={anchor} items={items} placeholder="Set priority…" width={220} onSelect={(i) => onChange(Number(i.id))} />;
}

export function TransitionPicker({ open, onClose, anchor, item, onPick }: PickerBase & { item: ItemRow | undefined; onPick: (transitionKey: string) => void }) {
  const options = useTransitions(item);
  const items: PickerItem[] = options.map((o) => ({
    id: o.transition.key,
    label: o.transition.name,
    hint: `→ ${o.toState.name}`,
    icon: <StateDot color={o.toState.color ?? stateColor(undefined)} category={o.toState.category} />,
    disabled: !o.allowed,
    tooltip: o.allowed ? undefined : o.failures.join('\n'),
    keywords: o.toState.name,
  }));
  return <Picker open={open} onClose={onClose} anchor={anchor} items={items} placeholder="Transition…" emptyText="No transitions from this state" onSelect={(i) => onPick(i.id)} />;
}

export function LabelPicker({ open, onClose, anchor, projectId, selectedIds, onToggle, onCreate }: PickerBase & { projectId: string | null | undefined; selectedIds: Set<string>; onToggle: (labelId: string) => void; onCreate?: (name: string) => void }) {
  const labels = useProjectLabels(projectId);
  const items: PickerItem[] = labels.map((l) => ({ id: l.id, label: l.name, icon: <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color ?? 'var(--fg-faint)' }} />, selected: selectedIds.has(l.id), hint: l.project_id ? '' : 'firm' }));
  return <Picker open={open} onClose={onClose} anchor={anchor} items={items} multi placeholder="Add label…" onSelect={(i) => onToggle(i.id)} onCreate={onCreate} createLabel={(q) => `Create label "${q}"`} />;
}

export function TypePicker({ open, onClose, anchor, project, value, onChange }: PickerBase & { project: Project | undefined; value?: string; onChange: (typeId: string) => void }) {
  const types = useProjectTypes(project);
  const items: PickerItem[] = types.map((t) => ({ id: t.id, label: t.name, icon: <TypeIcon type={t} />, selected: value === t.id }));
  return <Picker open={open} onClose={onClose} anchor={anchor} items={items} placeholder="Type…" width={220} onSelect={(i) => onChange(i.id)} />;
}

export function ProjectPicker({ open, onClose, anchor, value, onChange }: PickerBase & { value?: string; onChange: (projectId: string) => void }) {
  const { projects } = useStore();
  const items: PickerItem[] = projects.filter((p) => !p.archived_at).map((p) => ({ id: p.id, label: p.name, hint: p.key, icon: <Folder size={14} />, selected: value === p.id, keywords: p.key }));
  return <Picker open={open} onClose={onClose} anchor={anchor} items={items} placeholder="Move to project…" onSelect={(i) => onChange(i.id)} />;
}

export function DatePicker({ open, onClose, anchor, value, onChange, label = 'Due date' }: PickerBase & { value?: string | null; onChange: (date: string | null) => void; label?: string }) {
  const [draft, setDraft] = useState(value ?? '');
  const today = new Date();
  const quick: { label: string; date: string | null }[] = [
    { label: 'Today', date: todayIso(today) },
    { label: 'Tomorrow', date: todayIso(addDays(today, 1)) },
    { label: 'In a week', date: todayIso(addDays(today, 7)) },
    { label: 'In two weeks', date: todayIso(addDays(today, 14)) },
    { label: 'Clear', date: null },
  ];
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={240} className="p-2">
      <div className="mb-1.5 px-1 text-xs font-medium text-fg-muted">{label}</div>
      <input
        type="date"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onChange(draft || null);
            onClose();
          }
          e.stopPropagation();
        }}
        className="mb-1.5 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm"
      />
      <div className="flex flex-col">
        {quick.map((q) => (
          <button
            key={q.label}
            className="rounded-md px-2 py-1 text-left text-sm hover:bg-bg-muted"
            onClick={() => {
              onChange(q.date);
              onClose();
            }}
          >
            {q.label}
            {q.date && <span className="float-right text-xs text-fg-faint">{format(parseISO(q.date), 'EEE d MMM')}</span>}
          </button>
        ))}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Visual atoms
// ---------------------------------------------------------------------------
export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const color = PRIORITY_COLOR[priority] ?? 'var(--fg-faint)';
  if (priority === 0) return <CircleDashed size={size} style={{ color }} />;
  if (priority === 1) return <Flag size={size} style={{ color }} fill={color} />;
  // bars: 2=high(3 bars),3=medium(2),4=low(1)
  const bars = priority === 2 ? 3 : priority === 3 ? 2 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1 + i * 4.5} y={10 - i * 3.5} width={3} height={3 + i * 3.5} rx={0.8} fill={i < bars ? color : 'var(--border-strong)'} />
      ))}
    </svg>
  );
}

export function TypeIcon({ type, size = 14 }: { type: ItemType | undefined; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded" style={{ width: size + 4, height: size + 4, background: (type?.color ?? '#9ca3af') + '22', color: type?.color ?? '#9ca3af' }} title={type?.name}>
      <Hash size={size - 2} />
    </span>
  );
}

export function DueDateLabel({ date, done }: { date: string | null; done?: boolean }) {
  if (!date) return <span className="text-fg-faint">—</span>;
  const d = parseISO(date);
  const overdue = !done && isBefore(d, startOfDay(new Date()));
  const soon = !done && !overdue && isBefore(d, addDays(startOfDay(new Date()), 3));
  return <span className={cn(overdue && 'text-danger', soon && 'text-warn')}>{format(d, d.getFullYear() === new Date().getFullYear() ? 'd MMM' : 'd MMM yyyy')}</span>;
}

// ---------------------------------------------------------------------------
// Chips: a button + its picker, bound to one or many items
// ---------------------------------------------------------------------------
function Chip({ children, onClick, className, title, compact }: { children: ReactNode; onClick: (el: HTMLButtonElement) => void; className?: string; title?: string; compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick(ref.current!);
      }}
      className={cn('inline-flex max-w-full items-center gap-1.5 rounded-md border border-transparent text-left text-[13px] hover:border-border hover:bg-bg-muted', compact ? 'h-6 px-1' : 'h-7 px-1.5', className)}
    >
      {children}
    </button>
  );
}

function usePickerState() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return { anchor, open: !!anchor, show: (el: HTMLElement) => setAnchor(el), close: () => setAnchor(null) };
}

export function AssigneeChip({ item, ids, compact, showName = true }: { item?: ItemRow; ids?: string[]; compact?: boolean; showName?: boolean }) {
  const p = usePickerState();
  const a = useActions();
  const { usersById } = useStore();
  const user = item?.assignee_id ? usersById[item.assignee_id] : undefined;
  const targets = ids ?? (item ? [item.id] : []);
  return (
    <>
      <Chip onClick={p.show} compact={compact} title="Assignee (a)">
        <Avatar user={user ?? null} size={compact ? 16 : 18} />
        {showName && <span className={cn('truncate', !user && 'text-fg-faint')}>{user?.name ?? (ids ? 'Assign' : 'Unassigned')}</span>}
      </Chip>
      <AssigneePicker open={p.open} onClose={p.close} anchor={p.anchor} value={item?.assignee_id} projectId={item?.project_id} onChange={(u) => void a.setAssignee(targets, u)} />
    </>
  );
}

export function PriorityChip({ item, ids, compact, showName = true }: { item?: ItemRow; ids?: string[]; compact?: boolean; showName?: boolean }) {
  const p = usePickerState();
  const a = useActions();
  const targets = ids ?? (item ? [item.id] : []);
  const pr = item?.priority ?? 0;
  return (
    <>
      <Chip onClick={p.show} compact={compact} title="Priority (p)">
        <PriorityIcon priority={pr} />
        {showName && <span className={cn('truncate', pr === 0 && 'text-fg-faint')}>{ids && !item ? 'Priority' : PRIORITY_LABELS[pr]}</span>}
      </Chip>
      <PriorityPicker open={p.open} onClose={p.close} anchor={p.anchor} value={item?.priority} onChange={(v) => void a.setPriority(targets, v)} />
    </>
  );
}

export function StateChip({ item, compact, showName = true }: { item: ItemRow; compact?: boolean; showName?: boolean }) {
  const p = usePickerState();
  const a = useActions();
  const { statesById } = useStore();
  const state = statesById[item.state_id];
  return (
    <>
      <Chip onClick={p.show} compact={compact} title="State (s)">
        <StateDot color={stateColor(state)} category={state?.category} />
        {showName && <span className="truncate">{state?.name ?? '?'}</span>}
      </Chip>
      <TransitionPicker open={p.open} onClose={p.close} anchor={p.anchor} item={item} onPick={(k) => void a.transition(item.id, k)} />
    </>
  );
}

export function DueDateChip({ item, ids, compact, field = 'due_date' }: { item?: ItemRow; ids?: string[]; compact?: boolean; field?: 'due_date' | 'start_date' }) {
  const p = usePickerState();
  const a = useActions();
  const targets = ids ?? (item ? [item.id] : []);
  const value = item?.[field] ?? null;
  const done = item?.state_category === 'done' || item?.state_category === 'canceled';
  return (
    <>
      <Chip onClick={p.show} compact={compact} title={field === 'due_date' ? 'Due date' : 'Start date'}>
        <Calendar size={14} className="text-fg-faint" />
        {value ? <DueDateLabel date={value} done={done} /> : <span className="text-fg-faint">{ids && !item ? 'Due date' : '—'}</span>}
      </Chip>
      <DatePicker open={p.open} onClose={p.close} anchor={p.anchor} value={value} label={field === 'due_date' ? 'Due date' : 'Start date'} onChange={(d) => (field === 'due_date' ? void a.setDueDate(targets, d) : void a.setStartDate(targets, d))} />
    </>
  );
}

export function LabelsChip({ item, ids, compact, max = 3 }: { item?: ItemRow; ids?: string[]; compact?: boolean; max?: number }) {
  const p = usePickerState();
  const a = useActions();
  const { labelsById } = useStore();
  const targets = ids ?? (item ? [item.id] : []);
  const labelIds = item?.label_ids ?? [];
  const labels = labelIds.map((id) => labelsById[id]).filter((l): l is Label => !!l);
  return (
    <>
      <Chip onClick={p.show} compact={compact} title="Labels (l)">
        {labels.length === 0 ? (
          <>
            <Tag size={14} className="text-fg-faint" />
            <span className="text-fg-faint">{ids && !item ? 'Labels' : ''}</span>
          </>
        ) : (
          <span className="flex items-center gap-1 overflow-hidden">
            {labels.slice(0, max).map((l) => (
              <Badge key={l.id} color={l.color ?? 'var(--fg-faint)'}>
                {l.name}
              </Badge>
            ))}
            {labels.length > max && <span className="text-xs text-fg-faint">+{labels.length - max}</span>}
          </span>
        )}
      </Chip>
      <LabelPicker
        open={p.open}
        onClose={p.close}
        anchor={p.anchor}
        projectId={item?.project_id}
        selectedIds={new Set(labelIds)}
        onToggle={(id) => void a.toggleLabel(targets, id)}
        onCreate={async (name) => {
          const id = await a.createLabel(name, item?.project_id ?? null);
          if (id) await a.addLabel(targets, id);
        }}
      />
    </>
  );
}

export function TypeChip({ item, compact }: { item: ItemRow; compact?: boolean }) {
  const p = usePickerState();
  const a = useActions();
  const { typesById, projectsById } = useStore();
  const type = typesById[item.type_id];
  return (
    <>
      <Chip onClick={p.show} compact={compact} title="Type">
        <TypeIcon type={type} />
        <span className="truncate">{type?.name ?? '?'}</span>
      </Chip>
      <TypePicker open={p.open} onClose={p.close} anchor={p.anchor} project={projectsById[item.project_id]} value={item.type_id} onChange={(t) => void a.setType(item.id, t)} />
    </>
  );
}

export function UserName({ id }: { id: string | null | undefined }) {
  const { usersById } = useStore();
  const u: User | undefined = id ? usersById[id] : undefined;
  return <span>{u?.name ?? (id ? 'Unknown' : '—')}</span>;
}

export function CheckIcon() {
  return <Check size={14} />;
}
