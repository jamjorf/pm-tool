# @pm/db

The data model for pm-tool: plain SQL migrations, a tiny migration runner, a
seed script and the runtime layer every other package uses to talk to the
database. The database is a **single SQLite file** opened with Node's built-in
`node:sqlite` (Node 22.13+): no server, no native modules, no `sudo`. The
schema is **standalone** — it can be used from any language or tool that speaks
SQLite 3.38+ (3.45+ recommended).

```
packages/db
├── migrations/        numbered .sql files, applied in filename order
│   └── 0001_init.sql  the whole core model (tables, triggers, FTS, graph views, permissions, default workflows/types)
├── src/sqlite.ts      runtime layer: openDb(), the sql`` tag, transactions, row hydration
├── src/client.ts      DATABASE_URL handling (connect, databasePath) + CLI helpers
├── src/migrate.ts     runner: pnpm --filter @pm/db migrate
├── src/seed.ts        demo data: pnpm --filter @pm/db seed [--force]
├── src/reset.ts       delete file + migrate + seed: pnpm --filter @pm/db reset
└── src/db.test.ts     vitest suite (in-memory + temp file)
```

## Where the database lives

Every script and package reads `DATABASE_URL`:

| `DATABASE_URL` | Meaning |
|---|---|
| unset | `./data/pmtool.db` **relative to the repo root** (the nearest ancestor with `pnpm-workspace.yaml`, or `PM_ROOT` when set) |
| `./some/path.db`, `/abs/path.db` | that file (parent directories are created) |
| `sqlite:path`, `sqlite:///abs/path`, `file:path` | same, prefix stripped |
| `:memory:` | a private in-memory database — what the tests use |

A repo-root `.env` is loaded automatically (existing environment variables win).
`data/`, `*.db`, `*.db-wal` and `*.db-shm` are git-ignored. Under WAL mode the
database is three files while a connection is open: `pmtool.db`,
`pmtool.db-wal` and `pmtool.db-shm`; the last connection to close folds the WAL
back into the main file.

### Pragmas the runtime sets on every connection

```
PRAGMA journal_mode = WAL;    -- readers never block the writer (file databases only)
PRAGMA foreign_keys = ON;     -- off by default in SQLite; the schema relies on it
PRAGMA busy_timeout = 5000;   -- wait up to 5 s for a lock instead of failing at once
PRAGMA synchronous = NORMAL;  -- safe with WAL, far fewer fsyncs
```

If you open the file with another tool, set at least `foreign_keys = ON`.

## Applying the data model without the monorepo

The migration is self-contained SQL — no extensions, no application code:

```bash
sqlite3 pmtool.db < migrations/0001_init.sql
```

Later migrations are applied the same way, in order. The runner below is a
convenience, not a requirement — if you later run it against a database that
was set up this way, it notices the existing schema (the `work_items` table)
and records `0001_init.sql` as applied instead of re-running it.

## The runner

```bash
pnpm --filter @pm/db migrate          # or: pnpm db:migrate at the repo root
```

* Creates `schema_migrations(name text primary key, applied_at text)` if missing.
* Opens one `BEGIN IMMEDIATE` transaction, so concurrent runners (API boot,
  tests) serialise on SQLite's writer lock.
* Applies every `migrations/NNNN_name.sql` not yet recorded, in filename order,
  as one multi-statement script (`sql.exec`), then records it. A failing
  migration rolls everything back.
* Prints `applied / adopted / skipped` per file.

From code (the API tests use this to build a fresh schema):

```ts
import { openDb, runMigrations, seed, reset, MIGRATIONS_DIR } from '@pm/db';

const sql = openDb(':memory:');            // or openDb() for DATABASE_URL
await runMigrations(sql);                  // { applied, skipped, adopted }
await seed(sql);                           // demo data; null when users already exist
await reset('./data/pmtool.db');           // delete the file, migrate, seed (own connection)
```

`MIGRATIONS_DIR` is the absolute path of the `migrations/` folder (works from
`src/` under `tsx` and from the compiled `dist/`).

## The runtime layer (`@pm/db`, `src/sqlite.ts`)

```ts
import { openDb, type Sql } from '@pm/db';
const sql: Sql = openDb();                                   // DATABASE_URL → file; pragmas set
const rows = await sql`select * from work_items where project_id = ${pid}`;   // parameterised, hydrated rows
const one  = sql`select * from users where id = ${id}`.get();                 // sync: .all() / .get() / .run()
await sql`update work_items set title = ${t} where id in ${sql(ids)}`;        // ${sql(array)} → (?, ?, ?)
await sql`insert into views (id, spec, is_shared) values (${id}, ${spec}, ${true})`; // objects → JSON text, booleans → 0/1
await sql`insert into activity_events (..., new_value) values (..., ${sql.json('First task')})`; // scalar JSON: sql.json()
await sql.begin(async (tx) => { await tx`...`; await tx`...`; });              // BEGIN IMMEDIATE; nested begin → SAVEPOINT
const v = sql.nextVersion();                                                  // bump + read the global sync version
sql.exec(ddl);                                                                // multi-statement scripts (migrations)
```

* `sql` is a tagged template; values are always bound, never concatenated.
  `sql.raw(text)` splices verbatim SQL (identifiers), `sql.unsafe(text, params)`
  runs raw parameterised text.
* Rows come back snake_case and **hydrated**: JSON columns (`fields`, `spec`,
  `settings`, `old_value`, `external_ref`, ...) are parsed, `is_*` and the
  listed boolean columns (`confidential`, `muted`, ...) become `true`/`false`.
  Use `registerJsonColumns()` / `registerBooleanColumns()` for your own aliases,
  or alias as `... as foo_json`.
* `node:sqlite` is synchronous; one shared connection and an async mutex
  serialise transactions. Statements issued inside `sql.begin` (from the same
  async context) run inside that transaction, so passing `sql` or `tx` around
  both work. `sql.snapshot()` opens a deferred read transaction.
* `sqliteErrorKind(e)` classifies errors: `unique | check | foreign_key |
  not_null | trigger | busy | other`.

### The RETURNING caveat

`insert ... returning *` on `work_items` returns the row **before** the
AFTER INSERT triggers run, so `number`, `key` and `version` are still null/0 in
what comes back. Either insert `number`/`key` explicitly (the seed does) or
re-select the row after the insert. The same holds for `version` on every
synced table: it is stamped by a trigger after the statement.

## Adding a migration

1. Create `migrations/0002_short_description.sql` (four-digit prefix, snake_case
   name). The runner only picks up files matching `^\d+_[\w-]+\.sql$`.
2. Write plain SQLite DDL/DML. The whole file runs inside one transaction;
   `PRAGMA` statements are ignored inside a transaction, so set none that matter.
   SQLite's `ALTER TABLE` is limited (add column, rename, drop column): to change
   a constraint, create the new table, copy, drop, rename — see
   <https://sqlite.org/lang_altertable.html#otheralter>.
3. New synced tables need `version integer not null default 0`, `created_at`,
   `updated_at`, `deleted_at`, and a pair of `<table>_version_ins` /
   `<table>_version_upd` triggers copied from `0001_init.sql` §14 so `version`
   is stamped from `sync_state` on every write, plus an entry in `SYNCED_TABLES`
   in `@pm/core`.
4. Booleans are `integer ... check (x in (0,1))`, enums are text with a
   `check (x in (...))`, JSON is text with `json_valid()`, timestamps are ISO
   text (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), dates are `YYYY-MM-DD`.
5. Never edit a migration that has shipped; add a new one.
6. Run `pnpm --filter @pm/db migrate` (idempotent) and `pnpm --filter @pm/db test`.

## Backups

The database is one file, so a backup is a copy — but **not** a plain `cp`
while something is writing (the WAL may hold committed pages the main file
lacks yet). Use one of:

```bash
sqlite3 data/pmtool.db ".backup backups/pmtool-$(date +%F).db"   # online, consistent
node -e 'new (require("node:sqlite").DatabaseSync)("data/pmtool.db").exec("vacuum into \x27backups/pmtool.db\x27")'
cp data/pmtool.db backups/                                       # only while no connection is open (no -wal file present)
```

Restore by stopping the API and replacing the file (delete any stale `-wal` /
`-shm` next to it). The activity log is the audit source: keep backups at least
as long as your retention policy requires.

## Seed data

```bash
pnpm --filter @pm/db seed            # no-op if any user exists
pnpm --filter @pm/db seed --force    # wipe data tables (incl. the activity log) and reseed
pnpm --filter @pm/db reset           # delete the file, migrate, seed (always local, no --yes needed)
```

The seed runs in one `BEGIN IMMEDIATE` transaction. `--force` deletes every
data table child-first (reference data — workflows, states, transitions, item
types, relation types, settings — stays) and, because `activity_events` is
append-only, drops its two guard triggers for the delete and recreates them
verbatim. Development only. It creates a small finance-firm dataset:

| Email | Name | Firm role | Notes |
|---|---|---|---|
| alice@firm.com | Alice Chen | owner | owns the personal "My work" view and the shared cross-project views |
| bob@firm.com | Bob Okafor | admin | |
| carol@firm.com | Carol Nakamura | member | lead of RATES |
| dan@firm.com | Dan Whitfield | member | lead of EQD; the one `@mention` |
| eve@firm.com | Eve Lindqvist | member | viewer on ONB |
| frank@firm.com | Frank Moreau | member | lead of OPS |
| grace@firm.com | Grace Patel | member | lead of ONB (admin) |
| hugo@firm.com | Hugo Schmidt | member | editor on ONB |
| agent@firm.com | PM Agent | member | `is_service = 1` (for API keys / MCP) |

Dev login (`AUTH_MODE=dev`) accepts any of these emails; there are no passwords.

Projects: `RATES` Rates Desk Platform, `EQD` Equity Derivs Tooling, `OPS` Operations
Backlog (all `firm` visibility) and `ONB` Client Onboarding (`private`; members
grace/hugo/eve — firm owner/admin see it too). Teams `RATES`, `EQD`, `OPS`.

Contents: 60 work items across `task` / `bug` / `initiative` / `request` with
realistic states, priorities, assignees, due dates (some overdue, some next
week), estimates and typed `fields`; keys are contiguous per project
(`RATES-1` … `RATES-19`) and `projects.item_seq` is set so app-created items
continue the sequence; 6 initiatives with 24 children (`parent_of`), four
`blocks` edges, one `duplicates`, two `links_to` GitHub PRs; 9 labels
(firm-wide `regulatory`, `tech-debt`, `quick-win` + per-project); 12 comments
with one `@[Dan Whitfield](user:<uuid>)` mention and a reply; watchers; a
plausible back-dated activity log (`create` per item, state/title/assignee
changes grouped by `txn_id`, comment events; ~155 rows); per-project default
views (`All open` list, `Board`, `Roadmap` timeline, `Overview` dashboard with
four widgets) plus alice's three cross-project views (19 in all); `in_app` +
`email` notification preferences for every user; one inactive webhook endpoint
(`https://example.com/hook`); inactive `slack` / `github` / `email` integration
configs.

## Tests

`pnpm --filter @pm/db test` needs nothing but Node: it opens `:memory:`
databases for the migration/seed suite (migrate twice, adopt an out-of-band
schema, seed twice, `--force`, numbering, permissions, graph rollups, FTS,
versions) and a temp file under `os.tmpdir()` for `reset`.
