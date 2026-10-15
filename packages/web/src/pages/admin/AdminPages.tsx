// Webhooks, integrations, users (REST-backed admin screens).
import { useEffect, useState } from 'react';
import { Plus, Trash2, Send, RefreshCw } from 'lucide-react';
import { EVENT_KINDS, type User } from '@pm/core';
import { api, unwrapList, type IntegrationConfig, type WebhookDelivery, type WebhookEndpoint } from '../../api';
import { useStore } from '../../store/hooks';
import { Button, Input, Select, Checkbox, Dialog, Field } from '../../components/ui';
import { toast } from '../../lib/toast';
import { cn, relTime } from '../../lib/util';

export function WebhooksPage() {
  const [hooks, setHooks] = useState<WebhookEndpoint[] | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', url: '', event_kinds: ['*'] as string[], project: '' });
  const [deliveries, setDeliveries] = useState<{ id: string; rows: WebhookDelivery[] } | null>(null);
  const { projects } = useStore();
  const load = () => api.listWebhooks().then((r) => setHooks(unwrapList(r, 'webhooks'))).catch(() => setHooks([]));
  useEffect(() => { void load(); }, []);
  const create = async () => {
    await api.createWebhook({ name: draft.name, url: draft.url, event_kinds: draft.event_kinds, project: draft.project || null });
    setOpen(false); setDraft({ name: '', url: '', event_kinds: ['*'], project: '' });
    void load();
  };
  return (
    <div className="mx-auto w-full max-w-4xl p-8">
      <div className="mb-4 flex items-center justify-between"><h1 className="text-lg font-semibold">Webhooks</h1><Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen(true)}>New endpoint</Button></div>
      <p className="mb-4 text-xs text-fg-muted">Deliveries carry <code>X-PM-Event</code>, <code>X-PM-Delivery</code> and <code>X-PM-Signature: sha256=&lt;hmac&gt;</code>. Retries 1m → 5m → 30m → 2h → 12h, then dead.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {(hooks ?? []).map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Checkbox checked={h.is_active} onChange={(v) => void api.patchWebhook(h.id, { is_active: v }).then(load)} />
            <div className="min-w-0 flex-1"><div className="font-medium">{h.name}</div><div className="truncate text-xs text-fg-muted">{h.url} · {h.event_kinds.join(', ')}{h.project_id ? ` · ${projects.find((p) => p.id === h.project_id)?.key ?? 'project'}` : ''}</div></div>
            <Button size="xs" variant="ghost" icon={<Send size={12} />} onClick={() => void api.testWebhook(h.id).then(() => toast({ kind: 'success', title: 'Test delivery queued' }))}>Test</Button>
            <Button size="xs" variant="ghost" onClick={() => void api.webhookDeliveries(h.id).then((r) => setDeliveries({ id: h.id, rows: unwrapList(r, 'deliveries') }))}>Deliveries</Button>
            <Button size="xs" variant="ghost" className="text-danger" icon={<Trash2 size={12} />} onClick={() => void api.deleteWebhook(h.id).then(load)} />
          </li>
        ))}
        {hooks && hooks.length === 0 && <li className="px-3 py-4 text-sm text-fg-faint">No webhook endpoints (or the API is offline).</li>}
      </ul>
      <Dialog open={open} onClose={() => setOpen(false)} title="New webhook endpoint" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!draft.name || !draft.url} onClick={() => void create()}>Create</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /></Field>
          <Field label="URL"><Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://" /></Field>
          <Field label="Project (optional)"><Select value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.key}>{p.key} · {p.name}</option>)}</Select></Field>
          <div>
            <div className="mb-1 text-xs font-medium text-fg-muted">Event kinds</div>
            <div className="flex flex-wrap gap-1.5">
              {['*', ...EVENT_KINDS].map((k) => { const on = draft.event_kinds.includes(k); return <button key={k} className={cn('h-6 rounded-full border px-2 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted')} onClick={() => setDraft({ ...draft, event_kinds: on ? draft.event_kinds.filter((x) => x !== k) : [...draft.event_kinds.filter((x) => x !== '*' || k === '*'), k] })}>{k}</button>; })}
            </div>
          </div>
        </div>
      </Dialog>
      <Dialog open={!!deliveries} onClose={() => setDeliveries(null)} title="Recent deliveries" width={720}>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-fg-faint"><th>Event</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Next</th><th>Created</th></tr></thead>
          <tbody>{(deliveries?.rows ?? []).map((d) => <tr key={d.id} className="border-t border-border"><td className="py-1">{d.event_kind}</td><td className={cn(d.status === 'dead' && 'text-danger', d.status === 'delivered' && 'text-ok')}>{d.status}</td><td>{d.attempts}</td><td>{d.response_status ?? '—'}</td><td>{d.next_attempt_at ? relTime(d.next_attempt_at) : '—'}</td><td>{relTime(d.created_at)}</td></tr>)}</tbody>
        </table>
        {deliveries?.rows.length === 0 && <div className="text-sm text-fg-faint">No deliveries yet.</div>}
      </Dialog>
    </div>
  );
}

const INTEGRATIONS: { kind: string; title: string; fields: { key: string; label: string; secret?: boolean; hint?: string }[] }[] = [
  { kind: 'slack', title: 'Slack', fields: [{ key: 'bot_token', label: 'Bot token', secret: true }, { key: 'signing_secret', label: 'Signing secret', secret: true }, { key: 'default_channel', label: 'Default channel', hint: 'e.g. #pm-updates' }] },
  { kind: 'github', title: 'GitHub', fields: [{ key: 'webhook_secret', label: 'Webhook secret', secret: true }, { key: 'token', label: 'API token', secret: true }, { key: 'repos', label: 'Repositories', hint: 'owner/repo, comma separated' }] },
  { kind: 'email', title: 'Email', fields: [{ key: 'inbound_domain', label: 'Inbound domain', hint: 'pm+KEY-12@<domain>' }, { key: 'from', label: 'From address' }] },
];

export function IntegrationsPage() {
  const [configs, setConfigs] = useState<Record<string, IntegrationConfig>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => { api.listIntegrations().then((r) => { const m: Record<string, IntegrationConfig> = {}; for (const c of unwrapList<IntegrationConfig>(r, 'integrations')) m[c.kind] = c; setConfigs(m); setDrafts(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.config]))); }).catch(() => undefined); }, []);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
      <h1 className="text-lg font-semibold">Integrations</h1>
      {INTEGRATIONS.map((def) => {
        const cfg = configs[def.kind];
        const draft = drafts[def.kind] ?? {};
        return (
          <section key={def.kind} className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center gap-3"><h2 className="text-sm font-semibold">{def.title}</h2><span className={cn('rounded-full px-2 py-0.5 text-[11px]', cfg?.is_active ? 'bg-ok-soft text-ok' : 'bg-bg-muted text-fg-muted')}>{cfg?.is_active ? 'active' : 'inactive'}</span><span className="ml-auto" /><Button size="xs" onClick={() => void api.putIntegration(def.kind, { config: draft, is_active: !cfg?.is_active }).then((r) => { setConfigs({ ...configs, [def.kind]: r }); toast({ kind: 'success', title: `${def.title} ${r.is_active ? 'enabled' : 'disabled'}` }); })}>{cfg?.is_active ? 'Disable' : 'Enable'}</Button><Button size="xs" variant="primary" onClick={() => void api.putIntegration(def.kind, { config: draft, is_active: cfg?.is_active ?? false }).then((r) => { setConfigs({ ...configs, [def.kind]: r }); toast({ kind: 'success', title: 'Saved' }); })}>Save</Button></div>
            <div className="grid grid-cols-2 gap-3">
              {def.fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}><Input type={f.secret ? 'password' : 'text'} value={String(draft[f.key] ?? '')} onChange={(e) => setDrafts({ ...drafts, [def.kind]: { ...draft, [f.key]: e.target.value } })} /></Field>
              ))}
            </div>
            <div className="mt-2 text-xs text-fg-faint">Inbound URL: <code>/integrations/{def.kind}/{def.kind === 'slack' ? 'events' : def.kind === 'github' ? 'webhook' : 'inbound'}</code></div>
          </section>
        );
      })}
    </div>
  );
}

export function UsersPage() {
  const { users: localUsers } = useStore();
  const [users, setUsers] = useState<User[] | null>(null);
  const load = () => api.listUsers().then((r) => setUsers(unwrapList<User>(r, 'users'))).catch(() => setUsers(null));
  useEffect(() => { void load(); }, []);
  const rows = users ?? localUsers;
  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <div className="mb-4 flex items-center justify-between"><h1 className="text-lg font-semibold">Users</h1><Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()}>Refresh</Button></div>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-fg-faint"><th className="py-2">Name</th><th>Email</th><th>Firm role</th><th>Active</th><th>Service</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} className="border-b border-border">
              <td className="py-1.5">{u.name}</td>
              <td className="text-fg-muted">{u.email}</td>
              <td><Select value={u.firm_role} className="h-7 w-28" onChange={(e) => void api.patchUser(u.id, { firm_role: e.target.value }).then(load)}>{['owner', 'admin', 'member', 'guest'].map((r) => <option key={r} value={r}>{r}</option>)}</Select></td>
              <td><Checkbox checked={u.is_active} onChange={(v) => void api.patchUser(u.id, { is_active: v }).then(load)} /></td>
              <td className="text-fg-muted">{u.is_service ? 'yes' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-fg-faint">Firm roles: owner/admin manage workflows, types, webhooks and users; members get editor on firm-visible projects; guests only see projects they are added to.</p>
    </div>
  );
}
