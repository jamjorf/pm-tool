import { useEffect } from 'react';
import { X, Maximize2 } from 'lucide-react';
import { useUI } from '../../state';
import { useItem } from '../../store/hooks';
import { ItemDetail } from '../items/ItemDetail';
import { IconButton } from '../ui';
import { Link } from 'react-router-dom';

export function PeekPanel() {
  const { peekKey, closePeek, setOpenItemId } = useUI();
  const item = useItem(peekKey);
  useEffect(() => {
    if (peekKey) setOpenItemId(item?.id ?? null);
    return () => setOpenItemId(null);
  }, [peekKey, item?.id, setOpenItemId]);
  if (!peekKey) return null;
  return (
    <aside className="animate-peek flex w-[520px] max-w-[55vw] shrink-0 flex-col border-l border-border bg-bg" data-peek>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="flex-1 px-1 font-mono text-xs text-fg-muted">{item?.key ?? peekKey}</span>
        {item && (
          <Link to={`/i/${item.number > 0 ? item.key : item.id}`} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-muted hover:text-fg" title="Open full page">
            <Maximize2 size={14} />
          </Link>
        )}
        <IconButton onClick={closePeek} aria-label="Close (esc)">
          <X size={15} />
        </IconButton>
      </div>
      {item ? (
        <ItemDetail item={item} compact />
      ) : (
        <div className="p-6 text-sm text-fg-muted">Item {peekKey} is not in your local store (it may be syncing, or you may not have access).</div>
      )}
    </aside>
  );
}
