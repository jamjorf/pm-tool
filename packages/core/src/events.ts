// STUB — replaced by the core build-out. Signature is the contract.
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

/** Diff two item snapshots into one change per field (JSONB fields expanded to "fields.<key>"). */
export function diffItem(_before: Partial<WorkItem>, _after: Partial<WorkItem>): FieldChange[] { throw new Error('not implemented'); }

/** Map an activity event to the webhook event kind it represents (or null if internal). */
export function eventKindOf(_e: Pick<ActivityEvent, 'entity_type' | 'action' | 'field'>): EventKind | null { throw new Error('not implemented'); }

/** Extract @mentions of the form @[Name](user:<uuid>) from markdown. */
export function extractMentions(_markdown: string): string[] { throw new Error('not implemented'); }

/** Extract item keys like RATES-12 from free text (used by Slack/GitHub/email autolinking). */
export function extractItemKeys(_text: string): string[] { throw new Error('not implemented'); }
