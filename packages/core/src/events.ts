// ============================================================================
// Activity / event helpers shared by the API (writer), webhooks and integrations.
// ============================================================================
import type { WorkItem, ActivityEvent } from './schema/entities.js';

/** Webhook / notification event kinds derived from activity events. */
export const EVENT_KINDS = [
  'item.created', 'item.updated', 'item.transitioned', 'item.completed', 'item.deleted', 'item.restored',
  'comment.created', 'comment.updated', 'comment.deleted',
  'relation.added', 'relation.removed',
  'project.created', 'project.updated',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Fields of work_items that are tracked one-event-per-field in the activity log (JSONB fields are tracked per key as "fields.<key>"). */
export const TRACKED_ITEM_FIELDS: (keyof WorkItem)[] = [
  'title', 'description', 'type_id', 'state_id', 'priority', 'assignee_id', 'reporter_id', 'start_date', 'due_date',
  'estimate', 'confidential', 'archived_at', 'project_id', 'sort_order',
];

export type FieldChange = { field: string; old: unknown; new: unknown };

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Deep equality after normalization (undefined ≡ null, Date ≡ ISO string, numeric strings ≡ numbers). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  a = normalize(a); b = normalize(b);
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'string') return b.trim() !== '' && a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return a.trim() !== '' && Number(a) === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined).sort();
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && valuesEqual(ao[k], bo[k]));
}

/** Diff two item snapshots into one change per field (JSONB fields expanded to "fields.<key>"). */
export function diffItem(before: Partial<WorkItem>, after: Partial<WorkItem>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const f of TRACKED_ITEM_FIELDS) {
    const b = (before as Record<string, unknown>)[f];
    const a = (after as Record<string, unknown>)[f];
    if (a === undefined) continue; // absent in the patch → unchanged
    if (!valuesEqual(b, a)) changes.push({ field: f, old: normalize(b), new: normalize(a) });
  }
  if (after.fields !== undefined) {
    const bf = before.fields ?? {};
    const af = after.fields ?? {};
    const keys = new Set([...Object.keys(bf), ...Object.keys(af)]);
    for (const k of [...keys].sort()) {
      if (!valuesEqual(bf[k], af[k])) changes.push({ field: `fields.${k}`, old: normalize(bf[k]), new: normalize(af[k]) });
    }
  }
  return changes;
}

/** Map an activity event to the webhook event kind it represents (or null if internal). */
export function eventKindOf(e: Pick<ActivityEvent, 'entity_type' | 'action' | 'field'>): EventKind | null {
  const { entity_type, action, field } = e;
  switch (entity_type) {
    case 'work_item': case 'item':
      switch (action) {
        case 'create': return 'item.created';
        case 'update': return field === 'state_id' ? 'item.transitioned' : 'item.updated';
        case 'transition': return 'item.transitioned';
        case 'complete': return 'item.completed';
        case 'delete': return 'item.deleted';
        case 'restore': return 'item.restored';
        default: return null;
      }
    case 'comment':
      switch (action) {
        case 'create': case 'comment': return 'comment.created';
        case 'update': return 'comment.updated';
        case 'delete': return 'comment.deleted';
        default: return null;
      }
    case 'relation':
      switch (action) {
        case 'create': case 'relation_add': return 'relation.added';
        case 'delete': case 'relation_remove': return 'relation.removed';
        default: return null;
      }
    case 'project':
      switch (action) {
        case 'create': return 'project.created';
        case 'update': return 'project.updated';
        default: return null;
      }
    default: return null;
  }
}

const MENTION_RE = /@\[[^\]\n]*\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/** Extract @mentions of the form @[Name](user:<uuid>) from markdown. Unique, in order of appearance. */
export function extractMentions(markdown: string): string[] {
  const out: string[] = [];
  for (const m of (markdown ?? '').matchAll(MENTION_RE)) {
    const id = m[1]!.toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const ITEM_KEY_RE = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,9}-\d+)(?![A-Za-z0-9_])/g;

/** Extract item keys like RATES-12 from free text (used by Slack/GitHub/email autolinking). Unique, in order. */
export function extractItemKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(ITEM_KEY_RE)) {
    const k = m[1]!;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
