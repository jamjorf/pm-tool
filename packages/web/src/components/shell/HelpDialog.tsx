import { SHORTCUTS, type ShortcutGroup } from '../../lib/shortcuts';
import { useUI } from '../../state';
import { Dialog, Kbd } from '../ui';

const GROUPS: ShortcutGroup[] = ['Global', 'Navigation', 'Lists', 'Selection', 'Item'];

export function HelpDialog() {
  const { helpOpen, setHelpOpen } = useUI();
  return (
    <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" width={640}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        {GROUPS.map((g) => (
          <div key={g}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">{g}</div>
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <div key={s.id} className="flex h-7 items-center justify-between text-sm">
                <span className="text-fg-muted">{s.label}</span>
                <Kbd keys={s.keys} />
              </div>
            ))}
          </div>
        ))}
        <div className="col-span-2 text-xs text-fg-faint">
          In lists, <kbd>shift</kbd>+click selects a range. Inside the command palette, type a key like <code>RATES-12</code> to jump to an item.
        </div>
      </div>
    </Dialog>
  );
}
