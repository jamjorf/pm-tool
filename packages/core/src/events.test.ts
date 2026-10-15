import { describe, it, expect } from 'vitest';
import { diffItem, eventKindOf, extractMentions, extractItemKeys, valuesEqual } from './events.js';

describe('diffItem', () => {
  it('emits one change per tracked field and per JSONB key', () => {
    const before = { title: 'a', priority: 2, assignee_id: null, estimate: '3.50', fields: { severity: 's1', steps: 'x', tags: ['a'] } };
    const after = { title: 'b', priority: 2, assignee_id: 'u1', estimate: 3.5, due_date: '2026-10-20', fields: { severity: 's2', tags: ['a'], env: 'prod' } };
    expect(diffItem(before, after)).toEqual([
      { field: 'title', old: 'a', new: 'b' },
      { field: 'assignee_id', old: null, new: 'u1' },
      { field: 'due_date', old: null, new: '2026-10-20' },
      { field: 'fields.env', old: null, new: 'prod' },
      { field: 'fields.severity', old: 's1', new: 's2' },
      { field: 'fields.steps', old: 'x', new: null },
    ]);
  });
  it('treats undefined as absent and ignores untracked columns', () => {
    expect(diffItem({ title: 'a', description: 'd' }, { title: 'a', updated_at: 'x' } as never)).toEqual([]);
    expect(diffItem({ title: 'a', fields: { a: 1 } }, { title: 'b' })).toEqual([{ field: 'title', old: 'a', new: 'b' }]);
    expect(diffItem({}, { fields: {} })).toEqual([]);
    expect(diffItem({ fields: { a: 1 } }, { fields: {} })).toEqual([{ field: 'fields.a', old: 1, new: null }]);
  });
  it('deep-compares JSON values and normalizes dates', () => {
    expect(diffItem({ fields: { tags: ['a', 'b'], obj: { x: 1 } } }, { fields: { tags: ['a', 'b'], obj: { x: 1 } } })).toEqual([]);
    expect(diffItem({ fields: { tags: ['a', 'b'] } }, { fields: { tags: ['b', 'a'] } })).toHaveLength(1);
    expect(diffItem({ archived_at: new Date('2026-01-01T00:00:00Z') as never }, { archived_at: '2026-01-01T00:00:00.000Z' })).toEqual([]);
    expect(valuesEqual(undefined, null)).toBe(true);
    expect(valuesEqual({ a: undefined }, {})).toBe(true);
  });
});

describe('eventKindOf', () => {
  it('maps entity/action/field to event kinds', () => {
    expect(eventKindOf({ entity_type: 'work_item', action: 'create', field: null })).toBe('item.created');
    expect(eventKindOf({ entity_type: 'work_item', action: 'update', field: 'state_id' })).toBe('item.transitioned');
    expect(eventKindOf({ entity_type: 'work_item', action: 'transition', field: 'state_id' })).toBe('item.transitioned');
    expect(eventKindOf({ entity_type: 'work_item', action: 'update', field: 'title' })).toBe('item.updated');
    expect(eventKindOf({ entity_type: 'work_item', action: 'delete', field: null })).toBe('item.deleted');
    expect(eventKindOf({ entity_type: 'work_item', action: 'restore', field: null })).toBe('item.restored');
    expect(eventKindOf({ entity_type: 'comment', action: 'create', field: null })).toBe('comment.created');
    expect(eventKindOf({ entity_type: 'comment', action: 'update', field: 'body' })).toBe('comment.updated');
    expect(eventKindOf({ entity_type: 'comment', action: 'delete', field: null })).toBe('comment.deleted');
    expect(eventKindOf({ entity_type: 'relation', action: 'create', field: null })).toBe('relation.added');
    expect(eventKindOf({ entity_type: 'relation', action: 'relation_add', field: null })).toBe('relation.added');
    expect(eventKindOf({ entity_type: 'relation', action: 'delete', field: null })).toBe('relation.removed');
    expect(eventKindOf({ entity_type: 'project', action: 'create', field: null })).toBe('project.created');
    expect(eventKindOf({ entity_type: 'project', action: 'update', field: 'name' })).toBe('project.updated');
    expect(eventKindOf({ entity_type: 'view', action: 'create', field: null })).toBeNull();
    expect(eventKindOf({ entity_type: 'work_item', action: 'weird', field: null })).toBeNull();
  });
});

describe('extractMentions', () => {
  it('finds @[Name](user:<uuid>) mentions, unique, in order', () => {
    const a = '11111111-2222-4333-8444-555555555555', b = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const md = `Hey @[Alice Chen](user:${a}) and @[Bob O'Neil](user:${b.toUpperCase()}) — ping @[Alice](user:${a}). Not @[x](user:nope) nor @alice.`;
    expect(extractMentions(md)).toEqual([a, b]);
    expect(extractMentions('')).toEqual([]);
  });
});

describe('extractItemKeys', () => {
  it('finds KEY-123 tokens with word boundaries, unique, in order', () => {
    expect(extractItemKeys('Fixes RATES-12 and relates to EQD-3; see RATES-12 again (ONB-1).')).toEqual(['RATES-12', 'EQD-3', 'ONB-1']);
    expect(extractItemKeys('hash xSHA-1 and SHA-1abc and foo-BAR-2 and lowercase rates-1 and A-1')).toEqual([]);
    expect(extractItemKeys('https://pm.example.com/i/RATES-7?x=1 and [OPS-10](link)')).toEqual(['RATES-7', 'OPS-10']);
    expect(extractItemKeys('K2-99 K-1 TOOLONGKEYNAME-1')).toEqual(['K2-99']);
    expect(extractItemKeys('')).toEqual([]);
  });
});
