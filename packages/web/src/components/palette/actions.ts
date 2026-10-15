// Pure palette action resolution: what actions exist for a given context. Testable without React.
import type { ItemRow, Project, View, WorkflowTransition } from '@pm/core';
import { fuzzyScore } from '../../lib/util';

export type PaletteActionId =
  | 'new_item' | 'new_view' | 'toggle_theme' | 'go_my_work' | 'go_inbox' | 'go_search' | 'help' | 'settings'
  | 'assign' | 'priority' | 'transition' | 'label' | 'move' | 'due' | 'delete' | 'open_full' | 'watch';

export interface PaletteAction {
  id: PaletteActionId;
  label: string;
  group: 'Actions' | 'Selection' | 'Navigate';
  shortcut?: string;
  /** Only when ≥1 target items. */
  needsTargets?: boolean;
}

export const ROOT_ACTIONS: PaletteAction[] = [
  { id: 'new_item', label: 'New item', group: 'Actions', shortcut: 'c' },
  { id: 'new_view', label: 'New view', group: 'Actions' },
  { id: 'toggle_theme', label: 'Toggle theme', group: 'Actions', shortcut: 't' },
  { id: 'help', label: 'Keyboard shortcuts', group: 'Actions', shortcut: '?' },
  { id: 'settings', label: 'Settings', group: 'Navigate' },
  { id: 'go_my_work', label: 'Go to My work', group: 'Navigate', shortcut: 'g h' },
  { id: 'go_inbox', label: 'Go to Inbox', group: 'Navigate', shortcut: 'g i' },
  { id: 'go_search', label: 'Search', group: 'Navigate', shortcut: '/' },
];

export const TARGET_ACTIONS: PaletteAction[] = [
  { id: 'assign', label: 'Assign to…', group: 'Selection', shortcut: 'a', needsTargets: true },
  { id: 'priority', label: 'Set priority…', group: 'Selection', shortcut: 'p', needsTargets: true },
  { id: 'transition', label: 'Transition →…', group: 'Selection', shortcut: 's', needsTargets: true },
  { id: 'label', label: 'Add label…', group: 'Selection', shortcut: 'l', needsTargets: true },
  { id: 'move', label: 'Move to project…', group: 'Selection', needsTargets: true },
  { id: 'due', label: 'Set due date…', group: 'Selection', needsTargets: true },
  { id: 'watch', label: 'Watch / unwatch', group: 'Selection', needsTargets: true },
  { id: 'open_full', label: 'Open full page', group: 'Selection', needsTargets: true },
  { id: 'delete', label: 'Delete', group: 'Selection', needsTargets: true },
];

/** Actions available for N target items (0 → root actions only). */
export function resolveActions(targetCount: number): PaletteAction[] {
  const base = targetCount > 0 ? TARGET_ACTIONS.filter((a) => !(targetCount > 1 && (a.id === 'open_full' || a.id === 'watch'))) : [];
  return [...base, ...ROOT_ACTIONS];
}

export interface NavCandidate {
  kind: 'item' | 'project' | 'view';
  id: string;
  label: string;
  hint: string;
  score: number;
  item?: ItemRow;
  project?: Project;
  view?: View;
}

const KEY_RE = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/i;

/** Fuzzy-match navigation targets: item keys (exact first), titles, projects, views. */
export function resolveNavigation(query: string, items: ItemRow[], projects: Project[], views: View[], recentIds: string[] = [], limit = 12): NavCandidate[] {
  const q = query.trim();
  const out: NavCandidate[] = [];
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  if (!q) {
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of recentIds) {
      const it = byId.get(id);
      if (it) out.push({ kind: 'item', id: it.id, label: it.title, hint: it.key, score: 1, item: it });
    }
    return out.slice(0, limit);
  }
  const keyMatch = KEY_RE.exec(q);
  for (const it of items) {
    let score = 0;
    if (keyMatch && it.key.toUpperCase() === q.toUpperCase()) score = 10_000;
    else if (it.key.toUpperCase().startsWith(q.toUpperCase())) score = 2000 + q.length;
    else score = fuzzyScore(q, it.title);
    if (score > 0) out.push({ kind: 'item', id: it.id, label: it.title, hint: it.key, score, item: it });
  }
  for (const p of projects) {
    const s = Math.max(fuzzyScore(q, p.name), p.key.toUpperCase().startsWith(q.toUpperCase()) ? 1500 : 0);
    if (s > 0) out.push({ kind: 'project', id: p.id, label: p.name, hint: p.key, score: s + 50, project: p });
  }
  for (const v of views) {
    const s = fuzzyScore(q, v.name);
    if (s > 0) out.push({ kind: 'view', id: v.id, label: v.name, hint: v.project_id ? (projectsById.get(v.project_id)?.key ?? '') : 'saved view', score: s + 20, view: v });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** Transitions allowed for ALL targets (intersection by key), for bulk transition. */
export function commonTransitions(options: { id: string; transitions: { transition: WorkflowTransition; allowed: boolean; failures: string[]; toName: string }[] }[]): { key: string; name: string; toName: string; allowed: boolean; failures: string[] }[] {
  if (options.length === 0) return [];
  const first = options[0]!;
  return first.transitions
    .filter((t) => options.every((o) => o.transitions.some((x) => x.transition.key === t.transition.key)))
    .map((t) => {
      const all = options.map((o) => o.transitions.find((x) => x.transition.key === t.transition.key)!);
      const failures = [...new Set(all.flatMap((x) => x.failures))];
      return { key: t.transition.key, name: t.transition.name, toName: t.toName, allowed: all.every((x) => x.allowed), failures };
    });
}
