import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SHORTCUTS, isTypingTarget, keyFromEvent, resolveShortcut, type ShortcutId } from '../../lib/shortcuts';
import { useUI } from '../../state';
import { useStore } from '../../store/hooks';
import { toggleTheme } from '../../lib/theme';
import { toast } from '../../lib/toast';

/** Fired on `window` for item-scoped shortcuts (`e` edit title) that the open item handles. */
export const ITEM_SHORTCUT_EVENT = 'pm:item-shortcut';

export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const ui = useUI();
  const { projectByKey, itemsById } = useStore();
  const { projectKey } = useParams();
  const seq = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const uiRef = useRef(ui);
  uiRef.current = ui;

  useEffect(() => {
    const act = (id: ShortcutId) => {
      const u = uiRef.current;
      switch (id) {
        case 'palette':
          u.palette ? u.closePalette() : u.openPalette();
          break;
        case 'search':
          navigate('/search');
          break;
        case 'help':
          u.setHelpOpen(!u.helpOpen);
          break;
        case 'new_item': {
          const p = projectKey ? projectByKey[projectKey.toUpperCase()] : undefined;
          const openProject = u.openItemId ? itemsById[u.openItemId]?.project_id : undefined;
          u.openQuickCreate(p ? { project_id: p.id } : openProject ? { project_id: openProject } : {});
          break;
        }
        case 'toggle_theme':
          toast({ kind: 'info', title: `Theme: ${toggleTheme()}`, ttl: 1200 });
          break;
        case 'close':
          if (u.palette) u.closePalette();
          else if (u.quickCreate) u.closeQuickCreate();
          else if (u.helpOpen) u.setHelpOpen(false);
          else if (u.selected.size) u.clearSelection();
          else if (u.peekKey) u.closePeek();
          else u.setFocused(null);
          break;
        case 'go_my_work':
          navigate('/');
          break;
        case 'go_inbox':
        case 'go_notifications':
          navigate('/inbox');
          break;
        case 'go_projects':
          navigate('/projects');
          break;
        case 'move_down':
        case 'move_up': {
          const ids = u.visibleIds;
          if (!ids.length) return;
          const idx = u.focusedId ? ids.indexOf(u.focusedId) : -1;
          const next = id === 'move_down' ? Math.min(ids.length - 1, idx + 1) : Math.max(0, idx - 1);
          u.setFocused(ids[next] ?? null);
          break;
        }
        case 'open': {
          if (!u.focusedId) return;
          const it = itemsById[u.focusedId];
          u.openPeek(it && it.number > 0 ? it.key : u.focusedId);
          break;
        }
        case 'select':
          if (u.focusedId) u.toggleSelected(u.focusedId);
          break;
        case 'select_all':
          if (u.visibleIds.length) u.setSelected(u.visibleIds);
          break;
        case 'edit_title':
          window.dispatchEvent(new CustomEvent(ITEM_SHORTCUT_EVENT, { detail: 'edit_title' }));
          break;
        case 'assign':
          if (u.targetIds.length) u.openPalette({ kind: 'assign' });
          break;
        case 'priority':
          if (u.targetIds.length) u.openPalette({ kind: 'priority' });
          break;
        case 'state':
          if (u.targetIds.length) u.openPalette({ kind: 'transition' });
          break;
        case 'label':
          if (u.targetIds.length) u.openPalette({ kind: 'label' });
          break;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const key = keyFromEvent(e);
      const typing = isTypingTarget(e.target);
      // Inside popovers/dialogs let them handle keys (they stopPropagation on Escape themselves).
      const inOverlay = (e.target as HTMLElement | null)?.closest?.('[data-popover],[role="dialog"],[cmdk-root]');
      if (typing || inOverlay) {
        // Only global shortcuts fire while typing.
        const r = resolveShortcut([key], SHORTCUTS.filter((s) => s.global));
        if ('match' in r) {
          if (r.match.id === 'close' && typing && !inOverlay) {
            (e.target as HTMLElement).blur();
            return;
          }
          if (inOverlay && r.match.id !== 'palette') return;
          e.preventDefault();
          act(r.match.id);
        }
        seq.current = [];
        return;
      }
      if (e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') return;
      seq.current.push(key);
      if (timer.current) clearTimeout(timer.current);
      const r = resolveShortcut(seq.current);
      if ('match' in r) {
        e.preventDefault();
        seq.current = [];
        act(r.match.id);
      } else if ('prefix' in r) {
        timer.current = setTimeout(() => (seq.current = []), 900);
      } else {
        // Retry with just this key (drop a stale prefix).
        seq.current = [key];
        const r2 = resolveShortcut(seq.current);
        if ('match' in r2) {
          e.preventDefault();
          seq.current = [];
          act(r2.match.id);
        } else if (!('prefix' in r2)) seq.current = [];
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, projectKey, projectByKey, itemsById]);
}
