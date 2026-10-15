import type { Actor } from '@pm/core';
import type { Tx } from '../db.js';
import { writeEvents, type EventInput, type EventRow, type MutationMeta } from '../activity.js';

export type NotificationKind = 'mention' | 'assigned' | 'reply' | 'state_change' | 'comment' | 'due_soon' | 'mutation_rejected';

export interface PendingNotification {
  user_id: string;
  item_id: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  event_id?: number | null;
  /** Bypass preference rules (explicit workflow `notify` effects, mutation_rejected). */
  explicit?: boolean;
  /** For state_change: is the recipient the item's assignee (rule state_change_assigned vs state_change_watching). */
  isAssignee?: boolean;
}

/** Everything one mutation accumulates inside its transaction; flushed by applyMutation. */
export class MutationCtx {
  readonly events: EventRow[] = [];
  readonly notifications: PendingNotification[] = [];
  readonly forcedWebhookKinds = new Map<string, Set<string>>();
  /** Users whose sync client groups must do a full resync; 'all' when a project's visibility changed. */
  resyncUsers: Set<string> | 'all' = new Set();
  resyncProjects = new Set<string>();
  depth = 0;

  constructor(public readonly tx: Tx, public readonly actor: Actor, public readonly meta: MutationMeta) {}

  async emit(events: EventInput[]): Promise<EventRow[]> {
    if (!events.length) return [];
    const rows = await writeEvents(this.tx, this.actor, this.meta, events);
    this.events.push(...rows);
    return rows;
  }

  notify(n: PendingNotification) {
    if (n.user_id === this.actor.id && n.kind !== 'mutation_rejected') return; // never notify the actor about their own action
    this.notifications.push(n);
  }

  forceWebhook(itemId: string, kind: string) {
    let s = this.forcedWebhookKinds.get(itemId);
    if (!s) this.forcedWebhookKinds.set(itemId, (s = new Set()));
    s.add(kind);
  }

  requireResyncForUser(userId: string) {
    if (this.resyncUsers !== 'all') this.resyncUsers.add(userId);
  }
  requireResyncForProject(projectId: string) {
    this.resyncProjects.add(projectId);
  }
  requireResyncForAll() {
    this.resyncUsers = 'all';
  }
}
