# ADR-004: Append-only activity log, one event per field change

**Status:** accepted · **Date:** 2026-10

## Context

A regulated firm must be able to show who changed what, when, through which
channel, and must be able to prove the record was not altered afterwards.
The same information drives item history, notifications, webhooks, undo and
analytics. Building each of those on separate mechanisms (ORM hooks,
triggers, a message bus) produces five inconsistent accounts of the same
change.

## Decision

`activity_events`: `id bigint identity` (monotonic cursor), `txn_id`
(one per mutation), `entity_type`/`entity_id`, denormalised `item_id` and
`project_id`, `actor_kind` (user / api_key / integration / system / agent),
`actor_id`, `actor_label`, `action`, `field`, `old_value jsonb`,
`new_value jsonb`, `mutation_name`, `source`, `created_at`.

**One row per changed field** (JSONB keys as `fields.<key>`), written by the
single server-side `applyMutation()` after diffing before/after. **Append-only
is enforced by triggers** that raise on UPDATE, DELETE and TRUNCATE. Every
other table uses soft deletes so the log never references vanished rows.

Derived consumers read the log rather than being told about changes:
notifications and webhooks reference `event_id`; feeds page on `id`; undo
replays `old_value` for a `txn_id` as a *new* mutation; analytics (cycle time,
throughput) are queries on `state_id` events.

## Consequences

* (+) One source of truth for history, audit, notifications, webhooks, undo
  and analytics; they cannot disagree.
* (+) Immutability is a database property, not an application promise;
  combined with role separation the application credential cannot alter
  history.
* (+) Field-level granularity makes diffs, collapsing ("3 fields changed"),
  and per-field subscriptions trivial.
* (+) `txn_id` makes bulk edits a single undo unit and a single webhook
  delivery per item.
* (−) Volume: a bulk edit of 500 items × 3 fields is 1,500 rows. At firm scale
  this is tens of millions of rows per year — fine for Postgres, but plan
  monthly partitioning past ~50 GB.
* (−) Nothing outside `applyMutation` may write business tables, or the log
  is incomplete. Direct SQL fixes must be done through the API or logged by
  hand.
* (−) Values are stored as typed JSON; reconstructing an item at time T is a
  query, not an index lookup.

## Alternatives considered

* **Trigger-based audit tables (one shadow table per table).** Cannot know the
  actor, source or mutation; produce row-level, not field-level, records.
* **Event sourcing (events are the source of truth, state is a projection).**
  Purer, but every query becomes a projection and every integration must
  understand events; the firm wants plain tables for SQL access.
* **Change data capture to a log store.** Another system; the audit record
  leaves the transactional boundary.
* **Mutable history with "edited" flags.** Unacceptable in a regulated shop.
