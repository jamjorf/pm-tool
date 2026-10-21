// ============================================================================
// Permission evaluator (pure). Mirrors the effective_roles/visible_items views
// in the SQL migration.
// ============================================================================
import type { Actor, Action, Resource, ProjectCtx, PermissionEvaluator } from './types.js';
import { ACTION_MIN_ROLE, ROLE_RANK, PermissionError } from './types.js';
import type { ProjectRole } from '../schema/entities.js';

/** Actions an API key without the `write` scope may still perform. */
export const READ_ACTIONS: ReadonlySet<Action> = new Set<Action>(['project.view', 'item.view', 'activity.view', 'export']);

function isFirmAdmin(actor: Actor): boolean { return actor.firmRole === 'owner' || actor.firmRole === 'admin'; }
function isActive(actor: Actor): boolean { return actor.isActive !== false; }

function effectiveRole(actor: Actor, project: ProjectCtx): ProjectRole | null {
  const explicit = actor.memberships?.[project.id];
  if (explicit) return explicit;
  if (isFirmAdmin(actor)) return 'admin';
  if (actor.firmRole === 'member' && project.visibility === 'firm') return 'editor';
  return null;
}

/** Role used when an action has no project context (firm-wide labels, cross-project views). */
function firmLevelRole(actor: Actor): ProjectRole | null {
  if (isFirmAdmin(actor)) return 'admin';
  if (actor.firmRole === 'member') return 'editor';
  return null;
}

function canViewItem(actor: Actor, resource: Resource, role: ProjectRole | null): boolean {
  const item = resource.item;
  if (!item) return role !== null;
  if (role === null) return false;
  if (!item.confidential) return true;
  return role === 'admin' || item.assignee_id === actor.id || item.reporter_id === actor.id || item.created_by === actor.id;
}

function can(actor: Actor, action: Action, resource: Resource = {}): boolean {
  const min = ACTION_MIN_ROLE[action];
  if (!min) return false;
  if (!isActive(actor)) return false;
  if (actor.scopes !== undefined && !actor.scopes.includes('write') && !READ_ACTIONS.has(action)) return false;

  if (min === 'firm_admin') return isFirmAdmin(actor);
  if (min === 'any_user') return actor.firmRole !== 'guest';

  const project = resource.project ?? resource.item?.project;
  const role = project ? effectiveRole(actor, project) : firmLevelRole(actor);
  if (role === null) return false;

  // Anything that touches an item requires being able to see it (confidential rule).
  if (resource.item && (action.startsWith('item.') || action.startsWith('comment.') || action === 'relation.edit' || action === 'activity.view')) {
    if (!canViewItem(actor, resource, role)) return false;
  }
  if (action === 'item.view') return true;

  if (action.endsWith('_own')) {
    if (role === 'admin') return true;
    if (resource.ownerId === undefined || resource.ownerId !== actor.id) return false;
  }
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

function assert(actor: Actor, action: Action, resource?: Resource): void {
  if (can(actor, action, resource)) return;
  const min = ACTION_MIN_ROLE[action];
  const project = resource?.project ?? resource?.item?.project;
  const role = project ? effectiveRole(actor, project) : firmLevelRole(actor);
  let why: string;
  if (!isActive(actor)) why = 'user is inactive';
  else if (actor.scopes !== undefined && !actor.scopes.includes('write') && !READ_ACTIONS.has(action)) why = 'API key lacks the write scope';
  else if (min === 'firm_admin') why = 'requires firm owner or admin';
  else if (min === 'any_user') why = 'guests cannot do this';
  else if (role === null) why = project ? 'no access to this project' : 'no access';
  else if (resource?.item?.confidential && action !== 'item.view' ? false : action === 'item.view' && resource?.item?.confidential) why = 'item is confidential';
  else if (action.endsWith('_own') && resource?.ownerId !== actor.id) why = 'not the owner';
  else why = `requires project role ${min} (you are ${role})`;
  throw new PermissionError(action, `permission denied: ${action} (${why})`);
}

export const permissions: PermissionEvaluator = { effectiveRole, can, assert };
