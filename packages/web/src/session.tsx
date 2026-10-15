import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Actor, ProjectRole } from '@pm/core';
import { api, ApiError, type Me } from './api';
import { createReplicache, type Rep, type SyncHandle } from './sync/replicache';
import { ReplicacheContext } from './sync/context';

const CACHE_KEY = 'pm.me';

interface SessionValue {
  me: Me | null;
  loading: boolean;
  /** API reachable (last request / poke stream status) */
  online: boolean;
  syncing: boolean;
  rep: Rep | null;
  actor: Actor | null;
  refresh: () => Promise<void>;
  setMe: (me: Me) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

function readCache(): Me | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}
function writeCache(me: Me | null): void {
  try {
    if (me) localStorage.setItem(CACHE_KEY, JSON.stringify(me));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [handle, setHandle] = useState<SyncHandle | null>(null);
  const handleRef = useRef<SyncHandle | null>(null);

  const setMe = useCallback((m: Me) => {
    writeCache(m);
    setMeState(m);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me(true);
      setMe(m);
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        writeCache(null);
        setMeState(null);
      } else if (e instanceof ApiError && e.status === 0) {
        // Offline: keep working from the cached identity (local-first).
        setOnline(false);
        const cached = readCache();
        if (cached) setMeState(cached);
      }
    } finally {
      setLoading(false);
    }
  }, [setMe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Boot / tear down Replicache per user.
  useEffect(() => {
    const userId = me?.user.id;
    if (!userId) {
      if (handleRef.current) {
        void handleRef.current.close();
        handleRef.current = null;
        setHandle(null);
      }
      return;
    }
    if (handleRef.current && handleRef.current.rep.name === `pm-${userId}`) return;
    if (handleRef.current) void handleRef.current.close();
    const h = createReplicache(userId, {
      onAuthLost: () => {
        writeCache(null);
        setMeState(null);
      },
      onOnline: (o) => setOnline(o),
    });
    h.rep.onSync = (s) => setSyncing(s);
    h.rep.onClientStateNotFound = () => {
      // Local state was dropped (e.g. IndexedDB cleared): reload to start a fresh client.
      location.reload();
    };
    handleRef.current = h;
    setHandle(h);
  }, [me?.user.id]);

  useEffect(() => () => void handleRef.current?.close(), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    writeCache(null);
    setMeState(null);
  }, []);

  const actor = useMemo<Actor | null>(() => {
    if (!me) return null;
    const memberships: Record<string, ProjectRole> = {};
    for (const m of me.memberships) memberships[m.project_id] = m.role;
    return { id: me.user.id, firmRole: me.user.firm_role, memberships, isService: me.user.is_service };
  }, [me]);

  const value = useMemo<SessionValue>(
    () => ({ me, loading, online, syncing, rep: handle?.rep ?? null, actor, refresh, setMe, logout }),
    [me, loading, online, syncing, handle, actor, refresh, setMe, logout],
  );

  return (
    <Ctx.Provider value={value}>
      <ReplicacheContext.Provider value={handle?.rep ?? null}>{children}</ReplicacheContext.Provider>
    </Ctx.Provider>
  );
}

export function useSession(): SessionValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}

export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('useMe without a session');
  return me;
}
