import { useMemo } from 'react';
import { CheckCheck, Bell } from 'lucide-react';
import { useNotifications, useStore } from '../store/hooks';
import { useActions } from '../components/items/useActions';
import { useUI } from '../state';
import { Avatar, Button } from '../components/ui';
import { cn, relTime } from '../lib/util';

const KIND_LABEL: Record<string, string> = { mention: 'Mentioned you', assigned: 'Assigned to you', reply: 'Replied to you', state_change: 'State changed', comment: 'New comment', due_soon: 'Due soon', mutation_rejected: 'Change rejected' };

export function InboxPage() {
  const notifications = useNotifications();
  const { itemsById, usersById } = useStore();
  const a = useActions();
  const { openItem } = useUI();
  const sorted = useMemo(() => [...notifications].sort((x, y) => (x.read_at ? 1 : 0) - (y.read_at ? 1 : 0) || y.updated_at.localeCompare(x.updated_at)), [notifications]);
  const unread = sorted.filter((n) => !n.read_at).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <h1 className="text-sm font-semibold">Inbox</h1>
        <span className="text-xs text-fg-faint">{unread} unread</span>
        <span className="ml-auto" />
        <Button variant="ghost" icon={<CheckCheck size={14} />} onClick={() => void a.markAllRead()} disabled={!unread}>Mark all read</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-16 text-sm text-fg-muted"><Bell size={24} className="text-fg-faint" />You're all caught up.</div>
        )}
        <ul className="divide-y divide-border">
          {sorted.map((n) => {
            const item = n.item_id ? itemsById[n.item_id] : undefined;
            const actor = n.actor_id ? usersById[n.actor_id] : undefined;
            return (
              <li key={n.id} className={cn('flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-bg-subtle', !n.read_at && 'bg-accent-soft/40')} onClick={() => { if (!n.read_at) void a.markRead(n.id); if (item) openItem(item.number > 0 ? item.key : item.id); }}>
                <Avatar user={actor} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <span className={cn('rounded px-1.5 py-0.5', n.kind === 'mutation_rejected' ? 'bg-danger-soft text-danger' : 'bg-bg-muted')}>{KIND_LABEL[n.kind] ?? n.kind}</span>
                    {item && <span className="font-mono">{item.key}</span>}
                    <span className="ml-auto">{relTime(n.updated_at)}</span>
                  </div>
                  <div className={cn('mt-0.5 text-sm', !n.read_at && 'font-medium')}>{n.title}</div>
                  {n.body && <div className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{n.body}</div>}
                </div>
                {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
