import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/util';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is anchored to. */
  anchor: HTMLElement | null;
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end';
  /** Prevent close on pointerdown inside these elements */
  width?: number;
}

/** Portal popover anchored to an element; closes on outside pointerdown / Escape. */
export function Popover({ open, onClose, anchor, children, className, align = 'start', width }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = ref.current;
      const r = anchor?.getBoundingClientRect();
      if (!el) return;
      const w = width ?? el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top: number;
      let left: number;
      if (r) {
        top = r.bottom + 4;
        left = align === 'end' ? r.right - w : r.left;
        if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
      } else {
        top = vh / 2 - h / 2;
        left = vw / 2 - w / 2;
      }
      left = Math.min(Math.max(8, left), vw - w - 8);
      setStyle({ position: 'fixed', top, left, width: width ?? undefined, visibility: 'visible', zIndex: 60 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} style={style} className={cn('animate-in rounded-lg border border-border bg-bg-elevated shadow-[var(--shadow)]', className)} data-popover>
      {children}
    </div>,
    document.body,
  );
}

export interface PickerItem {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  tooltip?: string;
  selected?: boolean;
  keywords?: string;
}

export interface PickerProps {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  items: PickerItem[];
  onSelect: (item: PickerItem) => void;
  placeholder?: string;
  multi?: boolean;
  emptyText?: string;
  width?: number;
  align?: 'start' | 'end';
  /** Called with the current query when the user presses Enter on no match (e.g. create label). */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  footer?: ReactNode;
}

/** Searchable, keyboard-navigable list in a Popover. */
export function Picker({ open, onClose, anchor, items, onSelect, placeholder = 'Search…', multi, emptyText = 'No results', width = 260, align, onCreate, createLabel, footer }: PickerProps) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const ql = q.trim().toLowerCase();
  const filtered = ql ? items.filter((i) => (i.label + ' ' + (i.keywords ?? '') + ' ' + (i.hint ?? '')).toLowerCase().includes(ql)) : items;
  const canCreate = !!onCreate && ql.length > 0 && !filtered.some((i) => i.label.toLowerCase() === ql);
  const total = filtered.length + (canCreate ? 1 : 0);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, total - 1)));
  }, [total]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const choose = (idx: number) => {
    if (canCreate && idx === filtered.length) {
      onCreate?.(q.trim());
      if (!multi) onClose();
      return;
    }
    const it = filtered[idx];
    if (!it || it.disabled) return;
    onSelect(it);
    if (!multi) onClose();
  };

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={width} align={align} className="overflow-hidden">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setCursor(0);
        }}
        placeholder={placeholder}
        className="h-9 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-fg-faint"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(total - 1, c + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(cursor);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
          e.stopPropagation();
        }}
      />
      <div ref={listRef} className="max-h-72 overflow-auto p-1" role="listbox">
        {filtered.length === 0 && !canCreate && <div className="px-3 py-4 text-center text-xs text-fg-muted">{emptyText}</div>}
        {filtered.map((it, idx) => (
          <div
            key={it.id}
            data-idx={idx}
            role="option"
            aria-selected={!!it.selected}
            title={it.tooltip}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
              idx === cursor && 'bg-bg-muted',
              it.disabled && 'cursor-not-allowed opacity-45',
            )}
            onMouseEnter={() => setCursor(idx)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(idx)}
          >
            {multi && (
              <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border', it.selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong')}>
                {it.selected && <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 6l3 3 5-6" /></svg>}
              </span>
            )}
            {it.icon && <span className="flex w-4 shrink-0 items-center justify-center text-fg-muted">{it.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="shrink-0 text-xs text-fg-faint">{it.hint}</span>}
            {!multi && it.selected && <span className="text-accent">✓</span>}
          </div>
        ))}
        {canCreate && (
          <div
            data-idx={filtered.length}
            className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-accent', cursor === filtered.length && 'bg-bg-muted')}
            onMouseEnter={() => setCursor(filtered.length)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(filtered.length)}
          >
            {createLabel ? createLabel(q.trim()) : `Create "${q.trim()}"`}
          </div>
        )}
      </div>
      {footer && <div className="border-t border-border p-1">{footer}</div>}
    </Popover>
  );
}
