import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from './util';

export type ToastKind = 'info' | 'success' | 'error' | 'warn';
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  ttl?: number;
}

interface ToastApi {
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

// A module-level sink so non-React code (api.ts, mutators) can toast.
let sink: ToastApi | null = null;
export function toast(t: Omit<Toast, 'id'> | string): void {
  const payload = typeof t === 'string' ? { kind: 'info' as const, title: t } : t;
  if (sink) sink.push(payload);
  else console.warn('[toast]', payload.title, payload.body ?? '');
}
export function toastError(title: string, body?: string): void {
  toast({ kind: 'error', title, body, ttl: 7000 });
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = seq.current++;
      setItems((xs) => [...xs.slice(-4), { ...t, id }]);
      const ttl = t.ttl ?? (t.kind === 'error' ? 7000 : 3500);
      if (ttl > 0) setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss],
  );
  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  sink = api;
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto animate-in rounded-lg border bg-bg-elevated p-3 text-sm shadow-[var(--shadow)]',
              t.kind === 'error' && 'border-danger/40',
              t.kind === 'success' && 'border-ok/40',
              t.kind === 'warn' && 'border-warn/40',
              t.kind === 'info' && 'border-border',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.title}</div>
                {t.body && <div className="mt-0.5 text-fg-muted whitespace-pre-wrap break-words">{t.body}</div>}
                {t.action && (
                  <button
                    className="mt-1.5 text-accent hover:underline"
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button className="text-fg-faint hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
