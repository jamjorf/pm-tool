import { describe, it, expect } from 'vitest';
import type { ItemRow, View } from '@pm/core';
import { resolveActions, resolveNavigation, commonTransitions } from '../components/palette/actions';
import * as F from './fixtures';

const items: ItemRow[] = [
  { ...F.item, id: 'a0000000-0000-4000-8000-000000000001', key: 'RATES-1', title: 'Migrate curve builder' },
  { ...F.item, id: 'a0000000-0000-4000-8000-000000000002', key: 'RATES-12', title: 'Fix swap pricing' },
  { ...F.item, id: 'a0000000-0000-4000-8000-000000000003', key: 'OPS-4', title: 'Rotate API keys' },
];
const views: View[] = [{ id: 'b0000000-0000-4000-8000-000000000001', project_id: F.PROJECT_ID, owner_id: null, name: 'Sprint board', kind: 'board', spec: {}, is_shared: true, is_default: true, icon: null, sort: 0, version: 1, created_at: '', updated_at: '', deleted_at: null }];

describe('palette action resolution', () => {
  it('offers only root actions with no targets, and item actions when items are targeted', () => {
    const none = resolveActions(0).map((a) => a.id);
    expect(none).toContain('new_item');
    expect(none).not.toContain('assign');
    const one = resolveActions(1).map((a) => a.id);
    expect(one).toEqual(expect.arrayContaining(['assign', 'priority', 'transition', 'label', 'move', 'due', 'delete', 'open_full', 'watch', 'new_item']));
    const many = resolveActions(3).map((a) => a.id);
    expect(many).toContain('transition');
    expect(many).not.toContain('open_full');
  });

  it('resolves navigation by exact key first, then prefix, then fuzzy title, plus projects and views', () => {
    const exact = resolveNavigation('rates-12', items, [F.project], views);
    expect(exact[0]?.hint).toBe('RATES-12');
    const prefix = resolveNavigation('RATES-1', items, [F.project], views);
    expect(prefix[0]?.hint).toBe('RATES-1');
    const fuzzy = resolveNavigation('swap pricing', items, [F.project], views);
    expect(fuzzy[0]?.hint).toBe('RATES-12');
    const proj = resolveNavigation('rates', items, [F.project], views);
    expect(proj.some((c) => c.kind === 'project')).toBe(true);
    const view = resolveNavigation('sprint', items, [F.project], views);
    expect(view[0]?.kind).toBe('view');
    const recent = resolveNavigation('', items, [F.project], views, [items[2]!.id]);
    expect(recent.map((r) => r.hint)).toEqual(['OPS-4']);
  });

  it('intersects transitions across targets for bulk transition', () => {
    const t = F.transitions;
    const common = commonTransitions([
      { id: '1', transitions: [{ transition: t[0]!, allowed: true, failures: [], toName: 'In Progress' }, { transition: t[1]!, allowed: true, failures: [], toName: 'Done' }] },
      { id: '2', transitions: [{ transition: t[1]!, allowed: false, failures: ['children not done'], toName: 'Done' }] },
    ]);
    expect(common.map((c) => c.key)).toEqual(['complete']);
    expect(common[0]?.allowed).toBe(false);
    expect(common[0]?.failures).toEqual(['children not done']);
  });
});
