import type { User } from '@pm/core';
import { cn, hashColor, initials } from '../../lib/util';
import { UserRound } from 'lucide-react';

export function Avatar({ user, size = 20, className }: { user: User | undefined | null; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.42) };
  if (!user) {
    return (
      <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-fg-faint', className)} style={style} title="Unassigned">
        <UserRound size={size * 0.6} />
      </span>
    );
  }
  if (user.avatar_url) {
    return <img src={user.avatar_url} alt={user.name} className={cn('shrink-0 rounded-full object-cover', className)} style={style} title={user.name} />;
  }
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ ...style, background: hashColor(user.id) }}
      title={user.name}
    >
      {initials(user.name)}
    </span>
  );
}
