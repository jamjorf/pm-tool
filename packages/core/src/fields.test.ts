import { describe, it, expect } from 'vitest';
import { fieldsSchemaFor, validateFields, fieldLabel } from './fields.js';
import type { FieldDef } from './schema/entities.js';

const defs: FieldDef[] = [
  { key: 'severity', label: 'Severity', kind: 'select', required: true, options: [{ value: 's1', label: 'S1' }, { value: 's2', label: 'S2' }] },
  { key: 'environment', label: 'Environment', kind: 'select', options: [{ value: 'prod', label: 'Prod' }] },
  { key: 'steps', label: 'Steps', kind: 'long_text' },
  { key: 'notional', label: 'Notional', kind: 'number', min: 0, max: 1_000_000 },
  { key: 'approved', label: 'Approved', kind: 'bool' },
  { key: 'go_live', label: 'Go-live', kind: 'date' },
  { key: 'deployed_at', label: 'Deployed', kind: 'datetime' },
  { key: 'tags', label: 'Tags', kind: 'multi_select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'approver', label: 'Approver', kind: 'user' },
  { key: 'links', label: 'Links', kind: 'url', multi: true },
  { key: 'free', label: 'Free select', kind: 'select' },
  { key: 'region', label: 'Region', kind: 'text', default: 'EMEA' },
];
const uuid = '11111111-2222-4333-8444-555555555555';

describe('fieldsSchemaFor', () => {
  it('builds a strict object schema', () => {
    const s = fieldsSchemaFor(defs);
    expect(s.safeParse({ severity: 's1' }).success).toBe(true);
    expect(s.safeParse({ severity: 's1', bogus: 1 }).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false); // severity required
    expect(s.safeParse({ severity: 's9' }).success).toBe(false);
  });
});

describe('validateFields', () => {
  it('accepts a full valid object and drops undefined', () => {
    const r = validateFields(defs, {
      severity: 's2', environment: null, steps: 'x', notional: 5, approved: false, go_live: '2026-10-15', deployed_at: '2026-10-15T10:00:00Z',
      tags: ['a', 'b'], approver: uuid, links: ['https://example.com/a'], free: 'anything', region: undefined,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.environment).toBeNull();
      expect(r.value.region).toBe('EMEA'); // default applied
      expect('deployed_at' in r.value).toBe(true);
    }
  });
  it('coerces numeric strings and boolean strings', () => {
    const r = validateFields(defs, { severity: 's1', notional: '1200.5', approved: 'true' });
    expect(r).toEqual({ ok: true, value: { severity: 's1', notional: 1200.5, approved: true, region: 'EMEA' } });
  });
  it('reports one error per field with the key', () => {
    const r = validateFields(defs, { environment: 'staging', notional: -1, approved: 'maybe', go_live: '15/10/2026', deployed_at: 'soon', tags: ['zzz'], approver: 'bob', links: 'not a url', nope: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const byField = Object.fromEntries(r.errors.map((e) => [e.field, e.message]));
      expect(byField.severity).toBe('is required');
      expect(byField.environment).toMatch(/must be one of prod/);
      expect(byField.notional).toMatch(/>= 0/);
      expect(byField.approved).toMatch(/boolean/);
      expect(byField.go_live).toMatch(/YYYY-MM-DD/);
      expect(byField.deployed_at).toMatch(/ISO 8601/);
      expect(byField.tags).toMatch(/must be one of a, b/);
      expect(byField.approver).toMatch(/user id/);
      expect(byField.links).toMatch(/array|URL/);
      expect(byField.nope).toMatch(/unknown field/);
    }
  });
  it('required rejects null and multi wraps the base', () => {
    const r = validateFields(defs, { severity: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toEqual({ field: 'severity', message: 'is required' });
    const r2 = validateFields(defs, { severity: 's1', links: ['nope'] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors[0]!.field).toBe('links');
    expect(validateFields([], {}).ok).toBe(true);
  });
});

describe('fieldLabel', () => {
  it('resolves custom and builtin labels', () => {
    expect(fieldLabel('fields.severity', defs)).toBe('Severity');
    expect(fieldLabel('fields.owner_desk')).toBe('Owner desk');
    expect(fieldLabel('due_date')).toBe('Due date');
    expect(fieldLabel('state.category')).toBe('State category');
    expect(fieldLabel('whatever_else')).toBe('Whatever else');
  });
});
