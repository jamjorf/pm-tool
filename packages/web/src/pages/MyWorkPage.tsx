// `/` — assigned to me / created by me / watching / due soon, via local runSpec with the $me macro.
import { useMemo, useState } from 'react';
import type { QuerySpec, ItemRow } from '@pm/core';
import { useAllItems, useStore } from '../store/hooks';
import { useSession } from '../session';
import { useRunSpec } from '../components/views/query';
import { ListView } from '../components/views/ListView';
import { cn } from '../lib/util';
import { useUI } from '../state';
import { Button } from '../components/ui';

const OPEN = { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } as const;
const SPECS: Record<string, QuerySpec> = {
  assigned: { filter: { and: [{ field: 'assignee_id', op: 'eq', value: '$me' }, OPEN] }, sort: [{ field: 'priority', dir: 'asc' }, { field: 'due_date', dir: 'asc', nulls: 'last' }] },
  created: { filter: { and: [{ field: 'created_by', op: 'eq', value: '$me' }, OPEN] }, sort: [{ field: 'created_at', dir: 'desc' }] },
  due_soon: { filter: { and: [{ field: 'assignee_id', op: 'eq', value: '$me' }, { field: 'due_date', op: 'within_days', value: 7 }, OPEN] }, sort: [{ field: 'due_date', dir: 'asc' }] },
  recent: { sort: [{ field: 'updated_at', dir: 'desc' }], limit: 30 },
};
const TABS = [
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'due_soon', label: 'Due soon' },
  { id: 'watching', label: 'Watching' },
  { id: 'created', label: 'Created by me' },
  { id: 'recent', label: 'Recently updated' },
];

export function MyWorkPage() {
  const items = useAllItems();
  const { watchers, ready } = useStore();
  const { me } = useSession();
  const [tab, setTab] = useState('assigned');
  const { openQuickCreate } = useUI();

  const watchingItems = useMemo(() => {
    const ids = new Set(watchers.filter((w) => w.user_id === me?.user.id && !w.muted).map((w) => w.item_id));
    return items.filter((i) => ids.has(i.id));
  }, [watchers, items, me?.user.id]);

  const assigned = useRunSpec(SPECS.assigned!, items);
  const created = useRunSpec(SPECS.created!, items);
  const dueSoon = useRunSpec(SPECS.due_soon!, items);
  const recent = useRunSpec(SPECS.recent!, items);
  const watching = useRunSpec({ filter: OPEN, sort: [{ field: 'updated_at', dir: 'desc' }] }, watchingItems);

  const current: { items: ItemRow[] } = { assigned, created, due_soon: dueSoon, recent, watching }[tab] ?? assigned;
  const counts: Record<string, number> = { assigned: assigned.items.length, created: created.items.length, due_soon: dueSoon.items.length, recent: recent.items.length, watching: watching.items.length };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <h1 className="mr-3 text-sm font-semibold">My work</h1>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cn('h-7 rounded-md px-2.5 text-[13px] text-fg-muted hover:bg-bg-muted hover:text-fg', tab === t.id && 'bg-bg-muted text-fg font-medium')}>
            {t.label} <span className="ml-1 text-xs text-fg-faint">{counts[t.id]}</span>
          </button>
        ))}
        <span className="ml-auto" />
        <Button variant="primary" onClick={() => openQuickCreate()}>+ New item</Button>
      </div>
      {!ready ? <div className="p-8 text-sm text-fg-muted">Loading local store…</div> : (
        <ListView items={current.items} groups={null} columns={['key', 'title', 'project_id', 'state_id', 'priority', 'due_date', 'labels']} emptyText={assigned.fallback ? 'Query engine unavailable (core package not built).' : 'Nothing here — enjoy the calm.'} />
      )}
    </div>
  );
}
