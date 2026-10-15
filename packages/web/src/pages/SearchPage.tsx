// Instant local results (substring over key/title) on top; server FTS (/api/v1/search) below, debounced.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { api, type SearchHit } from '../api';
import { useAllItems, useStore } from '../store/hooks';
import { useUI } from '../state';
import { StateDot } from '../components/ui';
import { stateColor } from '../lib/util';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const items = useAllItems();
  const { statesById, projectsById, projects } = useStore();
  const { openItem } = useUI();
  const [server, setServer] = useState<{ hits: SearchHit[]; status: 'idle' | 'loading' | 'error' | 'done' }>({ hits: [], status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState('');
  useEffect(() => { inputRef.current?.focus(); }, []);

  const local = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items.filter((i) => (!project || i.project_id === project) && (i.key.toLowerCase().includes(s) || i.title.toLowerCase().includes(s))).sort((a, b) => (a.key.toLowerCase() === s ? -1 : b.key.toLowerCase() === s ? 1 : 0) || b.updated_at.localeCompare(a.updated_at)).slice(0, 25);
  }, [q, items, project]);

  useEffect(() => {
    if (q.trim().length < 2) { setServer({ hits: [], status: 'idle' }); return; }
    const ctrl = new AbortController();
    setServer((s) => ({ ...s, status: 'loading' }));
    const t = setTimeout(() => {
      api.search(q.trim(), project ? projectsById[project]?.key : undefined, 25, ctrl.signal)
        .then((r) => setServer({ hits: r.items ?? [], status: 'done' }))
        .catch((e) => { if ((e as Error).name !== 'AbortError') setServer({ hits: [], status: 'error' }); });
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, project, projectsById]);

  const localIds = new Set(local.map((i) => i.id));
  const serverOnly = server.hits.filter((h) => !localIds.has(h.id));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col p-6">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-border bg-bg px-3 focus-within:border-accent">
          <SearchIcon size={16} className="text-fg-faint" />
          <input ref={inputRef} value={q} onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })} placeholder="Search items by key, title, description, comments…" className="flex-1 bg-transparent text-sm outline-none" />
        </div>
        <select value={project} onChange={(e) => setProject(e.target.value)} className="h-10 rounded-lg border border-border bg-bg px-2 text-sm"><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.key}</option>)}</select>
      </div>
      {q.trim() && (
        <section className="mb-6">
          <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Instant · {local.length}</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {local.map((i) => { const st = statesById[i.state_id]; return (
              <li key={i.id}><button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-subtle" onClick={() => openItem(i.number > 0 ? i.key : i.id)}><StateDot color={stateColor(st)} category={st?.category} /><span className="font-mono text-xs text-fg-muted">{i.key}</span><span className="truncate">{i.title}</span><span className="ml-auto text-xs text-fg-faint">{projectsById[i.project_id]?.key}</span></button></li>
            ); })}
            {local.length === 0 && <li className="px-3 py-3 text-sm text-fg-faint">No local matches.</li>}
          </ul>
        </section>
      )}
      {q.trim().length >= 2 && (
        <section>
          <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Full-text (server) · {server.status === 'loading' ? '…' : server.status === 'error' ? 'unavailable' : serverOnly.length}</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {serverOnly.map((h) => (
              <li key={h.id}><button className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-bg-subtle" onClick={() => openItem(h.key)}><span className="flex items-center gap-2"><span className="font-mono text-xs text-fg-muted">{h.key}</span><span className="truncate">{h.title}</span></span>{h.snippet && <span className="line-clamp-2 text-xs text-fg-muted" dangerouslySetInnerHTML={{ __html: h.snippet.replace(/<(?!\/?b>)[^>]+>/g, '') }} />}</button></li>
            ))}
            {server.status === 'done' && serverOnly.length === 0 && <li className="px-3 py-3 text-sm text-fg-faint">No additional server results.</li>}
            {server.status === 'error' && <li className="px-3 py-3 text-sm text-fg-faint">Server search unavailable (offline?). Local results above still work.</li>}
          </ul>
        </section>
      )}
      {!q.trim() && <div className="p-10 text-center text-sm text-fg-muted">Type to search. Press <kbd>/</kbd> anywhere to get here.</div>}
    </div>
  );
}
