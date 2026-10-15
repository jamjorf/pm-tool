import { describe, it, expect } from 'vitest';
import type { FilterExpr } from '@pm/core';
import { toConditions, fromConditions, buildFieldCatalog, OPS_BY_KIND } from '../components/views/filter';
import { encodeState, decodeState, mergeSpec, readOverrides, writeOverrides } from '../lib/urlState';
import { itemType } from './fixtures';

describe('filter builder serialization', () => {
  it('round-trips a flat AND of conditions', () => {
    const expr: FilterExpr = { and: [{ field: 'assignee_id', op: 'eq', value: '$me' }, { field: 'state.category', op: 'nin', value: ['done', 'canceled'] }, { field: 'due_date', op: 'is_null' }] };
    const { conditions, rest } = toConditions(expr);
    expect(conditions).toHaveLength(3);
    expect(rest).toHaveLength(0);
    expect(fromConditions(conditions, rest)).toEqual(expr);
  });

  it('keeps or/not groups as opaque rest clauses and collapses single conditions', () => {
    const expr: FilterExpr = { and: [{ field: 'priority', op: 'lte', value: 2 }, { or: [{ field: 'labels', op: 'has', value: 'x' }, { not: { field: 'title', op: 'contains', value: 'wip' } }] }] };
    const { conditions, rest } = toConditions(expr);
    expect(conditions).toHaveLength(1);
    expect(rest).toHaveLength(1);
    expect(fromConditions(conditions, rest)).toEqual(expr);
    expect(fromConditions([{ field: 'title', op: 'contains', value: 'a' }])).toEqual({ field: 'title', op: 'contains', value: 'a' });
    expect(fromConditions([])).toBeUndefined();
  });

  it('URL state round-trips through base64 and merges over the saved spec', () => {
    const filter: FilterExpr = { field: 'fields.severity', op: 'in', value: ['s1', 's2'] };
    expect(decodeState(encodeState(filter))).toEqual(filter);
    const params = writeOverrides(new URLSearchParams('peek=RATES-1'), { filter, sort: [{ field: 'due_date', dir: 'desc' }], group: 'state_id' });
    expect(params.get('peek')).toBe('RATES-1');
    const o = readOverrides(params);
    expect(o.filter).toEqual(filter);
    expect(o.sort).toEqual([{ field: 'due_date', dir: 'desc' }]);
    const merged = mergeSpec({ kind: 'list', filter: { field: 'title', op: 'contains', value: 'old' }, columns: ['key'] }, o);
    expect(merged.filter).toEqual(filter);
    expect(merged.group_by).toBe('state_id');
    expect(merged.columns).toEqual(['key']);
    expect(mergeSpec({ filter }, { filter: null }).filter).toBeUndefined();
  });

  it('field catalog includes typed fields, labels and state.category with kind-appropriate ops', () => {
    const cat = buildFieldCatalog([itemType]);
    const sev = cat.find((f) => f.ref === 'fields.severity');
    expect(sev?.kind).toBe('enum');
    expect(sev?.options?.[0]?.value).toBe('s1');
    expect(cat.find((f) => f.ref === 'labels')?.kind).toBe('array');
    expect(OPS_BY_KIND.array).toContain('has_any');
    expect(cat.find((f) => f.ref === 'state.category')?.options?.map((o) => o.value)).toContain('in_progress');
  });
});
