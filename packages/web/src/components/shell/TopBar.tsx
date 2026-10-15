import { Link, useLocation, useParams } from 'react-router-dom';
import { ChevronRight, Search, Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useStore } from '../../store/hooks';
import { useSession } from '../../session';
import { useUI } from '../../state';
import { Kbd } from '../ui';
import { cn } from '../../lib/util';

export function TopBar() {
  const { projectKey, viewId, itemKey } = useParams();
  const loc = useLocation();
  const { projectByKey, views, itemByKey, itemsById, projectsById } = useStore();
  const { openPalette } = useUI();
  const { online, syncing } = useSession();

  const crumbs: { label: string; to?: string }[] = [];
  const project = projectKey ? projectByKey[projectKey.toUpperCase()] : undefined;
  if (project) crumbs.push({ label: project.name, to: `/p/${project.key}` });
  if (viewId) {
    const v = views.find((x) => x.id === viewId);
    if (v) crumbs.push({ label: v.name });
  }
  if (itemKey) {
    const item = itemByKey[itemKey.toUpperCase()] ?? itemsById[itemKey];
    const p = item ? projectsById[item.project_id] : undefined;
    if (p) crumbs.push({ label: p.name, to: `/p/${p.key}` });
    crumbs.push({ label: item?.key ?? itemKey });
  }
  if (crumbs.length === 0) {
    const map: Record<string, string> = { '/': 'My work', '/inbox': 'Inbox', '/search': 'Search', '/settings': 'Settings', '/admin/workflows': 'Workflows', '/admin/types': 'Item types', '/admin/webhooks': 'Webhooks', '/admin/integrations': 'Integrations', '/admin/users': 'Users', '/projects': 'Projects', '/projects/new': 'New project' };
    crumbs.push({ label: map[loc.pathname] ?? '' });
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight size={14} className="shrink-0 text-fg-faint" />}
            {c.to ? (
              <Link to={c.to} className="truncate text-fg-muted hover:text-fg">
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium">{c.label}</span>
            )}
          </span>
        ))}
      </nav>
      <button className="flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-bg-subtle px-2.5 text-[13px] text-fg-faint hover:border-border-strong" onClick={() => openPalette()}>
        <Search size={14} />
        <span className="flex-1 text-left">Search or jump to…</span>
        <Kbd keys="mod+k" />
      </button>
      <span className={cn('flex h-8 w-8 items-center justify-center text-fg-faint', !online && 'text-warn')} title={!online ? 'Offline — changes are queued locally' : syncing ? 'Syncing…' : 'Synced'}>
        {!online ? <CloudOff size={15} /> : syncing ? <RefreshCw size={14} className="animate-spin" /> : <Cloud size={15} />}
      </span>
    </header>
  );
}
