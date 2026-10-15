import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useItem, useStore } from '../store/hooks';
import { ItemDetail } from '../components/items/ItemDetail';
import { pushRecent } from '../components/palette/CommandPalette';

export function ItemPage() {
  const { itemKey } = useParams();
  const item = useItem(itemKey);
  const { ready } = useStore();
  useEffect(() => { if (item) pushRecent(item.id); }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready) return <div className="p-8 text-sm text-fg-muted">Loading local store…</div>;
  if (!item) return <div className="p-8 text-sm text-fg-muted">Item <code>{itemKey}</code> is not in your local store. It may not exist, may be syncing, or you may not have access.</div>;
  return <ItemDetail item={item} />;
}
