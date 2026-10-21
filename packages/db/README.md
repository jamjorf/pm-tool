# @pm/db

The data model for pm-tool: plain SQL migrations, a tiny migration runner and a
seed script. The schema is **standalone** — it can be used from any language or
tool with nothing but `psql`.

```
packages/db
├── migrations/        numbered .sql files, applied in filename order
│   └── 0001_init.sql  the whole core model (tables, triggers, graph helpers, permissions, default workflows/types)
├── src/migrate.ts     runner: pnpm --filter @pm/db migrate
├── src/seed.ts        demo data: pnpm --filter @pm/db seed [--force]
├── src/reset.ts       drop + migrate + seed: pnpm --filter @pm/db reset [--yes]
└── src/client.ts      postgres.js client + DATABASE_URL handling
```

All scripts read `DATABASE_URL` (default `postgres://postgres:postgres@127.0.0.1:5432/pmtool`).

## Applying the data model without the monorepo

The migration is self-contained Postgres 15+ SQL (it needs `pgcrypto` and `pg_trgm`,
both shipped with Postgres):

```bash
psql "$DATABASE_URL" -f migrations/0001_init.sql
```

That is all a standalone deployment needs. Later migrations are applied the same
way, in order. The runner below is a convenience, not a requirement — if you
later run it against a database that was set up with `psql`, it notices the
existing schema and records `0001_init.sql` as applied instead of re-running it.

## The runner

```bash
pnpm --filter @pm/db migrate          # or: pnpm db:migrate at the repo root
```

* Creates `schema_migrations(name text primary key, applied_at timestamptz)` if missing.
* Takes an advisory lock so concurrent runners (API boot, tests) serialize.
* Applies every `migrations/NNNN_name.sql` not yet recorded, in filename order,
  **each file inside one transaction**, then records it. A failing migration
  rolls back completely and nothing after it runs.
* Files are executed as one script (`sql.unsafe(text)`, simple query protocol),
  so `$$` function bodies, `do $$ ... $$` blocks and `set ...` statements are fine.
  Do not rely on splitting by `;`.
* Prints `applied / adopted / skipped` per file.

From code (the API tests use this to build a fresh schema):

```ts
import postgres from 'postgres';
import { runMigrations, seed, reset, MIGRATIONS_DIR } from '@pm/db';

const sql = postgres(process.env.DATABASE_URL!);
await runMigrations(sql);            // { applied, skipped, adopted }
await seed(sql);                     // optional demo data; null when users already exist
await reset(process.env.DATABASE_URL!); // drop + migrate + seed on its own connection
```

`reset()` takes a URL, not a client: dropping the schema invalidates the prepared
statements and type OIDs cached on any existing connection.

`MIGRATIONS_DIR` is the absolute path of the `migrations/` folder (works from
`src/` under `tsx` and from the compiled `dist/`).

## Adding a migration

1. Create `migrations/0002_short_description.sql` (four-digit prefix, snake_case name).
   The runner only picks up files matching `^\d+_[\w-]+\.sql$`.
2. Write plain, transactional DDL/DML. Everything in the file runs in one
   transaction, so avoid statements that cannot run inside one
   (`create index concurrently`, `alter type ... add value` on Postgres < 12).
3. New synced tables need: `version bigint not null default 0`, `created_at`,
   `updated_at`, `deleted_at`, and `select install_sync_trigger('<table>');` so
   `version` is bumped on every write (see how `0001_init.sql` does it), plus
   an entry in `SYNCED_TABLES` in `@pm/core`.
4. Never edit a migration that has shipped; add a new one.
5. Run `pnpm --filter @pm/db migrate` (idempotent) and `pnpm --filter @pm/db test`.

## Seed data

```bash
pnpm --filter @pm/db seed            # no-op if any user exists
pnpm --filter @pm/db seed --force    # wipe data tables (incl. the activity log) and reseed
pnpm --filter @pm/db reset --yes     # drop schema public, migrate, seed (local hosts need no --yes)
```

The seed takes the sync advisory lock (`pg_advisory_xact_lock(42)`) and runs in
one transaction. It creates a small finance-firm dataset:

| Email | Name | Firm role | Notes |
|---|---|---|---|
| alice@firm.com | Alice Chen | owner | owns the personal "My work" view and the shared cross-project views |
| bob@firm.com | Bob Okafor | admin | |
| carol@firm.com | Carol Nakamura | member | lead of RATES |
| dan@firm.com | Dan Whitfield | member | lead of EQD |
| eve@firm.com | Eve Lindqvist | member | viewer on ONB |
| frank@firm.com | Frank Moreau | member | lead of OPS |
| grace@firm.com | Grace Patel | member | lead of ONB (admin) |
| hugo@firm.com | Hugo Schmidt | member | editor on ONB |
| agent@firm.com | PM Agent | member | `is_service = true` (for API keys / MCP) |

Dev login (`AUTH_MODE=dev`) accepts any of these emails; there are no passwords.

Projects: `RATES` Rates Desk Platform, `EQD` Equity Derivs Tooling, `OPS` Operations
Backlog (all `firm` visibility) and `ONB` Client Onboarding (`private`; members
grace/hugo/eve — firm owner/admin see it too). Teams `RATES`, `EQD`, `OPS`.

Contents: 60 work items across `task` / `bug` / `initiative` / `request` with
realistic states, priorities, assignees, due dates (some overdue, some next
week), estimates and typed `fields`; 6 initiatives with children (`parent_of`),
several `blocks` edges, one `duplicates`, two `links_to` GitHub PRs; labels
(firm-wide `regulatory`, `tech-debt`, `quick-win` + per-project); comments with
one `@[Dan Whitfield](user:<uuid>)` mention and a reply; watchers; a plausible
activity log (`create` per item, state/title/assignee changes, comment events);
per-project default views (`All open` list, `Board`, `Roadmap` timeline,
`Overview` dashboard with four widgets) plus alice's cross-project views; `in_app`
+ `email` notification preferences for every user; one inactive webhook endpoint
(`https://example.com/hook`); inactive `slack` / `github` / `email` integration configs.

## Tests

`pnpm --filter @pm/db test` creates `pmtool_db_test` on the local server (if
reachable; otherwise the suite is skipped), runs the migrations twice, the seed
twice, exercises the "adopt an existing schema" path and a full reset.
