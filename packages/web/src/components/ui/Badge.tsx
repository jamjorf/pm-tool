import type { ReactNode } from 'react';
import { cn } from '../../lib/util';

export function Badge({ children, color, className, onClick, title }: { children: ReactNode; color?: string | null; className?: string; onClick?: () => void; title?: string }) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn('inline-flex h-5 max-w-[160px] items-center gap-1 truncate rounded-full border border-border px-1.5 text-[11px] font-medium text-fg-muted', onClick && 'hover:bg-bg-muted', className)}
    >
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="truncate">{children}</span>
    </Comp>
  );
}

export function StateDot({ color, category, className }: { color?: string | null; category?: string; className?: string }) {
  const c = color ?? '#9ca3af';
  const filled = category === 'done' || category === 'canceled';
  return (
    <span
      className={cn('inline-block h-3 w-3 shrink-0 rounded-full', className)}
      style={filled ? { background: c } : category === 'in_progress' ? { border: `2px solid ${c}`, background: `linear-gradient(90deg, ${c} 50%, transparent 50%)` } : { border: `2px solid ${c}` }}
    />
  );
}
