import { createContext, useContext, useEffect, useState } from 'react';
import type { ReadTransaction } from 'replicache';
import type { Rep } from './replicache';

export const ReplicacheContext = createContext<Rep | null>(null);

export function useReplicache(): Rep {
  const rep = useContext(ReplicacheContext);
  if (!rep) throw new Error('useReplicache outside ReplicacheContext');
  return rep;
}

export function useMaybeReplicache(): Rep | null {
  return useContext(ReplicacheContext);
}

/** Subscribe to a Replicache query; re-renders when the keys it read change. */
export function useSubscribe<R>(rep: Rep | null, query: (tx: ReadTransaction) => Promise<R>, def: R, deps: unknown[] = []): R {
  const [value, setValue] = useState<R>(def);
  useEffect(() => {
    if (!rep) return;
    const unsub = rep.subscribe(query, { onData: (d) => setValue(d) });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep, ...deps]);
  return value;
}
