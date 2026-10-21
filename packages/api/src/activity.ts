import type { Actor, ActorKind } from '@pm/core';
import type { Tx, Row } from './db.js';

export interface MutationMeta {
  source: string;              // app | api | mcp | slack | email | github | system
  txnId: string;               // groups all events of one mutation (undo unit)
  mutationName: string;
  actorKind: ActorKind;
  actorLabel: string | null;   // api key name, integration name, agent name
  /** Admin routes: `?force=1` (e.g. drop a field key still in use). */
  force?: boolean;
}

export interface EventInput {
  entity_type: string;
  entity_id: string;
  item_id?: string | null;
  project_id?: string | null;
  action: string;
  field?: string | null;
  old_value?: unknown;
  new_value?: unknown;
}

export interface EventRow extends Row {
  id: number;
  txn_id: string;
  entity_type: string;
  entity_id: string;
  item_id: string | null;
  project_id: string | null;
  actor_kind: ActorKind;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  field: string | null;
  old_value: unknown;
  new_value: unknown;
  mutation_name: string | null;
  source: string;
  created_at: string;
}

/** old/new values are stored as JSON text (strings and numbers included) and come back parsed. */
const jsonOrNull = (tx: Tx, v: unknown) => (v === undefined || v === null ? null : tx.json(v));

/** Append activity rows (one per field change). Returns the inserted rows with ids (the feed/webhook cursor). */
export async function writeEvents(tx: Tx, actor: Actor | null, meta: MutationMeta, events: EventInput[]): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (const e of events) {
    // activity_events has no row-modifying triggers, so RETURNING is complete (id is the autoincrement cursor).
    const [row] = await tx`
      insert into activity_events (txn_id, entity_type, entity_id, item_id, project_id, actor_kind, actor_id, actor_label, action, field, old_value, new_value, mutation_name, source)
      values (${meta.txnId}, ${e.entity_type}, ${e.entity_id}, ${e.item_id ?? null}, ${e.project_id ?? null}, ${meta.actorKind}, ${actor?.id ?? null},
              ${meta.actorLabel}, ${e.action}, ${e.field ?? null}, ${jsonOrNull(tx, e.old_value)}, ${jsonOrNull(tx, e.new_value)}, ${meta.mutationName}, ${meta.source})
      returning *`;
    out.push(row as EventRow);
  }
  return out;
}
