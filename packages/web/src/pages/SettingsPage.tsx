import { useEffect, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { NotifyCadence, NotifyChannel } from '@pm/core';
import { useStore } from '../store/hooks';
import { useSession } from '../session';
import { useActions } from '../components/items/useActions';
import { api, type ApiKeyRow } from '../api';
import { Button, Input, Select, Checkbox } from '../components/ui';
import { toast } from '../lib/toast';
import { applyTheme, getTheme, type Theme } from '../lib/theme';

const RULES: { key: string; label: string }[] = [
  { key: 'mention', label: 'Someone mentions me' },
  { key: 'assigned', label: 'An item is assigned to me' },
  { key: 'reply', label: 'Someone replies to my comment' },
  { key: 'state_change_assigned', label: 'State changes on items assigned to me' },
  { key: 'state_change_watching', label: 'State changes on items I watch' },
  { key: 'comment_watching', label: 'Comments on items I watch' },
  { key: 'due_soon', label: 'Items due within 24h' },
];
const CHANNELS: NotifyChannel[] = ['in_app', 'email', 'slack'];

export function SettingsPage() {
  const { preferences } = useStore();
  const { me } = useSession();
  const a = useActions();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [newKey, setNewKey] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  useEffect(() => { api.listApiKeys().then(setKeys).catch(() => setKeys([])); }, []);

  const pref = (ch: NotifyChannel) => preferences.find((p) => p.channel === ch);
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 p-8">
      <section>
        <h1 className="text-lg font-semibold">Settings</h1>
        <div className="text-sm text-fg-muted">{me?.user.name} · {me?.user.email} · firm {me?.user.firm_role}</div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Appearance</h2>
        <Select value={theme} className="w-48" onChange={(e) => { const t = e.target.value as Theme; setTheme(t); applyTheme(t); }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></Select>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Notifications</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-fg-faint"><th className="py-1 font-medium">Rule</th>{CHANNELS.map((c) => <th key={c} className="py-1 font-medium">{c.replace('_', '-')}</th>)}</tr></thead>
          <tbody>
            <tr className="border-b border-border"><td className="py-1.5 text-fg-muted">Cadence</td>{CHANNELS.map((c) => (
              <td key={c} className="py-1.5"><Select value={pref(c)?.cadence ?? 'immediate'} className="w-32" onChange={(e) => void a.updateNotificationPreference({ channel: c, cadence: e.target.value as NotifyCadence })}>{['immediate', 'hourly', 'daily', 'off'].map((x) => <option key={x} value={x}>{x}</option>)}</Select></td>
            ))}</tr>
            {RULES.map((r) => (
              <tr key={r.key} className="border-b border-border"><td className="py-1.5">{r.label}</td>{CHANNELS.map((c) => (
                <td key={c} className="py-1.5"><Checkbox checked={pref(c)?.rules[r.key] ?? ['mention', 'assigned', 'reply', 'state_change_assigned', 'due_soon'].includes(r.key)} onChange={(v) => void a.updateNotificationPreference({ channel: c, rules: { [r.key]: v } })} /></td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">API keys</h2>
        <p className="mb-2 text-xs text-fg-muted">Use with <code>Authorization: Bearer pm_…</code> for the REST API and the MCP server.</p>
        <div className="mb-2 flex gap-2">
          <Input placeholder="Key name (e.g. MCP on my laptop)" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="max-w-xs" />
          <Button variant="primary" disabled={!newKey.trim()} onClick={() => void api.createApiKey(newKey.trim()).then((r) => { setCreated(r.key); setNewKey(''); return api.listApiKeys().then(setKeys); })}>Create key</Button>
        </div>
        {created && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-sm">
            <code className="flex-1 break-all">{created}</code>
            <Button size="xs" icon={<Copy size={12} />} onClick={() => { void navigator.clipboard?.writeText(created); toast('Copied'); }}>Copy</Button>
            <span className="text-xs text-fg-muted">shown once</span>
          </div>
        )}
        <ul className="divide-y divide-border rounded-md border border-border">
          {(keys ?? []).map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-sm"><span className="flex-1">{k.name}</span><span className="text-xs text-fg-faint">created {k.created_at.slice(0, 10)}{k.last_used_at ? ` · used ${k.last_used_at.slice(0, 10)}` : ''}</span><Button size="xs" variant="ghost" className="text-danger" icon={<Trash2 size={12} />} onClick={() => void api.deleteApiKey(k.id).then(() => setKeys((xs) => (xs ?? []).filter((x) => x.id !== k.id)))} /></li>
          ))}
          {keys && keys.length === 0 && <li className="px-3 py-2 text-sm text-fg-faint">No API keys{keys === null ? '' : ' (or the API is offline)'}.</li>}
        </ul>
      </section>
    </div>
  );
}
