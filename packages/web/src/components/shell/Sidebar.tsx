import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Inbox, Search, Home, ChevronRight, ChevronDown, Plus, Settings, Workflow, Shapes, Webhook, Plug, Users, LogOut, SunMoon, List, Columns3, GanttChart, LayoutDashboard, Folder } from 'lucide-react';
import type { Project, View } from '@pm/core';
import { useStore, useIsFirmAdmin, useUnreadCount } from '../../store/hooks';
import { useSession } from '../../session';
import { useUI } from '../../state';
import { cn } from '../../lib/util';
import { toggleTheme } from '../../lib/theme';
import { Avatar, Kbd, Popover } from '../ui';

const KIND_ICON = { list: List, board: Columns3, timeline: GanttChart, dashboard: LayoutDashboard } as const;

function NavItem({ to, icon: Icon, label, badge, end, shortcut }: { to: string; icon: typeof Home; label: string; badge?: number; end?: boolean; shortcut?: string }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn('group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted hover:bg-bg-muted hover:text-fg', isActive && 'bg-bg-muted text-fg font-medium')}
    >
      <Icon size={15} className="shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {badge ? <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">{badge}</span> : null}
      {shortcut && <Kbd keys={shortcut} className="hidden opacity-0 group-hover:opacity-100 lg:inline" />}
    </NavLink>
  );
}

function ProjectNode({ project, views }: { project: Project; views: View[] }) {
  const loc = useLocation();
  const active = loc.pathname.startsWith(`/p/${project.key}`);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? active;
  const { openQuickCreate } = useUI();
  const def = views.find((v) => v.is_default) ?? views[0];
  return (
    <div>
      <div className={cn('group flex h-7 items-center gap-1 rounded-md pr-1 pl-1 text-[13px] hover:bg-bg-muted', active && 'text-fg font-medium')}>
        <button className="flex h-5 w-5 items-center justify-center rounded text-fg-faint hover:text-fg" onClick={() => setOpen(!expanded)} aria-label={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <NavLink to={def ? `/p/${project.key}/v/${def.id}` : `/p/${project.key}`} className="flex min-w-0 flex-1 items-center gap-2 text-fg-muted hover:text-fg">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white" style={{ background: `hsl(${(project.key.charCodeAt(0) * 37) % 360} 50% 50%)` }}>
            {project.key.slice(0, 2)}
          </span>
          <span className="truncate">{project.name}</span>
        </NavLink>
        <button className="hidden h-5 w-5 items-center justify-center rounded text-fg-faint hover:text-fg group-hover:flex" title="New item" onClick={() => openQuickCreate({ project_id: project.id })}>
          <Plus size={13} />
        </button>
      </div>
      {expanded && (
        <div className="ml-4 border-l border-border pl-1.5">
          {views.map((v) => {
            const Icon = KIND_ICON[v.kind];
            return (
              <NavLink key={v.id} to={`/p/${project.key}/v/${v.id}`} className={({ isActive }) => cn('flex h-6.5 items-center gap-2 rounded-md px-2 py-1 text-[13px] text-fg-muted hover:bg-bg-muted hover:text-fg', isActive && 'bg-bg-muted text-fg')}>
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{v.name}</span>
                {!v.is_shared && <span className="text-[10px] text-fg-faint">private</span>}
              </NavLink>
            );
          })}
          <NavLink to={`/p/${project.key}/new-view`} className="flex h-6 items-center gap-2 rounded-md px-2 text-xs text-fg-faint hover:bg-bg-muted hover:text-fg">
            <Plus size={12} /> New view
          </NavLink>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { projects, views } = useStore();
  const { me, logout } = useSession();
  const isAdmin = useIsFirmAdmin();
  const unread = useUnreadCount();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const { openQuickCreate } = useUI();

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-bg-subtle">
      <div className="flex h-12 items-center gap-2 px-3">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 hover:bg-bg-muted" onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <Avatar user={me?.user} size={22} />
          <span className="truncate text-sm font-medium">{me?.user.name ?? '…'}</span>
          <ChevronDown size={13} className="text-fg-faint" />
        </button>
        <button className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg hover:opacity-90" title="New item (c)" onClick={() => openQuickCreate()}>
          <Plus size={16} />
        </button>
      </div>
      <Popover open={!!menuAnchor} onClose={() => setMenuAnchor(null)} anchor={menuAnchor} width={220} className="p-1">
        <div className="px-2 py-1.5 text-xs text-fg-muted">{me?.user.email}</div>
        <NavLink to="/settings" className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-bg-muted" onClick={() => setMenuAnchor(null)}>
          <Settings size={14} /> Settings
        </NavLink>
        <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-bg-muted" onClick={() => { toggleTheme(); setMenuAnchor(null); }}>
          <SunMoon size={14} /> Toggle theme <Kbd keys="t" className="ml-auto" />
        </button>
        <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-danger hover:bg-bg-muted" onClick={() => void logout()}>
          <LogOut size={14} /> Log out
        </button>
      </Popover>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="space-y-0.5">
          <NavItem to="/" icon={Home} label="My work" end shortcut="g h" />
          <NavItem to="/inbox" icon={Inbox} label="Inbox" badge={unread} shortcut="g i" />
          <NavItem to="/search" icon={Search} label="Search" shortcut="/" />
        </div>

        <div className="mt-4 mb-1 flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          <span>Projects</span>
          <NavLink to="/projects/new" title="New project" className="hover:text-fg">
            <Plus size={12} />
          </NavLink>
        </div>
        <div className="space-y-0.5">
          {projects.filter((p) => !p.archived_at).map((p) => (
            <ProjectNode key={p.id} project={p} views={views.filter((v) => v.project_id === p.id)} />
          ))}
          {projects.length === 0 && <div className="px-2 py-2 text-xs text-fg-faint">No projects yet.</div>}
        </div>
        {views.some((v) => v.project_id === null) && (
          <>
            <div className="mt-4 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Saved views</div>
            {views.filter((v) => v.project_id === null).map((v) => {
              const Icon = KIND_ICON[v.kind];
              return (
                <NavLink key={v.id} to={`/v/${v.id}`} className={({ isActive }) => cn('flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted hover:bg-bg-muted hover:text-fg', isActive && 'bg-bg-muted text-fg')}>
                  <Icon size={13} /> <span className="truncate">{v.name}</span>
                </NavLink>
              );
            })}
          </>
        )}

        {isAdmin && (
          <>
            <div className="mt-4 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Admin</div>
            <div className="space-y-0.5">
              <NavItem to="/admin/workflows" icon={Workflow} label="Workflows" />
              <NavItem to="/admin/types" icon={Shapes} label="Item types" />
              <NavItem to="/admin/webhooks" icon={Webhook} label="Webhooks" />
              <NavItem to="/admin/integrations" icon={Plug} label="Integrations" />
              <NavItem to="/admin/users" icon={Users} label="Users" />
              <NavItem to="/projects" icon={Folder} label="All projects" />
            </div>
          </>
        )}
      </nav>
      <div className="border-t border-border px-3 py-2 text-[11px] text-fg-faint">
        <Kbd keys="mod+k" /> <span className="ml-1">command palette</span> · <Kbd keys="?" /> <span className="ml-1">help</span>
      </div>
    </aside>
  );
}
