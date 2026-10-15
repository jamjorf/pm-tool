import { Navigate, useParams, useNavigate, Link } from 'react-router-dom';
import { useState } from 'react';
import { useProject, useStore, useIsFirmAdmin, useAllItems } from '../store/hooks';
import { useActions } from '../components/items/useActions';
import { Button, Input, Field, Select, Textarea } from '../components/ui';
import { useSession } from '../session';

/** /p/:projectKey → default view */
export function ProjectRedirect() {
  const { projectKey } = useParams();
  const project = useProject(projectKey);
  const { views, ready } = useStore();
  if (!ready) return <div className="p-8 text-sm text-fg-muted">Loading…</div>;
  if (!project) return <div className="p-8 text-sm text-fg-muted">Project <code>{projectKey}</code> not found.</div>;
  const mine = views.filter((v) => v.project_id === project.id);
  const def = mine.find((v) => v.is_default) ?? mine[0];
  if (def) return <Navigate to={`/p/${project.key}/v/${def.id}`} replace />;
  return <Navigate to={`/p/${project.key}/v/none`} replace />;
}

export function ProjectsPage() {
  const { projects, membersByProject, usersById } = useStore();
  const items = useAllItems();
  const isAdmin = useIsFirmAdmin();
  const { me } = useSession();
  return (
    <div className="mx-auto w-full max-w-4xl p-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Link to="/projects/new"><Button variant="primary">New project</Button></Link>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-fg-faint"><th className="py-2">Key</th><th>Name</th><th>Status</th><th>Visibility</th><th>Lead</th><th>Members</th><th>Open</th></tr></thead>
        <tbody>
          {projects.map((p) => {
            const open = items.filter((i) => i.project_id === p.id && i.state_category !== 'done' && i.state_category !== 'canceled').length;
            return (
              <tr key={p.id} className="border-b border-border hover:bg-bg-subtle">
                <td className="py-2 font-mono text-xs"><Link to={`/p/${p.key}`} className="hover:underline">{p.key}</Link></td>
                <td><Link to={`/p/${p.key}`} className="hover:underline">{p.name}</Link></td>
                <td className="capitalize text-fg-muted">{p.status}</td>
                <td className="text-fg-muted">{p.visibility}</td>
                <td className="text-fg-muted">{p.lead_id ? usersById[p.lead_id]?.name : '—'}</td>
                <td className="text-fg-muted">{membersByProject[p.id]?.length ?? 0}{isAdmin || membersByProject[p.id]?.some((m) => m.user_id === me?.user.id && m.role === 'admin') ? <Link to={`/p/${p.key}/settings`} className="ml-2 text-accent hover:underline">manage</Link> : null}</td>
                <td className="tabular-nums">{open}</td>
              </tr>
            );
          })}
          {projects.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-fg-muted">No projects visible to you.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function NewProjectPage() {
  const a = useActions();
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'firm' | 'private'>('firm');
  const valid = /^[A-Z][A-Z0-9]{1,9}$/.test(key) && name.trim().length > 0;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const id = await a.createProject({ key, name: name.trim(), description: description || undefined, visibility });
    if (id) navigate(`/p/${key}`);
  };
  return (
    <div className="mx-auto w-full max-w-md p-8">
      <h1 className="mb-4 text-lg font-semibold">New project</h1>
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <Field label="Key" hint="2–10 uppercase letters/digits; item keys become KEY-1, KEY-2…" error={key && !/^[A-Z][A-Z0-9]{1,9}$/.test(key) ? 'Invalid key' : undefined}><Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="RATES" autoFocus /></Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rates desk migration" /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></Field>
        <Field label="Visibility"><Select value={visibility} onChange={(e) => setVisibility(e.target.value as 'firm' | 'private')}><option value="firm">Firm — every member can see and edit</option><option value="private">Private — members only</option></Select></Field>
        <Button type="submit" variant="primary" disabled={!valid}>Create project</Button>
      </form>
    </div>
  );
}

export function ProjectSettingsPage() {
  const { projectKey } = useParams();
  const project = useProject(projectKey);
  const { users, membersByProject, types } = useStore();
  const a = useActions();
  const [addUser, setAddUser] = useState('');
  if (!project) return <div className="p-8 text-sm text-fg-muted">Project not found.</div>;
  const members = membersByProject[project.id] ?? [];
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-8">
      <h1 className="text-lg font-semibold">{project.name} <span className="font-mono text-sm text-fg-muted">{project.key}</span></h1>
      <section className="grid grid-cols-2 gap-3">
        <Field label="Name"><Input defaultValue={project.name} onBlur={(e) => e.target.value !== project.name && void a.updateProject(project.id, { name: e.target.value })} /></Field>
        <Field label="Status"><Select value={project.status} onChange={(e) => void a.updateProject(project.id, { status: e.target.value as typeof project.status })}>{['planned', 'active', 'paused', 'completed', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
        <Field label="Visibility"><Select value={project.visibility} onChange={(e) => void a.updateProject(project.id, { visibility: e.target.value as 'firm' | 'private' })}><option value="firm">firm</option><option value="private">private</option></Select></Field>
        <Field label="Lead"><Select value={project.lead_id ?? ''} onChange={(e) => void a.updateProject(project.id, { lead_id: e.target.value || null })}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        <Field label="Default type"><Select value={project.default_type_id ?? ''} onChange={(e) => void a.updateProject(project.id, { default_type_id: e.target.value || null })}><option value="">—</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Field label="Target date"><Input type="date" defaultValue={project.target_date ?? ''} onBlur={(e) => void a.updateProject(project.id, { target_date: e.target.value || null })} /></Field>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Members</h2>
        <table className="w-full text-sm">
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id} className="border-b border-border">
                <td className="py-1.5">{users.find((u) => u.id === m.user_id)?.name ?? m.user_id}</td>
                <td><Select value={m.role} className="w-32" onChange={(e) => void a.setProjectMember(project.id, m.user_id, e.target.value as typeof m.role)}><option value="admin">admin</option><option value="editor">editor</option><option value="viewer">viewer</option></Select></td>
                <td className="text-right"><Button size="xs" variant="ghost" className="text-danger" onClick={() => void a.removeProjectMember(project.id, m.user_id)}>Remove</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-center gap-2">
          <Select value={addUser} onChange={(e) => setAddUser(e.target.value)} className="w-64"><option value="">Add member…</option>{users.filter((u) => !members.some((m) => m.user_id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          <Button disabled={!addUser} onClick={() => { void a.setProjectMember(project.id, addUser, 'editor'); setAddUser(''); }}>Add as editor</Button>
        </div>
      </section>
    </div>
  );
}
