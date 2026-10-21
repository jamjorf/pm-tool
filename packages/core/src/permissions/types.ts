// ============================================================================
// Permissions contract. DECISION: per-project roles (RBAC) + firm role +
// project visibility. One pure function decides everything; the DB mirrors it
// in the effective_roles/visible_items views for sync-pull scoping.
// Attribute-style conditions belong in workflow guards, not here.
// ============================================================================
import type { FirmRole, ProjectRole, ProjectVisibility } from '../schema/entities.js';

export type Action =
  | 'project.view' | 'project.edit' | 'project.admin' | 'project.create'
  | 'item.view' | 'item.create' | 'item.edit' | 'item.delete' | 'item.transition' | 'item.bulk_edit'
  | 'comment.create' | 'comment.edit_own' | 'comment.edit_any' | 'comment.delete_any'
  | 'relation.edit'
  | 'view.create' | 'view.edit_own' | 'view.edit_shared'
  | 'label.manage'
  | 'workflow.manage' | 'type.manage' | 'webhook.manage' | 'integration.manage' | 'user.manage'
  | 'activity.view' | 'export';

export interface Actor {
  id: string;
  firmRole: FirmRole;
  /** project_id -> explicit membership role */
  memberships: Record<string, ProjectRole>;
  isService?: boolean;
  /** API key scopes; undefined for session users */
  scopes?: string[];
  /** users.is_active; undefined is treated as active */
  isActive?: boolean;
}

export interface ProjectCtx { id: string; visibility: ProjectVisibility; }

export interface ItemCtx {
  project: ProjectCtx;
  confidential: boolean;
  assignee_id: string | null;
  reporter_id: string | null;
  created_by: string | null;
}

export interface Resource {
  project?: ProjectCtx;
  item?: ItemCtx;
  ownerId?: string;        // for *_own actions (comment author, view owner)
}

export interface PermissionEvaluator {
  effectiveRole(actor: Actor, project: ProjectCtx): ProjectRole | null;
  can(actor: Actor, action: Action, resource?: Resource): boolean;
  /** Throws a PermissionError with a helpful message. */
  assert(actor: Actor, action: Action, resource?: Resource): void;
}

export class PermissionError extends Error {
  readonly status = 403;
  constructor(public readonly action: Action, message?: string) {
    super(message ?? `permission denied: ${action}`);
    this.name = 'PermissionError';
  }
}

/** Role lattice: viewer < editor < admin */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** Minimum project role required per action (firm owner/admin always pass; null = firm-level action) */
export const ACTION_MIN_ROLE: Record<Action, ProjectRole | 'firm_admin' | 'any_user'> = {
  'project.view': 'viewer',
  'project.edit': 'admin',
  'project.admin': 'admin',
  'project.create': 'any_user',
  'item.view': 'viewer',
  'item.create': 'editor',
  'item.edit': 'editor',
  'item.delete': 'editor',
  'item.transition': 'editor',
  'item.bulk_edit': 'editor',
  'comment.create': 'viewer',
  'comment.edit_own': 'viewer',
  'comment.edit_any': 'admin',
  'comment.delete_any': 'admin',
  'relation.edit': 'editor',
  'view.create': 'viewer',
  'view.edit_own': 'viewer',
  'view.edit_shared': 'editor',
  'label.manage': 'editor',
  'workflow.manage': 'firm_admin',
  'type.manage': 'firm_admin',
  'webhook.manage': 'firm_admin',
  'integration.manage': 'firm_admin',
  'user.manage': 'firm_admin',
  'activity.view': 'viewer',
  'export': 'viewer',
};
