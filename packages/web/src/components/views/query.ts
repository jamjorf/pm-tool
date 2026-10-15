import { useMemo } from 'react';
import { runSpec, type ItemRow, type QuerySpec } from '@pm/core';
import { useLookups, useQueryContext } from '../../store/hooks';

export type Group = { key: string; label: string; items: ItemRow[] };
export interface RunResult { items: ItemRow[]; groups: Group[] | null; fallback: boolean }

let warned = false;

/** Run a QuerySpec over local rows with @pm/core runSpec (falls back to unfiltered rows while core is a stub). */
export function useRunSpec(spec: QuerySpec, items: ItemRow[]): RunResult {
  const ctx = useQueryContext();
  const lookups = useLookups();
  return useMemo(() => {
    try {
      const r = runSpec(spec, items, ctx, lookups);
      return { items: r.items, groups: r.groups, fallback: false };
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn('[pm] runSpec unavailable (core not built?):', (e as Error).message);
      }
      const sorted = [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const limited = spec.limit ? sorted.slice(0, spec.limit) : sorted;
      let groups: Group[] | null = null;
      if (spec.group_by) {
        const m = new Map<string, ItemRow[]>();
        for (const it of limited) {
          const k = String((it as unknown as Record<string, unknown>)[spec.group_by] ?? '');
          (m.get(k) ?? m.set(k, []).get(k)!).push(it);
        }
        groups = [...m.entries()].map(([key, xs]) => ({ key, label: key || '—', items: xs }));
      }
      return { items: limited, groups, fallback: true };
    }
  }, [spec, items, ctx, lookups]);
}
