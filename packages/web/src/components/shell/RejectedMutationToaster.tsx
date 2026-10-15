import { useEffect, useRef } from 'react';
import { useNotifications } from '../../store/hooks';
import { useActions } from '../items/useActions';
import { toast } from '../../lib/toast';
import { useUI } from '../../state';
import { useStore } from '../../store/hooks';

/** Server-side rejections of optimistic mutations arrive as `mutation_rejected` notifications: toast + mark read. */
export function RejectedMutationToaster() {
  const notifications = useNotifications();
  const a = useActions();
  const seen = useRef(new Set<string>());
  const { openItem } = useUI();
  const { itemsById } = useStore();
  useEffect(() => {
    for (const n of notifications) {
      if (n.kind !== 'mutation_rejected' || n.read_at || seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      const item = n.item_id ? itemsById[n.item_id] : undefined;
      toast({
        kind: 'error',
        title: n.title || 'Change rejected by the server',
        body: n.body ?? undefined,
        ttl: 9000,
        action: item ? { label: `Open ${item.key}`, onClick: () => openItem(item.key) } : undefined,
      });
      void a.markRead(n.id);
    }
  }, [notifications, a, itemsById, openItem]);
  return null;
}
