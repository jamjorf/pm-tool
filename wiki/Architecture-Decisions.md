# Architecture Decisions

Eight decision records, one page each, in [docs/adr/](https://github.com/jamjorf/pm-tool/blob/main/docs/adr). All are accepted (2026-10). The table gives the decision and the reason; the sections below add the cost each one accepts and the alternatives it rejected.

| ADR | Decision | Why | Record |
|---|---|---|---|
| 001 | One generic work item (`work_items` + typed `fields` JSONB validated against `item_types.field_defs`), not a table per type | Views over mixed types, cross-type relations, one activity log, one sync protocol and one search index all want one entity; desks add types without engineering | [ADR-001](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-001-generic-work-item.md) |
| 002 | Workflows are data: states, transitions, guards and effects are rows, evaluated by one pure engine on client and server | A regulated firm must show a step was enforced, by whom, under which conditions; rules as rows are visible to compliance and need no deploy | [ADR-002](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-002-workflows-as-data.md) |
| 003 | One typed relation edge table with a `relation_types` registry, external entities in the same table, invariants in the database, graph queries as SQL functions | "Everything connected to RATES-12" is one query; new relation kinds are rows with cycle protection for free; rollups are live queries | [ADR-003](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-003-typed-edge-table.md) |
| 004 | Append-only activity log, one event per field change, written only by `applyMutation` | Who changed what, when, through which channel, provably unaltered; one source for history, audit, notifications, webhooks, undo and analytics | [ADR-004](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-004-append-only-activity-log.md) |
| 005 | Permissions are per-project roles with three modifiers (firm role, project visibility, confidential flag); attribute rules live in workflow guards | Explainable after the fact, a cheap set-based predicate for sync pull scoping, mirrors desks and functions | [ADR-005](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-005-permissions-per-project-roles.md) |
| 006 | Views are saved queries over one closed `QuerySpec` grammar with two executors and a parity suite | One filter builder, one permission path, one semantics; views are rows usable by the API and agents; no network wait to render | [ADR-006](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-006-views-as-saved-queries.md) |
| 007 | Replicache-style push/pull with a global version cookie, tombstones, a resync flag and an advisory lock on every write | Custom write semantics belong in one server function; three routes and two tables, no sidecar; offline works | [ADR-007](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-007-sync-global-version.md) |
| 008 | One process, one Postgres, one region, no microservices | One firm, tens of writes per second; every extra component is an on-call surface and an audit boundary; transactions span everything | [ADR-008](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-008-monolith-single-region.md) |

## ADR-001: One generic work item

- **Costs accepted:** JSONB fields are not foreign keys (user existence is checked in application code); aggregations over JSONB numbers need casts, and heavy analytical use of a field is the signal to promote it to a column; removing a field requires clearing values first because the trigger rejects unknown keys.
- **Rejected:** a table per type (every cross-cutting feature multiplies), a wide table with nullable columns (schema change per field, no per-type validation), EAV (slow to query, painful to sync and diff), a document store (loses transactional invariants).
- **In this wiki:** [[Data Model]], [[Workflows and Item Types]].

## ADR-002: Workflows are data

- **Costs accepted:** the guard and effect vocabulary is closed, so a new kind of rule is a `@pm/core` change (no migration); cascading effects (`transition_parent_if`, `transition_children`) must stay bounded; admin tooling must validate definitions (`validateDefinition`).
- **Rejected:** a status enum plus code (opaque to audit, impossible to delegate to desks), scripting in rows such as JS or CEL (unreviewable code with database access, no client/server parity), an external workflow engine (another service and audit boundary for 3 to 6 state approval chains).
- **In this wiki:** [[Workflows and Item Types]].

## ADR-003: One typed relation edge table

- **Costs accepted:** recursive CTEs cost O(subtree) per call, fine for trees of hundreds; single parent is a hard rule, so "an item in two initiatives" is `relates_to`; direction matters and the UI renders inverse labels from `relation_types.inverse_name`.
- **Rejected:** a `parent_id` column plus a separate `blockers` table (every new kind needs another table and sync path), a graph database (a second datastore for a few thousand edges), a closure table (maintenance cost that recursive CTEs make unnecessary here).
- **In this wiki:** [[Data Model]].

## ADR-004: Append-only activity log

- **Costs accepted:** volume (a bulk edit of 500 items times 3 fields is 1,500 rows; plan monthly partitioning past about 50 GB); nothing outside `applyMutation` may write business tables or the log is incomplete; reconstructing an item at time T is a query, not a lookup.
- **Rejected:** trigger-based shadow tables (cannot know actor, source or mutation), event sourcing (every query becomes a projection), change data capture to a log store (the audit record leaves the transaction), mutable history with "edited" flags.
- **In this wiki:** [[Data Model]], [[Operations]].

## ADR-005: Permissions are per-project roles

- **Costs accepted:** granularity stops at project plus the confidential flag, so field-level secrecy means a private project or a confidential item; visibility changes require a full client resync; a genuinely attribute-driven visibility rule means changing `can_view_item()`.
- **Rejected:** ABAC policy engines (hard to audit retrospectively, expensive to apply to sync diffs), per-item ACLs (unexplainable at scale), firm-wide flat access (compliance and external parties need scoping from day one), Postgres RLS as the primary mechanism (kept as an extension path).
- **In this wiki:** [[Data Model]], [[Sync]].

## ADR-006: Views are saved queries

- **Costs accepted:** the grammar is deliberately closed (no joins beyond the dotted lookups, no arbitrary expressions); parity between the SQL compiler and the local evaluator is a maintenance obligation with a fixture per op; client-side aggregation is bounded by what is synced, so large dashboards fall back to the server.
- **Rejected:** per-screen hand-written queries (divergent forever), GraphQL or exposed SQL fragments (not locally evaluable, harder to scope and audit), server-rendered views only (loses instant navigation and offline).
- **In this wiki:** [[Views and Queries]].

## ADR-007: Global-version sync

- **Costs accepted:** writers are serialised by `pg_advisory_xact_lock(42)`, acceptable at tens of writes per second with push p95 above about 500 ms as the signal to move on; full snapshots on visibility changes; the in-memory poke emitter is single-process. The migration path is Replicache's row-versioning strategy with no client change.
- **Rejected:** ElectricSQL or PowerSync (writes still need a custom path and permission rules would duplicate `can_view_item()`), Zero (query-driven partial sync is unnecessary when the visible set fits locally), polling plus a client cache (no optimistic writes or offline), custom WebSockets (no library-backed ordering and idempotency).
- **In this wiki:** [[Sync]].

## ADR-008: Monolith, single region

- **Costs accepted:** vertical scaling until the documented path is taken (read replica, second process with `LISTEN/NOTIFY` poke, row-versioned sync, external search); slow webhook receivers or SMTP must not block the event loop, so the loops are bounded and asynchronous; a regional outage is an outage, mitigated by PITR backups and a restore drill.
- **Rejected:** microservices (four more deployables, inter-service auth, eventual consistency between the audit log and its consumers), serverless plus managed queues (cold starts hurt sync, SSE is awkward, transactional guarantees are lost), multi-region active-active (conflicts with the global version and offers nothing to a single-city firm).
- **In this wiki:** [[Operations]], [[Development]].

## How they fit together

- 001 and 003 define the shape of the data: one entity, one edge table.
- 002 and 005 define who may change what: rules as rows on transitions, roles per project for visibility.
- 004 is the audit backbone the others feed; 007 keeps the client an optimistic mirror of it.
- 006 makes every screen a query over the same rows that 007 syncs.
- 008 keeps all of the above inside one transaction boundary.

## Reading order

[docs/README.md](https://github.com/jamjorf/pm-tool/blob/main/docs/README.md) suggests two paths through the records:

- **For a CTO or architect:** [docs/01-data-model.md](https://github.com/jamjorf/pm-tool/blob/main/docs/01-data-model.md) first, then the eight ADRs in order, then [docs/02-design.md](https://github.com/jamjorf/pm-tool/blob/main/docs/02-design.md) and [docs/05-operations.md](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md).
- **For an engineer joining:** [docs/ARCHITECTURE.md](https://github.com/jamjorf/pm-tool/blob/main/docs/ARCHITECTURE.md), then 01, 02, 03 and 04, with the ADRs as the "why" behind each contract section.
- **For an agent asked to rebuild it:** [docs/BUILD-PROMPT.md](https://github.com/jamjorf/pm-tool/blob/main/docs/BUILD-PROMPT.md) only.

## Adding a decision

Copy the structure of an existing record (Status, Context, Decision, Consequences with plus and minus bullets, Alternatives considered) into `docs/adr/ADR-00N-short-title.md`, link it from [docs/README.md](https://github.com/jamjorf/pm-tool/blob/main/docs/README.md), and add a row to this page.
