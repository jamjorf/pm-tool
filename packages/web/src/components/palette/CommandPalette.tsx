// ⌘K palette (cmdk): navigate, actions, and sub-lists acting on the selected/focused items.
import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate, useParams } from 'react-router-dom';
import { Folder, List, Plus, SunMoon, Keyboard, Settings, Home, Inbox, Search, User, Flag, ArrowRightLeft, Tag, FolderInput, Calendar, Trash2, Maximize2, Eye, Clock } from 'lucide-react';
import { PRIORITY_LABELS, workflowEngine, type ItemRow, type WorkflowTransition } from '@pm/core';
import { useUI, type PaletteMode } from '../../state';
import { useStore, useProjectLabels, useGuardContext } from '../../store/hooks';
import { useSession } from '../../session';
import { useActions } from '../items/useActions';
import { resolveActions, resolveNavigation, commonTransitions, type PaletteActionId } from './actions';
import { toggleTheme } from '../../lib/theme';
import { Avatar, Kbd, StateDot } from '../ui';
import { PriorityIcon } from '../items/properties';
import { stateColor, todayIso, cn } from '../../lib/util';
import { addDays } from 'date-fns';
import { toast } from '../../lib/toast';

const RECENT_KEY = 'pm.recent';
export function pushRecent(id: string) {
  try {
    const xs = (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).filter((x) => x !== id);
    xs.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(xs.slice(0, 10)));
  } catch { /* ignore */ }
}
function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}

const ICONS: Record<PaletteActionId, React.ReactNode> = {
  new_item: <Plus size={15} />, new_view: <List size={15} />, toggle_theme: <SunMoon size={15} />, help: <Keyboard size={15} />, settings: <Settings size={15} />,
  go_my_work: <Home size={15} />, go_inbox: <Inbox size={15} />, go_search: <Search size={15} />,
  assign: <User size={15} />, priority: <Flag size={15} />, transition: <ArrowRightLeft size={15} />, label: <Tag size={15} />, move: <FolderInput size={15} />,
  due: <Calendar size={15} />, delete: <Trash2 size={15} />, open_full: <Maximize2 size={15} />, watch: <Eye size={15} />,
};

/** Evaluate transitions for one item (hook per target; targets are few). */
function useTargetTransitions(items: ItemRow[]) {
  const { typesById, workflowsById } = useStore();
  const { me } = useSession();
  // We evaluate guards via useGuardContext only for the first item (cheap, representative); others use availability only.
  const firstCtx = useGuardContext(items[0]);
  return useMemo(() => {
    return items.map((item) => {
      const wf = workflowsById[typesById[item.type_id]?.workflow_id ?? ''];
      if (!wf) return { id: item.id, transitions: [] };
      let available: WorkflowTransition[];
      try { available = workflowEngine.availableTransitions(wf, item); } catch { available = wf.transitions.filter((t) => !t.from_state_id || t.from_state_id === item.state_id); }
      const ctx = firstCtx ? { ...firstCtx, actorId: me?.user.id ?? '' } : null;
      return {
        id: item.id,
        transitions: available.filter((t) => t.to_state_id !== item.state_id).map((t) => {
          let allowed = true; let failures: string[] = [];
          if (ctx) { try { const r = workflowEngine.evaluate(wf, item, t.key, ctx); allowed = r.ok; failures = r.failures.map((f) => f.reason); } catch { /* stub */ } }
          return { transition: t, allowed, failures, toName: wf.statesById[t.to_state_id]?.name ?? '?', toState: wf.statesById[t.to_state_id] };
        }),
      };
    });
  }, [items, typesById, workflowsById, firstCtx, me?.user.id]);
}

export function CommandPalette() {
  const ui = useUI();
  const { palette, closePalette, openPalette, targetIds, openQuickCreate, openItem, setHelpOpen, clearSelection } = ui;
  const { items, projects, views, itemsById, usersById, users, statesById } = useStore();
  const { me } = useSession();
  const a = useActions();
  const navigate = useNavigate();
  const { projectKey } = useParams();
  const [query, setQuery] = useState('');
  const open = !!palette;
  const mode: PaletteMode = palette ?? { kind: 'root' };

  useEffect(() => { if (open) setQuery(''); }, [open, mode.kind]);

  const targets = useMemo(() => targetIds.map((id) => itemsById[id]).filter((x): x is ItemRow => !!x), [targetIds, itemsById]);
  const n = targets.length;
  const first = targets[0];
  const currentProject = projects.find((p) => p.key === projectKey?.toUpperCase());
  const projectLabels = useProjectLabels(first?.project_id ?? currentProject?.id ?? null);
  const perItem = useTargetTransitions(targets);
  const transitions = useMemo(() => commonTransitions(perItem), [perItem]);

  const nav = useMemo(() => (mode.kind === 'root' ? resolveNavigation(query, items, projects, views, readRecent()) : []), [mode.kind, query, items, projects, views]);
  const actions = useMemo(() => resolveActions(n), [n]);

  const done = () => { closePalette(); };
  const runAction = (id: PaletteActionId) => {
    switch (id) {
      case 'new_item': done(); openQuickCreate(currentProject ? { project_id: currentProject.id } : first ? { project_id: first.project_id } : {}); return;
      case 'new_view': done(); navigate(currentProject ? `/p/${currentProject.key}/new-view` : '/views/new'); return;
      case 'toggle_theme': done(); toast({ kind: 'info', title: `Theme: ${toggleTheme()}`, ttl: 1200 }); return;
      case 'help': done(); setHelpOpen(true); return;
      case 'settings': done(); navigate('/settings'); return;
      case 'go_my_work': done(); navigate('/'); return;
      case 'go_inbox': done(); navigate('/inbox'); return;
      case 'go_search': done(); navigate('/search'); return;
      case 'assign': openPalette({ kind: 'assign' }); return;
      case 'priority': openPalette({ kind: 'priority' }); return;
      case 'transition': openPalette({ kind: 'transition' }); return;
      case 'label': openPalette({ kind: 'label' }); return;
      case 'move': openPalette({ kind: 'move' }); return;
      case 'due': openPalette({ kind: 'due' }); return;
      case 'watch': done(); if (first) (a.isWatching(first.id) ? void a.unwatch(first.id) : void a.watch(first.id)); return;
      case 'open_full': done(); if (first) openItem(first.number > 0 ? first.key : first.id, true); return;
      case 'delete': done(); if (targets.length) { void a.remove(targets.map((t) => t.id)); clearSelection(); } return;
    }
  };

  const title = mode.kind === 'root' ? null : `${{ assign: 'Assign', priority: 'Set priority', transition: 'Transition', label: 'Labels', move: 'Move to project', due: 'Due date', project: 'Project', view: 'View', item: 'Item' }[mode.kind]} · ${n} item${n === 1 ? '' : 's'}`;

  if (!open) return null;
  const ids = targets.map((t) => t.id);

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-[14vh]" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <Command
        label="Command palette"
        className="animate-in w-full max-w-xl overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-[var(--shadow)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); if (mode.kind !== 'root') openPalette({ kind: 'root' }); else closePalette(); }
          if (e.key === 'Backspace' && !query && mode.kind !== 'root') openPalette({ kind: 'root' });
        }}
      >
        {title && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted">
            <span className="rounded bg-bg-muted px-1.5 py-0.5 font-medium text-fg">{title}</span>
            {first && n === 1 && <span className="truncate">{first.key} · {first.title}</span>}
            <span className="ml-auto"><Kbd keys="Escape" /> back</span>
          </div>
        )}
        <Command.Input value={query} onValueChange={setQuery} placeholder={mode.kind === 'root' ? (n ? `${n} item${n > 1 ? 's' : ''} selected — type an action or jump to…` : 'Jump to item, project, view… or type an action') : 'Filter…'} autoFocus />
        <Command.List>
          <Command.Empty>Nothing found.</Command.Empty>

          {mode.kind === 'root' && (
            <>
              {nav.length > 0 && (
                <Command.Group heading={query ? 'Jump to' : 'Recent'}>
                  {nav.map((c) => (
                    <Command.Item key={c.kind + c.id} value={`${c.kind}:${c.id} ${c.label} ${c.hint}`} onSelect={() => {
                      done();
                      if (c.kind === 'item' && c.item) { pushRecent(c.item.id); openItem(c.item.number > 0 ? c.item.key : c.item.id); }
                      else if (c.kind === 'project' && c.project) navigate(`/p/${c.project.key}`);
                      else if (c.kind === 'view' && c.view) navigate(c.view.project_id ? `/p/${projects.find((p) => p.id === c.view!.project_id)?.key}/v/${c.view.id}` : `/v/${c.view.id}`);
                    }}>
                      {c.kind === 'item' && c.item ? <StateDot color={stateColor(statesById[c.item.state_id])} category={statesById[c.item.state_id]?.category} /> : c.kind === 'project' ? <Folder size={15} /> : <List size={15} />}
                      <span className="flex-1 truncate">{c.label}</span>
                      <span className="font-mono text-xs text-fg-faint">{c.hint}</span>
                      {!query && c.kind === 'item' && <Clock size={12} className="text-fg-faint" />}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {['Selection', 'Actions', 'Navigate'].map((g) => {
                const xs = actions.filter((x) => x.group === g);
                if (!xs.length) return null;
                return (
                  <Command.Group key={g} heading={g === 'Selection' ? `Selection (${n})` : g}>
                    {xs.map((x) => (
                      <Command.Item key={x.id} value={`action:${x.id} ${x.label}`} onSelect={() => runAction(x.id)}>
                        <span className="text-fg-muted">{ICONS[x.id]}</span>
                        <span className="flex-1">{x.label}</span>
                        {x.shortcut && <Kbd keys={x.shortcut} />}
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </>
          )}

          {mode.kind === 'assign' && (
            <Command.Group heading="Assign to">
              <Command.Item value="unassigned" onSelect={() => { void a.setAssignee(ids, null); done(); }}><Avatar user={null} size={16} /> Unassigned</Command.Item>
              {[...users].filter((u) => u.is_active && !u.is_service).sort((x, y) => (x.id === me?.user.id ? -1 : y.id === me?.user.id ? 1 : x.name.localeCompare(y.name))).map((u) => (
                <Command.Item key={u.id} value={`${u.name} ${u.email}`} onSelect={() => { void a.setAssignee(ids, u.id); done(); }}>
                  <Avatar user={u} size={16} /> <span className="flex-1">{u.name}{u.id === me?.user.id ? ' (me)' : ''}</span> <span className="text-xs text-fg-faint">{u.email}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {mode.kind === 'priority' && (
            <Command.Group heading="Priority">
              {[1, 2, 3, 4, 0].map((p) => (
                <Command.Item key={p} value={`${PRIORITY_LABELS[p]} p${p}`} onSelect={() => { void a.setPriority(ids, p); done(); }}>
                  <PriorityIcon priority={p} /> <span className="flex-1">{PRIORITY_LABELS[p]}</span>{first && n === 1 && first.priority === p && <span className="text-accent">✓</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {mode.kind === 'transition' && (
            <Command.Group heading={n > 1 ? 'Transitions allowed for all selected' : 'Transition'}>
              {transitions.length === 0 && <div className="px-3 py-3 text-xs text-fg-muted">No common transition for the selected items.</div>}
              {transitions.map((t) => (
                <Command.Item key={t.key} value={`${t.name} ${t.toName}`} disabled={!t.allowed} onSelect={() => { void a.bulkTransition(ids, t.key); done(); }}>
                  <ArrowRightLeft size={14} className="text-fg-muted" />
                  <span className="flex-1">{t.name} <span className="text-fg-faint">→ {t.toName}</span></span>
                  {!t.allowed && <span className="max-w-[220px] truncate text-xs text-danger" title={t.failures.join('\n')}>{t.failures[0]}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {mode.kind === 'label' && (
            <Command.Group heading="Toggle label">
              {projectLabels.map((l) => {
                const all = ids.length > 0 && ids.every((id) => (itemsById[id]?.label_ids ?? []).includes(l.id));
                return (
                  <Command.Item key={l.id} value={l.name} onSelect={() => { void a.toggleLabel(ids, l.id); }}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color ?? 'var(--fg-faint)' }} /> <span className="flex-1">{l.name}</span>{all && <span className="text-accent">✓</span>}
                  </Command.Item>
                );
              })}
              {query.trim() && !projectLabels.some((l) => l.name.toLowerCase() === query.trim().toLowerCase()) && (
                <Command.Item value={`create ${query}`} onSelect={async () => { const id = await a.createLabel(query.trim(), first?.project_id ?? currentProject?.id ?? null); if (id) await a.addLabel(ids, id); done(); }}>
                  <Plus size={14} /> Create label “{query.trim()}”
                </Command.Item>
              )}
            </Command.Group>
          )}

          {mode.kind === 'move' && (
            <Command.Group heading="Move to project">
              {projects.filter((p) => !p.archived_at).map((p) => (
                <Command.Item key={p.id} value={`${p.name} ${p.key}`} disabled={n === 1 && first?.project_id === p.id} onSelect={() => { void a.move(ids, p.id); clearSelection(); done(); }}>
                  <Folder size={14} /> <span className="flex-1">{p.name}</span><span className="font-mono text-xs text-fg-faint">{p.key}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {mode.kind === 'due' && (
            <Command.Group heading="Due date">
              {[{ l: 'Today', d: todayIso() }, { l: 'Tomorrow', d: todayIso(addDays(new Date(), 1)) }, { l: 'In a week', d: todayIso(addDays(new Date(), 7)) }, { l: 'In two weeks', d: todayIso(addDays(new Date(), 14)) }, { l: 'End of month', d: todayIso(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)) }, { l: 'Clear', d: null }].map((o) => (
                <Command.Item key={o.l} value={o.l} onSelect={() => { void a.setDueDate(ids, o.d); done(); }}><Calendar size={14} /> <span className="flex-1">{o.l}</span><span className="text-xs text-fg-faint">{o.d ?? ''}</span></Command.Item>
              ))}
              {/^\d{4}-\d{2}-\d{2}$/.test(query) && <Command.Item value={query} onSelect={() => { void a.setDueDate(ids, query); done(); }}><Calendar size={14} /> Set {query}</Command.Item>}
            </Command.Group>
          )}
        </Command.List>
        <div className={cn('flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-fg-faint')}>
          <span><Kbd keys="Enter" /> select</span><span><Kbd keys="Escape" /> close</span>
          {n > 0 && <span className="ml-auto">{n} target{n > 1 ? 's' : ''}: {targets.slice(0, 3).map((t) => t.key).join(', ')}{n > 3 ? '…' : ''}</span>}
          {usersById && null}
        </div>
      </Command>
    </div>
  );
}
