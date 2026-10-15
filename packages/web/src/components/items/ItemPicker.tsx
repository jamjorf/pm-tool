// Palette-style picker over local items (by key or title), used for parent / relations / palette.
import { useMemo } from 'react';
import type { ItemRow } from '@pm/core';
import { Picker, StateDot, type PickerItem } from '../ui';
import { useStore } from '../../store/hooks';
import { stateColor } from '../../lib/util';

export function ItemPicker({ open, onClose, anchor, onPick, exclude, projectId, placeholder = 'Search items by key or title…' }: { open: boolean; onClose: () => void; anchor: HTMLElement | null; onPick: (item: ItemRow) => void; exclude?: Set<string>; projectId?: string; placeholder?: string }) {
  const { items, statesById, itemsById } = useStore();
  const list = useMemo(() => {
    const xs = items.filter((i) => !exclude?.has(i.id) && (!projectId || i.project_id === projectId));
    xs.sort((a, b) => (a.project_id === projectId ? -1 : 1) - (b.project_id === projectId ? -1 : 1) || b.updated_at.localeCompare(a.updated_at));
    return xs.slice(0, 400);
  }, [items, exclude, projectId]);
  const pickerItems: PickerItem[] = list.map((i) => {
    const s = statesById[i.state_id];
    return { id: i.id, label: i.title, hint: i.key, icon: <StateDot color={stateColor(s)} category={s?.category} />, keywords: i.key };
  });
  return <Picker open={open} onClose={onClose} anchor={anchor} items={pickerItems} placeholder={placeholder} width={420} onSelect={(p) => { const it = itemsById[p.id]; if (it) onPick(it); }} />;
}
