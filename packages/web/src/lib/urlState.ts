import type { FilterExpr, SortSpec, ViewSpec } from '@pm/core';

/** Encode a JSON value as URL-safe base64 for `?filter=…` style state. */
export function encodeState(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState<T = unknown>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}

export interface ViewOverrides {
  filter?: FilterExpr | null;
  sort?: SortSpec[];
  group?: string | null;
  columns?: string[];
}

const KEYS = ['filter', 'sort', 'group', 'columns'] as const;

/** Read unsaved overrides from URLSearchParams. */
export function readOverrides(params: URLSearchParams): ViewOverrides {
  const out: ViewOverrides = {};
  const f = params.get('filter');
  if (f !== null) out.filter = f === '' ? null : (decodeState<FilterExpr>(f) ?? null);
  const s = params.get('sort');
  if (s !== null) out.sort = decodeState<SortSpec[]>(s) ?? [];
  const g = params.get('group');
  if (g !== null) out.group = g === '' ? null : g;
  const c = params.get('columns');
  if (c !== null) out.columns = decodeState<string[]>(c) ?? [];
  return out;
}

/** Write overrides to URLSearchParams (undefined removes the key, keeping saved value). */
export function writeOverrides(params: URLSearchParams, o: ViewOverrides): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of KEYS) next.delete(k);
  if (o.filter !== undefined) next.set('filter', o.filter === null ? '' : encodeState(o.filter));
  if (o.sort !== undefined) next.set('sort', encodeState(o.sort));
  if (o.group !== undefined) next.set('group', o.group ?? '');
  if (o.columns !== undefined) next.set('columns', encodeState(o.columns));
  return next;
}

export function hasOverrides(o: ViewOverrides): boolean {
  return KEYS.some((k) => o[k] !== undefined);
}

/** Merge saved spec + unsaved overrides into the effective ViewSpec. */
export function mergeSpec(saved: ViewSpec, o: ViewOverrides): ViewSpec {
  const spec: ViewSpec = { ...saved };
  if (o.filter !== undefined) {
    if (o.filter === null) delete spec.filter;
    else spec.filter = o.filter;
  }
  if (o.sort !== undefined) spec.sort = o.sort;
  if (o.group !== undefined) spec.group_by = o.group;
  if (o.columns !== undefined) spec.columns = o.columns;
  return spec;
}
