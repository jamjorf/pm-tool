// App-wide UI state: row selection / focus (for bulk + palette), overlays.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export type PaletteMode =
  | { kind: 'root' }
  | { kind: 'assign' }
  | { kind: 'priority' }
  | { kind: 'transition' }
  | { kind: 'label' }
  | { kind: 'move' }
  | { kind: 'due' }
  | { kind: 'project' }
  | { kind: 'view' }
  | { kind: 'item' };

export interface QuickCreateDefaults {
  project_id?: string;
  type_id?: string;
  parent_id?: string | null;
  state_id?: string;
  title?: string;
}

interface UIState {
  // selection
  selected: Set<string>;
  focusedId: string | null;
  setFocused: (id: string | null) => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: Iterable<string>) => void;
  selectRange: (ids: string[]) => void;
  clearSelection: () => void;
  /** Ids a bulk/palette action targets: selection, else focused, else the open item. */
  targetIds: string[];
  /** Ids of the rows currently rendered (for ⌘A / shift+click). */
  visibleIds: string[];
  setVisibleIds: (ids: string[]) => void;
  // overlays
  palette: PaletteMode | null;
  openPalette: (mode?: PaletteMode) => void;
  closePalette: () => void;
  quickCreate: QuickCreateDefaults | null;
  openQuickCreate: (d?: QuickCreateDefaults) => void;
  closeQuickCreate: () => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  // peek
  peekKey: string | null;
  openPeek: (idOrKey: string) => void;
  closePeek: () => void;
  openItem: (idOrKey: string, full?: boolean) => void;
  /** Id of the item open in peek/full page (used as action target when nothing is selected). */
  openItemId: string | null;
  setOpenItemId: (id: string | null) => void;
  anchorId: string | null;
  setAnchorId: (id: string | null) => void;
}

const Ctx = createContext<UIState | null>(null);

export function UIStateProvider({ children }: { children: ReactNode }) {
  const [selected, setSelectedState] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocused] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateDefaults | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const toggleSelected = useCallback((id: string) => {
    setSelectedState((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    setAnchorId(id);
  }, []);
  const setSelected = useCallback((ids: Iterable<string>) => setSelectedState(new Set(ids)), []);
  const selectRange = useCallback((ids: string[]) => setSelectedState((s) => new Set([...s, ...ids])), []);
  const clearSelection = useCallback(() => setSelectedState((s) => (s.size ? new Set() : s)), []);

  const peekKey = params.get('peek');
  const openPeek = useCallback(
    (idOrKey: string) => {
      const next = new URLSearchParams(params);
      next.set('peek', idOrKey);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );
  const closePeek = useCallback(() => {
    if (!params.has('peek')) return;
    const next = new URLSearchParams(params);
    next.delete('peek');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const openItem = useCallback(
    (idOrKey: string, full = false) => {
      if (full) navigate(`/i/${encodeURIComponent(idOrKey)}`);
      else openPeek(idOrKey);
    },
    [navigate, openPeek],
  );

  const openPalette = useCallback((mode: PaletteMode = { kind: 'root' }) => setPalette(mode), []);
  const closePalette = useCallback(() => setPalette(null), []);
  const openQuickCreate = useCallback((d: QuickCreateDefaults = {}) => setQuickCreate(d), []);
  const closeQuickCreate = useCallback(() => setQuickCreate(null), []);

  const targetIds = useMemo(() => {
    if (selected.size) return [...selected];
    if (focusedId) return [focusedId];
    if (openItemId) return [openItemId];
    return [];
  }, [selected, focusedId, openItemId]);

  const value = useMemo<UIState>(
    () => ({
      selected, focusedId, setFocused, toggleSelected, setSelected, selectRange, clearSelection, targetIds, visibleIds, setVisibleIds,
      palette, openPalette, closePalette, quickCreate, openQuickCreate, closeQuickCreate, helpOpen, setHelpOpen,
      peekKey, openPeek, closePeek, openItem, openItemId, setOpenItemId, anchorId, setAnchorId,
    }),
    [selected, focusedId, toggleSelected, setSelected, selectRange, clearSelection, targetIds, visibleIds, palette, openPalette, closePalette, quickCreate, openQuickCreate, closeQuickCreate, helpOpen, peekKey, openPeek, closePeek, openItem, openItemId, anchorId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUI(): UIState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUI outside UIStateProvider');
  return c;
}
