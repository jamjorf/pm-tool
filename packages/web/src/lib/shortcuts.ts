// Declarative keyboard shortcut map (see ARCHITECTURE.md "Web app"). Pure, testable.

export type ShortcutId =
  | 'palette'
  | 'search'
  | 'help'
  | 'new_item'
  | 'move_down'
  | 'move_up'
  | 'open'
  | 'close'
  | 'select'
  | 'select_all'
  | 'edit_title'
  | 'assign'
  | 'priority'
  | 'state'
  | 'label'
  | 'go_inbox'
  | 'go_projects'
  | 'go_notifications'
  | 'go_my_work'
  | 'toggle_theme';

export type ShortcutGroup = 'Global' | 'Navigation' | 'Lists' | 'Item' | 'Selection';

export interface Shortcut {
  id: ShortcutId;
  /** Space-separated key sequence; each key is `mod+k`, `shift+?`, `g`, `Escape`, `Enter`… */
  keys: string;
  label: string;
  group: ShortcutGroup;
  /** Also fires while typing in an input/textarea. */
  global?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'palette', keys: 'mod+k', label: 'Command palette', group: 'Global', global: true },
  { id: 'search', keys: '/', label: 'Focus search', group: 'Global' },
  { id: 'help', keys: '?', label: 'Keyboard shortcuts', group: 'Global' },
  { id: 'new_item', keys: 'c', label: 'New item', group: 'Global' },
  { id: 'toggle_theme', keys: 't', label: 'Toggle theme', group: 'Global' },
  { id: 'close', keys: 'Escape', label: 'Close / clear selection', group: 'Global', global: true },
  { id: 'go_my_work', keys: 'g h', label: 'Go to My work', group: 'Navigation' },
  { id: 'go_inbox', keys: 'g i', label: 'Go to Inbox', group: 'Navigation' },
  { id: 'go_projects', keys: 'g p', label: 'Go to projects', group: 'Navigation' },
  { id: 'go_notifications', keys: 'g n', label: 'Go to notifications', group: 'Navigation' },
  { id: 'move_down', keys: 'j', label: 'Next row', group: 'Lists' },
  { id: 'move_up', keys: 'k', label: 'Previous row', group: 'Lists' },
  { id: 'open', keys: 'Enter', label: 'Open focused item', group: 'Lists' },
  { id: 'select', keys: 'x', label: 'Toggle selection', group: 'Selection' },
  { id: 'select_all', keys: 'mod+a', label: 'Select all rows', group: 'Selection' },
  { id: 'edit_title', keys: 'e', label: 'Edit title', group: 'Item' },
  { id: 'assign', keys: 'a', label: 'Assign…', group: 'Item' },
  { id: 'priority', keys: 'p', label: 'Set priority…', group: 'Item' },
  { id: 'state', keys: 's', label: 'Change state…', group: 'Item' },
  { id: 'label', keys: 'l', label: 'Add label…', group: 'Item' },
];

export const SHORTCUT_BY_ID: Record<ShortcutId, Shortcut> = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<
  ShortcutId,
  Shortcut
>;

/** Normalize a KeyboardEvent to a token like `mod+k`, `shift+Enter`, `g`, `?`. */
export function keyFromEvent(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  let key = e.key;
  if (key === ' ') key = 'Space';
  // Printable characters already reflect shift ('?' vs '/'); only add shift for named keys
  if (e.shiftKey && key.length > 1) parts.push('shift');
  if (key.length === 1) key = parts.includes('mod') ? key.toLowerCase() : key;
  parts.push(key);
  return parts.join('+');
}

export type ResolveResult = { match: Shortcut; } | { prefix: true } | { none: true };

/** Resolve a pending key sequence against the map. */
export function resolveShortcut(seq: string[], shortcuts: Shortcut[] = SHORTCUTS): ResolveResult {
  const typed = seq.join(' ');
  let prefix = false;
  for (const s of shortcuts) {
    if (s.keys === typed) return { match: s };
    if (s.keys.startsWith(typed + ' ')) prefix = true;
  }
  return prefix ? { prefix: true } : { none: true };
}

/** Pretty key sequence for display (`mod+k` → `⌘K` on mac). */
export function formatKeys(keys: string, isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): string[] {
  return keys.split(' ').map((k) =>
    k
      .split('+')
      .map((p) => {
        if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
        if (p === 'shift') return '⇧';
        if (p === 'alt') return isMac ? '⌥' : 'Alt';
        if (p === 'Escape') return 'Esc';
        if (p === 'Enter') return '↵';
        return p.length === 1 ? p.toUpperCase() : p;
      })
      .join(isMac ? '' : '+'),
  );
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
