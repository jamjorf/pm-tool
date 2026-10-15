import { describe, it, expect } from 'vitest';
import { permissions } from './evaluate.js';
import { PermissionError, type Actor, type Resource, type Action } from './types.js';

const firm = { id: 'p-firm', visibility: 'firm' as const };
const priv = { id: 'p-priv', visibility: 'private' as const };
const actor = (over: Partial<Actor>): Actor => ({ id: 'u', firmRole: 'member', memberships: {}, ...over });
const owner = actor({ id: 'o', firmRole: 'owner' });
const admin = actor({ id: 'a', firmRole: 'admin' });
const member = actor({ id: 'm' });
const guest = actor({ id: 'g', firmRole: 'guest' });
const viewer = actor({ id: 'v', memberships: { 'p-firm': 'viewer', 'p-priv': 'viewer' } });
const projAdmin = actor({ id: 'pa', memberships: { 'p-priv': 'admin' } });
const item = (over: Partial<Resource['item'] & object> = {}): Resource => ({ item: { project: firm, confidential: false, assignee_id: null, reporter_id: null, created_by: null, ...over } });

describe('effectiveRole', () => {
  it('explicit membership wins, then firm role + visibility', () => {
    expect(permissions.effectiveRole(viewer, firm)).toBe('viewer');
    expect(permissions.effectiveRole(owner, priv)).toBe('admin');
    expect(permissions.effectiveRole(admin, firm)).toBe('admin');
    expect(permissions.effectiveRole(member, firm)).toBe('editor');
    expect(permissions.effectiveRole(member, priv)).toBeNull();
    expect(permissions.effectiveRole(guest, firm)).toBeNull();
    expect(permissions.effectiveRole(actor({ id: 'g', firmRole: 'guest', memberships: { 'p-priv': 'editor' } }), priv)).toBe('editor');
    expect(permissions.effectiveRole(actor({ id: 'x', firmRole: 'admin', memberships: { 'p-firm': 'viewer' } }), firm)).toBe('viewer');
  });
});

describe('can', () => {
  it('firm owner/admin pass everything (incl. firm_admin actions)', () => {
    for (const a of ['workflow.manage', 'user.manage', 'project.edit', 'item.delete', 'comment.edit_any'] as Action[]) {
      expect(permissions.can(owner, a, { project: priv })).toBe(true);
      expect(permissions.can(admin, a, { project: priv })).toBe(true);
      expect(permissions.can(member, a === 'project.edit' || a === 'item.delete' || a === 'comment.edit_any' ? 'item.view' : a, { project: firm })).toBe(a === 'item.view' ? true : false);
    }
    expect(permissions.can(projAdmin, 'workflow.manage')).toBe(false);
  });
  it('role lattice per action', () => {
    expect(permissions.can(member, 'item.create', { project: firm })).toBe(true);
    expect(permissions.can(member, 'project.edit', { project: firm })).toBe(false);
    expect(permissions.can(viewer, 'item.view', { project: firm })).toBe(true);
    expect(permissions.can(viewer, 'item.edit', { project: firm })).toBe(false);
    expect(permissions.can(viewer, 'comment.create', { project: firm })).toBe(true);
    expect(permissions.can(projAdmin, 'project.admin', { project: priv })).toBe(true);
    expect(permissions.can(member, 'item.view', { project: priv })).toBe(false);
    expect(permissions.can(guest, 'item.view', { project: firm })).toBe(false);
  });
  it('any_user actions need an active non-guest', () => {
    expect(permissions.can(member, 'project.create')).toBe(true);
    expect(permissions.can(guest, 'project.create')).toBe(false);
    expect(permissions.can(actor({ id: 'i', isActive: false }), 'project.create')).toBe(false);
    expect(permissions.can(actor({ id: 'i', firmRole: 'owner', isActive: false }), 'item.view', { project: firm })).toBe(false);
  });
  it('*_own actions require ownership unless admin', () => {
    expect(permissions.can(viewer, 'comment.edit_own', { project: firm, ownerId: 'v' })).toBe(true);
    expect(permissions.can(viewer, 'comment.edit_own', { project: firm, ownerId: 'someone' })).toBe(false);
    expect(permissions.can(viewer, 'comment.edit_own', { project: firm })).toBe(false);
    expect(permissions.can(projAdmin, 'view.edit_own', { project: priv, ownerId: 'someone' })).toBe(true);
    expect(permissions.can(member, 'view.edit_shared', { project: firm })).toBe(true);
    expect(permissions.can(viewer, 'view.edit_shared', { project: firm })).toBe(false);
  });
  it('confidential items: assignee/reporter/creator/admin only', () => {
    const conf = { confidential: true };
    expect(permissions.can(member, 'item.view', item(conf))).toBe(false);
    expect(permissions.can(member, 'item.edit', item(conf))).toBe(false);
    expect(permissions.can(member, 'comment.create', item(conf))).toBe(false);
    expect(permissions.can(member, 'item.view', item({ ...conf, assignee_id: 'm' }))).toBe(true);
    expect(permissions.can(member, 'item.view', item({ ...conf, reporter_id: 'm' }))).toBe(true);
    expect(permissions.can(member, 'item.edit', item({ ...conf, created_by: 'm' }))).toBe(true);
    expect(permissions.can(owner, 'item.view', item(conf))).toBe(true);
    expect(permissions.can(actor({ id: 'x', memberships: { 'p-firm': 'admin' } }), 'item.view', item(conf))).toBe(true);
    expect(permissions.can(member, 'item.view', item())).toBe(true);
    expect(permissions.can(viewer, 'item.view', { item: { ...item().item!, project: priv } })).toBe(true);
    expect(permissions.can(member, 'item.view', { item: { ...item().item!, project: priv } })).toBe(false);
  });
  it('API key scopes: without write only read actions pass', () => {
    const ro = actor({ id: 'o', firmRole: 'owner', scopes: ['read'] });
    expect(permissions.can(ro, 'item.view', { project: priv })).toBe(true);
    expect(permissions.can(ro, 'export', { project: priv })).toBe(true);
    expect(permissions.can(ro, 'activity.view', { project: priv })).toBe(true);
    expect(permissions.can(ro, 'item.edit', { project: priv })).toBe(false);
    expect(permissions.can(ro, 'workflow.manage')).toBe(false);
    expect(permissions.can(ro, 'project.create')).toBe(false);
    const rw = actor({ id: 'o', firmRole: 'member', scopes: ['read', 'write'] });
    expect(permissions.can(rw, 'item.edit', { project: firm })).toBe(true);
    expect(permissions.can(rw, 'item.edit', { project: priv })).toBe(false);
  });
  it('firm-level resources (no project) use the firm-wide default role', () => {
    expect(permissions.can(member, 'label.manage')).toBe(true);
    expect(permissions.can(member, 'view.create')).toBe(true);
    expect(permissions.can(guest, 'view.create')).toBe(false);
    expect(permissions.can(member, 'project.edit')).toBe(false);
  });
});

describe('assert', () => {
  it('throws PermissionError with a reason', () => {
    expect(() => permissions.assert(member, 'item.view', item({ confidential: true }))).toThrow(PermissionError);
    try { permissions.assert(viewer, 'item.edit', { project: firm }); } catch (e) {
      expect(e).toBeInstanceOf(PermissionError);
      expect((e as PermissionError).status).toBe(403);
      expect((e as PermissionError).action).toBe('item.edit');
      expect((e as Error).message).toMatch(/requires project role editor \(you are viewer\)/);
    }
    expect(() => permissions.assert(member, 'workflow.manage')).toThrow(/firm owner or admin/);
    expect(() => permissions.assert(member, 'item.view', { project: priv })).toThrow(/no access to this project/);
    expect(() => permissions.assert(actor({ id: 'k', firmRole: 'owner', scopes: [] }), 'item.edit', { project: firm })).toThrow(/write scope/);
    expect(() => permissions.assert(owner, 'user.manage')).not.toThrow();
  });
});
