# Development

How the repository is laid out, what to run, and the conventions every change must respect. Read [docs/ARCHITECTURE.md](https://github.com/jamjorf/pm-tool/blob/main/docs/ARCHITECTURE.md) first; it is the contract between packages. [`CLAUDE.md`](https://github.com/jamjorf/pm-tool/blob/main/CLAUDE.md) carries the same rules for coding agents.

## Repository layout

```
docs/                  01-data-model · 02-design · 03-ux · 04-integrations · 05-operations · adr/ · BUILD-PROMPT
wiki/                  this wiki; synced to the GitHub Wiki by .github/workflows/wiki.yml
packages/db            migrations/*.sql, src/{sqlite,client,migrate,seed,reset}.ts   (sqlite.ts is the runtime layer)
packages/core          src/{schema,query,workflow,permissions}, fields.ts, events.ts, mutations.ts
packages/api           src/{auth,mutations,sync,notifications,webhooks,routes}, test/
packages/web           src/{sync,store,components,pages,lib}
packages/mcp           src/{server,createServer,tools,resources,prompts,client,format}.ts
packages/integrations  src/{slack,github,email}, render.ts, routes.ts, deps.ts
scripts/               dev.sh (one-command bring-up), build-prompt/gen.py (regenerates docs/BUILD-PROMPT.md)
```

| Package | npm name | Depends on | Runs in |
|---|---|---|---|
| `packages/core` | `@pm/core` | zod | browser, Node, MCP (pure, no I/O) |
| `packages/db` | `@pm/db` | `node:sqlite` (built into Node 22.13+) | Node (runtime layer, migrate / seed / reset) |
| `packages/integrations` | `@pm/integrations` | `@pm/core`, fastify types, nodemailer | inside `@pm/api` |
| `packages/api` | `@pm/api` | `@pm/core`, `@pm/db`, `@pm/integrations`, fastify | the server |
| `packages/web` | `@pm/web` | `@pm/core`, replicache, react | browser |
| `packages/mcp` | `@pm/mcp` | `@pm/core`, MCP SDK | agent host |

Conventions: ESM (`"type": "module"`), TypeScript `NodeNext`, imports inside a package use `.js` extensions, validation with zod 3, tests with vitest.

## Commands

```bash
pnpm install
pnpm --filter @pm/core build         # first, always: other packages import @pm/core from its dist
pnpm db:migrate                      # pnpm --filter @pm/db migrate; creates ./data/pmtool.db on first run
pnpm db:seed                         # no-op if any user exists; --force wipes and reseeds
pnpm db:reset -- --yes               # delete the local database file, migrate, seed
pnpm dev                             # API (:3001) and web (:5173) in parallel
pnpm dev:api | pnpm dev:web | pnpm dev:mcp
pnpm -r build | pnpm -r typecheck | pnpm -r test | pnpm -r lint
python3 scripts/build-prompt/gen.py  # regenerate docs/BUILD-PROMPT.md
```

Per package: `pnpm --filter @pm/<name> <build|typecheck|test|dev>`. The database is the SQLite file at `DATABASE_URL` (default `./data/pmtool.db`, relative to the repo root; `:memory:` also works); `pnpm db:migrate` creates it. There is nothing to start and nothing to install beyond Node and pnpm.

### The `@pm/db` runtime

`packages/db/src/sqlite.ts` is the one database layer every package uses: `openDb(path)` opens the file with `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL` and registers `now()`, `uuid()` and `today()` helpers; the tagged `sql` template binds positional `?` parameters (`${sql(list)}` expands to an IN list, `sql.raw()` splices identifiers, nested fragments carry their params); result rows are hydrated by column name (JSON columns parsed, 0/1 booleans to `true`/`false`; extend with `registerJsonColumns`/`registerBooleanColumns` for new aliases); `sql.begin()` runs `BEGIN IMMEDIATE` behind an async mutex (nested calls become savepoints), `sql.snapshot()` a deferred read transaction; `nextVersion()`/`currentVersion()` touch `sync_state`; `sqliteErrorKind(e)` classifies `unique` / `check` / `foreign_key` / `not_null` / `trigger` / `busy`. `resolveDbPath()` turns `DATABASE_URL` into an absolute path.

### Build order

`@pm/core` first, then everything else. `pnpm -r build` resolves the workspace graph, but `typecheck` and `test` do not build, so a fresh clone must run `pnpm --filter @pm/core build` before `pnpm -r typecheck` or `pnpm -r test`. `.npmrc` hoists `@types/react` and `@types/react-dom` to the root so third-party `.d.ts` files (react-router, cmdk, dnd-kit) resolve under pnpm's isolated layout; keep it.

## Test suites

| Package | Count | Files | What they cover |
|---|---|---|---|
| `@pm/core` | 155 | `query/compile.test.ts`, `query/evaluate.test.ts`, `query/parity.test.ts`, `workflow/engine.test.ts`, `permissions/evaluate.test.ts`, `fields.test.ts`, `events.test.ts` | SQL compilation, local evaluation, **78 SQL/local parity cases**, guard and effect evaluation, `validateDefinition`, the permission lattice, field validation per kind, activity diffs |
| `@pm/api` | 31 | `test/auth.test.ts`, `items.test.ts`, `permissions.test.ts`, `sync.test.ts`, `webhooks.test.ts` | dev login and API keys, item CRUD and transitions over HTTP, visibility and roles, push idempotency and pull snapshots, webhook enqueue and dispatch |
| `@pm/integrations` | 25 | `src/__tests__/{slack,github,email,verify,render,keys,routes}.test.ts` | Slack commands and events, GitHub payloads and key conventions, inbound email routing, signature verification, notification rendering, key extraction, route mounting |
| `@pm/web` | 14 | `src/test/{shortcuts,mutators,filter,palette}.test.ts` | the shortcut registry, optimistic mutators mirroring the server, filter builder round-trips, palette ranking and actions |
| `@pm/mcp` | 9 | `src/tools.test.ts`, `src/client.test.ts` | tool handlers against a stubbed API, the fetch wrapper and error mapping |
| `@pm/db` | 7 | `src/migrate.test.ts` | migrations applied twice, seed twice, adopting a schema created out of band with `sqlite3`, full reset |

### The parity test

`packages/core/src/query/parity.test.ts` loads one fixture set into an in-memory SQLite database (`openDb(':memory:')` plus `0001_init.sql`) **and** into plain objects, then asserts that `compileQuery` (executed as SQL) and `runSpec` return the same ids for every spec in the fixture: every op, null edge cases, macros, `fields.<key>` via `json_extract`, labels, `parent_id`, `is_blocked`. Nothing external is needed; `@pm/core` itself stays browser-safe because only the test imports `@pm/db`.

`@pm/db` and `@pm/api` tests open their own temporary databases (`:memory:` or a file under the OS temp directory) and apply the migration; nothing has to be running.

## Conventions (rules of the road)

- **Every write goes through `applyMutation`** in `packages/api/src/mutations`. REST, sync push, MCP and integrations all converge there. Never write to synced tables elsewhere, or the activity log is incomplete.
- **One `activity_events` row per changed field**, grouped by `txn_id`. The table is append-only; do not try to edit it.
- **New item types, fields, workflows, states, transitions, views and relation types are data** (inserts), not migrations.
- **Rows are snake_case end to end**: SQL → API JSON → client store. No camelCase translation layer; sync is a straight copy.
- **`QuerySpec` is the only query language.** To add a field or op, change `spec.ts`, implement it in both `compile.ts` (SQL) and `evaluate.ts` (client), and extend the parity fixture.
- **Keep `@pm/core` browser-safe**: no `node:` imports, no DB driver in `dependencies`.
- **Booleans are 0/1 and JSON is text in SQL.** Write them that way in queries and let the `@pm/db` runtime hydrate rows (it parses JSON columns and turns 0/1 into `true`/`false` by column name); never hand-parse in route code.
- **Never hold a write transaction across network I/O.** SQLite has one writer; `sql.begin()` holds the lock until commit. Claim work in one short transaction, do the HTTP/SMTP call outside it, record the result in another.
- **Ids are client-generated UUIDs** (`crypto.randomUUID()`) so optimistic UI is stable; keys like `RATES-12` are assigned by the database.
- **State changes only through `transitionItem`**; `ItemPatch` has no `state_id`.
- **Source of truth order when documents disagree**: the SQL migration and the core contract files (`schema/entities.ts`, `query/spec.ts`, `mutations.ts`, `workflow/types.ts`, `permissions/types.ts`, `integrations/src/deps.ts`), then `ARCHITECTURE.md`, then the numbered docs.

## CI

[`.github/workflows/ci.yml`](https://github.com/jamjorf/pm-tool/blob/main/.github/workflows/ci.yml) runs on pushes to `main` and on pull requests: Node 22 with pnpm from `packageManager`, `pnpm install --frozen-lockfile`, `pnpm --filter @pm/core build`, `pnpm -r --filter './packages/*' build`, `pnpm db:migrate`, `pnpm db:seed`, then `pnpm -r --filter './packages/*' test`. There is no database service; `DATABASE_URL=./data/pmtool.db` and `APP_SECRET` are set as job env and the tests use in-memory or temporary files.

[`.github/workflows/wiki.yml`](https://github.com/jamjorf/pm-tool/blob/main/.github/workflows/wiki.yml) publishes the `wiki/` directory to the repository's GitHub Wiki on every push to `main` that touches it. The wiki must be enabled and have one page created in the web UI before the first sync can push.

## Adding a migration

1. Create `packages/db/migrations/0002_short_description.sql` (four-digit prefix, snake_case; the runner matches `^\d+_[\w-]+\.sql$`).
2. Write plain, transactional DDL/DML for SQLite. The whole file runs in one `BEGIN IMMEDIATE` transaction via `tx.exec()`; SQLite DDL is transactional, so a failure rolls everything back. Remember what SQLite cannot do: no `alter table … alter column` or CHECK changes (rebuild the table: create new, copy, drop, rename, recreate indexes and triggers), `alter view` does not exist (`drop view` + `create view`), and `PRAGMA foreign_keys` is on.
3. New synced tables need `version integer not null default 0`, `created_at`, `updated_at`, `deleted_at` and the two triggers copied from an existing table (`<table>_version_ins` after insert; `<table>_version_upd` after update `when new.version = old.version`), plus an entry in `SYNCED_TABLES` in `@pm/core` and visibility rules in the sync pull. Booleans are `integer … check (x in (0,1))`, JSON is `text … check (json_valid(x))`; add new JSON/boolean column names to `JSON_COLUMNS`/`BOOLEAN_COLUMNS` in `sqlite.ts` if the `is_` prefix or the existing list does not cover them.
4. Never edit a migration that has shipped; add a new one.
5. Run `pnpm db:migrate` (idempotent) and `pnpm --filter @pm/db test`.
6. Regenerate the build prompt (below) because it embeds the SQL.

Remember the rule from [[Data Model]]: if it is a row, it is a product decision; DDL is an engineering decision that needs a migration file.

## Regenerating `docs/BUILD-PROMPT.md`

`docs/BUILD-PROMPT.md` is a self-contained prompt that rebuilds the system with a coding agent. It embeds repository files verbatim from `scripts/build-prompt/template.md` using `<<<FILE:path>>>` tokens. After changing the SQL, the core contracts, `ARCHITECTURE.md` or any `package.json`:

```bash
python3 scripts/build-prompt/gen.py
# wrote docs/BUILD-PROMPT.md (N lines) and lists each embedded file
```

The script fails if a referenced file is missing and asserts no tokens are left over.

## Adding a guard or effect type

The vocabulary is a closed zod discriminated union in `packages/core/src/schema/entities.ts`, evaluated in `packages/core/src/workflow/engine.ts`. Adding a kind means: extend `Guard` or `Effect`, implement it in the engine (guards return `{guard, reason}` failures; effects either patch fields or become deferred effects the server executes), add engine tests, handle deferred effects in `packages/api/src/mutations`, and give the admin workflow editor (`packages/web/src/pages/admin`) a form for the new literal's arguments. No migration is needed; the JSON is opaque to SQL.
