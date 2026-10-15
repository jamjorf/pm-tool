import { formatKeys } from '../../lib/shortcuts';

export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const parts = formatKeys(keys);
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <kbd key={i} className={i > 0 ? 'ml-1' : ''}>
          {p}
        </kbd>
      ))}
    </span>
  );
}
