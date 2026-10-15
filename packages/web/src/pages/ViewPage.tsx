// /p/:projectKey/v/:viewId and /v/:viewId — renders a saved ViewSpec with URL-state overrides.
import { useCallback, useMemo } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ViewSpec as ViewSpecSchema, type ViewKind, type ViewSpec } from '@pm/core';
import { useAllItems, useProject, useStore } from '../store/hooks';
import { readOverrides, writeOverrides, mergeSpec, hasOverrides, type ViewOverrides } from '../lib/urlState';
import { useRunSpec } from '../components/views/query';
import { ViewToolbar } from '../components/views/ViewToolbar';
import { ListView } from '../components/views/ListView';
import { BoardView } from '../components/views/BoardView';
import { TimelineView } from '../components/views/TimelineView';
import { DashboardView } from '../components/views/DashboardView';
import { useActions } from '../components/items/useActions';
import { DEFAULT_COLUMNS } from '../components/views/filter';
import { useUI } from '../state';
import { Button } from '../components/ui';

export function parseSpec(raw: Record<string, unknown>): ViewSpec {
  const r = ViewSpecSchema.safeParse(raw);
  return r.success ? r.data : {};
}

export function ViewPage() {
  const { projectKey, viewId } = useParams();
  const project = useProject(projectKey);
  const { views, ready } = useStore();
  const allItems = useAllItems();
  const [params, setParams] = useSearchParams();
  const a = useActions();
  const { openQuickCreate } = useUI();

  const view = useMemo(() => views.find((v) => v.id === viewId) ?? null, [views, viewId]);
  const saved = useMemo(() => (view ? parseSpec(view.spec) : {}), [view]);
  const overrides = useMemo(() => readOverrides(params), [params]);
  const spec = useMemo(() => mergeSpec(saved, overrides), [saved, overrides]);
  const kind: ViewKind = (params.get('kind') as ViewKind | null) ?? view?.kind ?? saved.kind ?? 'list';

  const scope = useMemo(() => (project ? allItems.filter((i) => i.project_id === project.id) : allItems), [allItems, project]);
  const querySpec = useMemo(() => ({ ...spec, group_by: kind === 'board' ? null : spec.group_by }), [spec, kind]);
  const { items, groups } = useRunSpec(querySpec, scope);

  const onOverride = useCallback((o: ViewOverrides) => setParams(writeOverrides(params, { ...overrides, ...o }), { replace: true }), [params, overrides, setParams]);
  const onReset = useCallback(() => { const n = writeOverrides(params, {}); n.delete('kind'); setParams(n, { replace: true }); }, [params, setParams]);
  const onKindChange = useCallback((k: ViewKind) => { const n = new URLSearchParams(params); if (k === (view?.kind ?? 'list')) n.delete('kind'); else n.set('kind', k); setParams(n, { replace: true }); }, [params, setParams, view?.kind]);
  const dirty = hasOverrides(overrides) || params.has('kind');

  if (!ready) return <div className="p-8 text-sm text-fg-muted">Loading local store…</div>;
  if (projectKey && !project) return <div className="p-8 text-sm text-fg-muted">Project <code>{projectKey}</code> not found (or not visible to you).</div>;
  if (!view) {
    const def = views.filter((v) => v.project_id === (project?.id ?? null)).find((v) => v.is_default) ?? views.find((v) => v.project_id === (project?.id ?? null));
    if (def && def.id !== viewId) return <Navigate to={project ? `/p/${project.key}/v/${def.id}` : `/v/${def.id}`} replace />;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-sm text-fg-muted">
        <div>{viewId ? 'This view does not exist or is private to someone else.' : 'This project has no views yet.'}</div>
        <Button variant="primary" onClick={() => void a.createView({ project_id: project?.id ?? null, name: 'All items', kind: 'list', spec: { kind: 'list', columns: DEFAULT_COLUMNS, sort: [{ field: 'created_at', dir: 'desc' }] }, is_shared: true }).then((id) => id && location.assign(project ? `/p/${project.key}/v/${id}` : `/v/${id}`))}>
          Create a default list view
        </Button>
      </div>
    );
  }

  const persistSpec = (s: ViewSpec) => void a.updateView(view.id, { spec: s });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewToolbar
        view={view}
        project={project}
        spec={spec}
        kind={kind}
        dirty={dirty}
        count={items.length}
        onOverride={onOverride}
        onReset={onReset}
        onKindChange={onKindChange}
        extra={project && <Button variant="ghost" onClick={() => openQuickCreate({ project_id: project.id })}>+ New</Button>}
      />
      {kind === 'list' && <ListView items={items} groups={groups} columns={spec.columns ?? DEFAULT_COLUMNS} project={project} emptyText={<EmptyHint onCreate={project ? () => openQuickCreate({ project_id: project.id }) : undefined} />} />}
      {kind === 'board' && <BoardView items={items} spec={spec} project={project} />}
      {kind === 'timeline' && <TimelineView items={items} groups={groups} spec={spec} project={project} onZoom={(z) => persistSpec({ ...spec, timeline: { ...(spec.timeline ?? { start_field: 'start_date', end_field: 'due_date', zoom: 'month' }), zoom: z } })} />}
      {kind === 'dashboard' && <DashboardView spec={spec} scopeItems={scope} project={project} onSpecChange={persistSpec} editable />}
    </div>
  );
}

function EmptyHint({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div>No items match this view.</div>
      {onCreate && <Button variant="primary" onClick={onCreate}>Create the first item (c)</Button>}
    </div>
  );
}

export function NewViewPage() {
  const { projectKey } = useParams();
  const project = useProject(projectKey);
  const a = useActions();
  const [params] = useSearchParams();
  const kinds: ViewKind[] = ['list', 'board', 'timeline', 'dashboard'];
  const create = async (kind: ViewKind, name: string) => {
    const spec: ViewSpec = kind === 'list' ? { kind, columns: DEFAULT_COLUMNS, sort: [{ field: 'priority', dir: 'asc' }] }
      : kind === 'board' ? { kind, board: { column_field: 'state_id' } }
      : kind === 'timeline' ? { kind, timeline: { start_field: 'start_date', end_field: 'due_date', zoom: 'month', show_dependencies: true } }
      : { kind, dashboard: { widgets: [
        { id: crypto.randomUUID(), title: 'Open items', viz: 'number', query: { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } }, measure: 'count', w: 3, h: 2 },
        { id: crypto.randomUUID(), title: 'By state', viz: 'bar', query: {}, group_by: 'state_id', measure: 'count', w: 5, h: 3 },
        { id: crypto.randomUUID(), title: 'By assignee', viz: 'pie', query: { filter: { field: 'state.category', op: 'nin', value: ['done', 'canceled'] } }, group_by: 'assignee_id', measure: 'count', w: 4, h: 3 },
      ] } };
    const id = await a.createView({ project_id: project?.id ?? null, name, kind, spec, is_shared: true });
    if (id) location.assign(project ? `/p/${project.key}/v/${id}` : `/v/${id}`);
  };
  return (
    <div className="mx-auto w-full max-w-xl p-8">
      <h1 className="mb-1 text-lg font-semibold">New view {project ? `in ${project.name}` : '(all projects)'}</h1>
      <p className="mb-5 text-sm text-fg-muted">A view is a saved query plus a layout. You can change filters, sorting and grouping afterwards and save them.</p>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void create(f.get('kind') as ViewKind, String(f.get('name') || 'Untitled view')); }}>
        <label className="block"><div className="mb-1 text-xs font-medium text-fg-muted">Name</div><input name="name" autoFocus defaultValue={params.get('name') ?? ''} placeholder="e.g. Sprint board" className="h-8 w-full rounded-md border border-border bg-bg px-2.5 text-sm" /></label>
        <div className="grid grid-cols-4 gap-2">
          {kinds.map((k, i) => (
            <label key={k} className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-border p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input type="radio" name="kind" value={k} defaultChecked={i === 0} className="sr-only" />
              <span className="capitalize">{k}</span>
            </label>
          ))}
        </div>
        <Button type="submit" variant="primary">Create view</Button>
      </form>
    </div>
  );
}
