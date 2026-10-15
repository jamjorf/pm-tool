import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/util';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 border border-transparent',
  secondary: 'bg-bg-muted text-fg hover:bg-border border border-transparent',
  outline: 'bg-transparent border border-border-strong text-fg hover:bg-bg-muted',
  ghost: 'bg-transparent text-fg-muted hover:bg-bg-muted hover:text-fg border border-transparent',
  danger: 'bg-danger-soft text-danger hover:opacity-90 border border-transparent',
};
const sizes: Record<Size, string> = {
  xs: 'h-6 px-1.5 text-xs gap-1 rounded',
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-2 rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ className, size = 'sm', ...rest }: ButtonProps) {
  return <Button variant="ghost" size={size} className={cn('px-0', size === 'xs' ? 'w-6' : size === 'sm' ? 'w-7' : 'w-8', className)} {...rest} />;
}
