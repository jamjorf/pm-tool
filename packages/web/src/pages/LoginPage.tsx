import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useSession } from '../session';
import { Button, Input, Field } from '../components/ui';

export function LoginPage() {
  const { me, loading, setMe, online } = useSession();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'dev' | 'magic' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  if (!loading && me) return <Navigate to="/" replace />;

  const devLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy('dev');
    setMsg(null);
    try {
      await api.devLogin(email.trim(), name.trim() || undefined);
      const m = await api.me(false);
      setMe(m);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError && err.status === 0 ? 'The API is not reachable (is it running on :3001?).' : (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const magic = async () => {
    if (!email) return;
    setBusy('magic');
    setMsg(null);
    try {
      await api.magicLink(email.trim());
      setMsg({ kind: 'ok', text: 'Magic link sent. In dev mode it is printed in the API log.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bg-subtle p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-elevated p-7 shadow-[var(--shadow)]">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-fg"><svg viewBox="0 0 32 32" width="20" height="20"><path d="M9 17l5 5 9-11" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          <div>
            <div className="text-base font-semibold leading-tight">pm-tool</div>
            <div className="text-xs text-fg-muted">Sign in to your firm workspace</div>
          </div>
        </div>
        <form className="space-y-3" onSubmit={(e) => void devLogin(e)}>
          <Field label="Email"><Input type="email" autoFocus required placeholder="you@firm.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Name (first login only)" hint="Dev login creates the user if needed; the first user becomes firm owner."><Input placeholder="Optional" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Button type="submit" variant="primary" size="md" className="w-full" loading={busy === 'dev'} disabled={!email}>Dev login</Button>
        </form>
        <div className="my-4 flex items-center gap-3 text-xs text-fg-faint"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
        <Button variant="outline" size="md" className="w-full" loading={busy === 'magic'} disabled={!email} onClick={() => void magic()}>Email me a magic link</Button>
        {msg && <div className={'mt-4 rounded-md px-3 py-2 text-sm ' + (msg.kind === 'ok' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>{msg.text}</div>}
        {!online && !msg && <div className="mt-4 text-xs text-fg-faint">API offline — the page still renders; sign in once the server is up.</div>}
      </div>
    </div>
  );
}
