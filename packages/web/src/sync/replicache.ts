import { Replicache } from 'replicache';
import { createMutators, type Mutators } from './mutators';

export type Rep = Replicache<Mutators>;

export interface SyncHandle {
  rep: Rep;
  close: () => Promise<void>;
}

/** Subscribe to `/sync/poke` (SSE); on `poke` run `onPoke`. Reconnects with backoff. */
export function subscribePoke(onPoke: () => void, onStatus?: (online: boolean) => void): () => void {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let stopped = false;

  const connect = () => {
    if (stopped || typeof EventSource === 'undefined') return;
    es = new EventSource('/sync/poke', { withCredentials: true });
    es.addEventListener('poke', () => onPoke());
    es.onopen = () => {
      delay = 1000;
      onStatus?.(true);
    };
    es.onerror = () => {
      onStatus?.(false);
      es?.close();
      es = null;
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
    es = null;
  };
}

export function createReplicache(userId: string, opts: { onAuthLost?: () => void; onOnline?: (online: boolean) => void } = {}): SyncHandle {
  const rep = new Replicache<Mutators>({
    name: `pm-${userId}`,
    pushURL: '/sync/push',
    pullURL: '/sync/pull',
    pullInterval: 60_000,
    schemaVersion: '1',
    mutators: createMutators(userId),
    logLevel: 'error',
  });
  rep.getAuth = () => {
    opts.onAuthLost?.();
    return null;
  };
  const stopPoke = subscribePoke(() => {
    void rep.pull();
  }, opts.onOnline);
  return {
    rep,
    close: async () => {
      stopPoke();
      await rep.close();
    },
  };
}
