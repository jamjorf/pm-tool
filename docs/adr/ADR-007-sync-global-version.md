# ADR-007: Sync is Replicache-style push/pull with a global version cookie

**Status:** accepted · **Date:** 2026-10

## Context

The UX requirement is instant navigation on local data with optimistic
writes, which implies a local store in the browser and a sync protocol. The
server must remain the authority for every write (guards, effects, activity
rows, notifications, webhooks). Candidate approaches: Replicache (client
library with a documented push/pull protocol the server implements),
ElectricSQL / PowerSync (replication of a Postgres server to the client), Zero
(query-driven sync service), or hand-rolled polling.

## Decision

Replicache (`replicache` v15) on the client; the server implements the
protocol in `@pm/api`:

* `POST /sync/push`: per mutation, in one transaction, replay through the
  same `applyMutation()` the REST API uses; idempotent on mutation id, strict
  ordering, errors logged and surfaced as a `mutation_rejected` notification
  while the mutation is still marked applied.
* `POST /sync/pull`: **global version strategy**. Every synced table has a
  `version` column stamped by trigger from the one-row `sync_state` table
  (`update sync_state set version = version + 1`, then stamp the row); the
  pull runs in a deferred read transaction (a consistent WAL snapshot) and
  returns `sync_state.version` read in that snapshot as the cookie; it returns
  rows with `version > cookie` as `put` (visible, not deleted) or `del`.
  `deleted_at` tombstones make deletes syncable; visibility changes that can
  hide unchanged rows set `resync_required` and trigger a `clear` + full
  snapshot.
* `GET /sync/poke`: SSE from an in-process emitter.
* Every writing transaction is `BEGIN IMMEDIATE` (`sql.begin()` in `@pm/db`).
  SQLite's single write lock serialises writers for the life of the
  transaction, so version order equals commit order by construction (otherwise
  a client could skip a row whose lower version committed later). No advisory
  lock and no sequence are needed; an in-process async mutex queues waiting
  transactions instead of letting them spin on `SQLITE_BUSY`.

The client's mutators are generated from the same `MutationArgs` and mirror
the server's logic (including running the workflow engine) for optimistic
updates.

## Consequences

* (+) One write path for everything (web, REST, MCP, integrations); the
  optimistic client cannot drift from the server's vocabulary.
* (+) No extra infrastructure: the protocol is three HTTP routes and two
  bookkeeping tables.
* (+) Offline works; per-client ordering is guaranteed by the protocol.
* (+) Visibility is computed with the same SQL views as every other read.
* (−) Writers are serialised (a property of SQLite as much as of the
  strategy). Acceptable at firm scale (tens of writes/s); the signal to move
  on is push p95 > ~500 ms.
* (−) Full snapshots on visibility changes; frequent membership churn means
  frequent resyncs.
* (−) The in-memory poke emitter is single-process; a second process means
  moving to Postgres (ADR-009) and `LISTEN/NOTIFY`.
* Migration path (no client change): Replicache's row-versioning strategy
  (per-client-group client view records) removes the global counter and makes
  visibility changes incremental; on Postgres it also removes the need to
  serialise writers.

## Alternatives considered

* **ElectricSQL / PowerSync.** Replicate a Postgres server to the client:
  strong reads, but writes still need a custom path, the shape/permission
  rules would duplicate `visible_items`, and both require a database server
  plus a sync service.
* **Zero.** Query-driven partial sync is attractive for very large datasets;
  at this size the whole visible set fits locally and a single cookie is
  simpler to reason about and audit.
* **Polling REST + client cache.** No optimistic writes without reinventing
  the mutation log; no offline.
* **WebSockets with custom protocol.** More code, no library-backed
  guarantees on ordering and idempotency.
