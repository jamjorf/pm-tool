import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/util';

export function Tooltip({ content, children, className, side = 'top' }: { content: ReactNode; children: ReactNode; className?: string; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false);
  if (!content) return <>{children}</>;
  return (
    <span className={cn('relative inline-flex', className)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute left-1/2 z-50 w-max max-w-xs -translate-x-1/2 rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg shadow-[var(--shadow)]',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
