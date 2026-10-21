# ADR-009: SQLite (via `node:sqlite`) instead of Postgres

**Status:** accepted · **Date:** 2026-10 · **Supersedes:** the database choice in ADR-008

## Context

The first version of the schema targeted Postgres 16: `plpgsql` triggers,
`jsonb`, `tsvector` + `pg_trgm`, an advisory lock for sync ordering, and a
compose file to run the server. Three facts about where the tool actually
runs changed the calculus:

* **No `sudo`, no containers.** The hosts the firm offers for internal tools
  give engineers a user account with Node and pnpm, nothing more. Running a
  database server (or a container runtime) is a ticket to another team and an
  on-call dependency that the tool's value does not justify.
* **Single region, single process by design** ([ADR-008](ADR-008-monolith-single-region.md)).
  One API process is the only writer. A client/server database adds a network
  hop, connection pooling, credentials and a second process to monitor, and
  buys concurrency the design does not use.
* **Firm-sized data.** Hundreds to low thousands of users, tens of writes per
  second at peak, a dataset of at most a few GB including the activity log.
  This fits in one file and in one host's page cache.

Node 22.13+ ships SQLite in the standard library (`node:sqlite`), so the
database needs no native module, no build step and no download.

## Decision

* The database is **one SQLite file** (default `./data/pmtool.db`, set by
  `DATABASE_URL`), opened by the API through the `@pm/db` runtime
  (`openDb()`), in WAL mode with `foreign_keys = ON`, `busy_timeout = 5000`
  and `synchronous = NORMAL`.
* The schema (`packages/db/migrations/0001_init.sql`) is rewritten for SQLite
  but keeps every pillar: UUID text ids with SQL defaults; ISO-8601 UTC text
  timestamps and `YYYY-MM-DD` dates; 0/1 booleans and CHECK-constraint enums;
  JSON as text validated with `json_valid`/`json_type`; per-project numbering,
  field validation, state validation, cycle prevention, symmetric-edge dedupe
  and the append-only log as **triggers**; graph helpers (`item_parents`,
  `item_ancestry`, `open_blockers`, `item_rollups`) and permissions
  (`effective_roles`, `visible_items`) as **views**; full-text search as an
  **FTS5** table kept in sync by triggers and ranked with `bm25`.
* Sync ordering uses SQLite's own writer serialisation: every write
  transaction is `BEGIN IMMEDIATE`, the global version is the one-row
  `sync_state` table stamped by per-table triggers, and the pull reads
  `sync_state.version` inside a deferred read transaction as its cookie. No
  advisory lock, no sequence.
* The `@pm/db` runtime exposes a tagged `sql` template (positional `?`
  params, `${sql(list)}` IN lists, fragments), `begin`/`snapshot`/`savepoint`,
  JSON and boolean hydration by column name, and `sqliteErrorKind` for mapping
  constraint and trigger errors to API error codes. Every package uses it;
  nothing else opens the file.
* Deployment is a Node process, a file and a user-level systemd unit. Backups
  are `sqlite3 pmtool.db ".backup …"` on a cron, or Litestream for continuous
  replication. CI needs no database service.

## Consequences

* (+) Zero infrastructure: `pnpm db:migrate && pnpm db:seed && pnpm dev`
  works on a fresh laptop and on the production host identically, without
  root, Docker, Podman or a DBA.
* (+) The test suites (parity, API, db) run against `:memory:` or a temp file;
  CI is faster and has no service container to keep healthy.
* (+) Backups are file copies made through SQLite (`.backup`, `VACUUM INTO`,
  Litestream); restore is "put the file back".
* (+) Transactions still span everything: an item change, its activity rows,
  its notifications and its webhook enqueue commit together.
* (−) **Single writer.** Writers are serialised by the file lock; a write
  transaction must stay short and must never span network I/O. The `@pm/db`
  mutex and `busy_timeout` make this safe inside one process; a second
  process on the same host works but is not the design.
* (−) **One host.** No read replicas, no multi-process fan-out, no
  multi-region. Horizontal scale means moving to Postgres (below).
* (−) **No roles inside the database.** Separation of duties (a credential
  that may insert into `activity_events` but not drop it) is done with file
  permissions and immutable backups, not with grants. Row-level security for
  analysts with direct SQL access is not available.
* (−) No `TRUNCATE`, no `RETURNING` of trigger-assigned values (`number`,
  `key`, `version` must be read back after insert), no `ALTER … CHECK` (enum
  changes are table rebuilds), no stored functions (graph helpers are views
  you filter rather than functions you call).
* (−) FTS5 has one stemmer and no typo tolerance; a `LIKE` fallback covers
  partial words. Beyond that the search moves to Meilisearch/Typesense as
  already planned.
* **Migration path back to Postgres** (when ADR-008's scaling path or the
  firm's separation-of-duties requirement demands it): the schema deliberately
  uses only portable constructs, so the translation is mechanical — `text`
  ids → `uuid`, text timestamps → `timestamptz`, JSON text → `jsonb`, 0/1 →
  `boolean`, CHECK enums stay or become types, triggers → `plpgsql`, the FTS5
  table → a `tsvector` column, `sync_state` → a sequence plus an advisory
  lock (or Replicache row versioning). The views (`effective_roles`,
  `visible_items`, graph helpers) are accepted by Postgres as written. Every
  query already goes through the `@pm/db` `sql` tag with positional
  placeholders and hydration by column name, so the driver swap is contained
  in one package and call sites keep their shape. The original Postgres
  migration is in the repository history.

## Alternatives considered

* **Postgres 16 (the original choice).** Strictly more capable: roles, RLS,
  replicas, concurrent writers, `LISTEN/NOTIFY`, richer full-text search.
  Rejected for now because it requires a server process the hosts cannot run
  without `sudo` or containers, and because none of those capabilities is
  used by a single-process, single-region deployment. Kept as the documented
  destination if the deployment grows.
* **`better-sqlite3`.** Mature and fast, but a native module: a compile step
  or a prebuilt binary per Node version and platform, which is exactly the
  install friction the move was meant to remove. `node:sqlite` is in the
  standard library and synchronous in the same way.
* **libSQL / Turso.** A SQLite fork with a hosted replication service and
  embedded replicas. Attractive for multi-host reads, but it reintroduces an
  external service and a vendor; if the tool needs more than one host, Postgres
  is the better-understood step.
* **PGlite (Postgres in WASM).** Keeps the Postgres dialect without a server,
  but is single-connection, slower, and young; the schema would still have to
  be rewritten for its limits.
