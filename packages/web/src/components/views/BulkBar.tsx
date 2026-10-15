// Bottom bar when ≥1 rows are selected: count, assign, priority, state, labels, move, delete, clear.
import { useState } from 'react';
import { X, Trash2, FolderInput, ArrowRightLeft } from 'lucide-react';
import { useUI } from '../../state';
import { useStore } from '../../store/hooks';
import { useActions } from '../items/useActions';
import { AssigneeChip, PriorityChip, LabelsChip, DueDateChip, ProjectPicker } from '../items/properties';
import { Button, ConfirmDialog, Kbd } from '../ui';

export function BulkBar() {
  const { selected, clearSelection, openPalette } = useUI();
  const { itemsById } = useStore();
  const a = useActions();
  const [moveAnchor, setMoveAnchor] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (selected.size === 0) return null;
  const ids = [...selected].filter((id) => itemsById[id]);
  const first = itemsById[ids[0] ?? ''];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <div className="pointer-events-auto animate-in flex items-center gap-1 rounded-xl border border-border bg-bg-elevated px-2 py-1.5 shadow-[var(--shadow)]">
        <span className="mr-1 rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-accent-fg">{ids.length} selected</span>
        <AssigneeChip ids={ids} />
        <PriorityChip ids={ids} />
        <Button variant="ghost" icon={<ArrowRightLeft size={14} />} onClick={() => openPalette({ kind: 'transition' })} title="Transition (s)">
          State
        </Button>
        <LabelsChip ids={ids} item={undefined} />
        <DueDateChip ids={ids} />
        <Button variant="ghost" icon={<FolderInput size={14} />} onClick={(e) => setMoveAnchor(e.currentTarget)}>
          Move
        </Button>
        <Button variant="ghost" icon={<Trash2 size={14} />} className="text-danger" onClick={() => setConfirm(true)}>
          Delete
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" icon={<X size={14} />} onClick={clearSelection} title="Clear selection (esc)">
          <Kbd keys="Escape" />
        </Button>
      </div>
      <ProjectPicker open={!!moveAnchor} onClose={() => setMoveAnchor(null)} anchor={moveAnchor} value={first?.project_id} onChange={(p) => { void a.move(ids, p); clearSelection(); }} />
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}?`} body="Items are soft-deleted and can be restored from the undo toast." onConfirm={() => { void a.remove(ids); clearSelection(); }} />
    </div>
  );
}
