import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/util';

const base =
  'rounded-md border border-border bg-bg px-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50';
/** Default to full width unless the caller passes an explicit `w-*` class. */
const width = (className?: string) => (className && /(^|\s)(w-|max-w-|flex-1|min-w-)/.test(className) ? '' : 'w-full');

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(base, width(className), 'h-8', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(base, width(className), 'min-h-[80px] py-1.5 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(base, width(className), 'h-8 appearance-none pr-7 bg-no-repeat', className)} style={{ backgroundImage: 'none' }} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, children, hint, error, className }: { label: string; children: React.ReactNode; hint?: string; error?: string; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <div className="mb-1 text-xs font-medium text-fg-muted">{label}</div>
      {children}
      {error ? <div className="mt-1 text-xs text-danger">{error}</div> : hint ? <div className="mt-1 text-xs text-fg-faint">{hint}</div> : null}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label?: string; className?: string }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
      {label && <span>{label}</span>}
    </label>
  );
}
