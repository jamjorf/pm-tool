import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/util';
import { IconButton } from './Button';

export function Dialog({ open, onClose, title, children, className, footer, width = 520 }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; className?: string; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={cn('animate-in flex max-h-[80vh] w-full flex-col rounded-xl border border-border bg-bg-elevated shadow-[var(--shadow)]', className)} style={{ maxWidth: width }}>
        {title !== undefined && (
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className="text-sm font-semibold">{title}</div>
            <IconButton onClick={onClose} aria-label="Close" size="xs">
              <X size={14} />
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Delete', danger = true }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={400}
      footer={
        <>
          <button className="h-8 rounded-md px-3 text-sm text-fg-muted hover:bg-bg-muted" onClick={onClose}>
            Cancel
          </button>
          <button
            autoFocus
            className={cn('h-8 rounded-md px-3 text-sm font-medium', danger ? 'bg-danger text-white' : 'bg-accent text-accent-fg')}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-fg-muted">{body}</div>
    </Dialog>
  );
}
