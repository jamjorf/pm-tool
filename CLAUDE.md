# pm-tool — notes for Claude Code sessions

Read `docs/ARCHITECTURE.md` first; it is the contract between packages.
The data model is `packages/db/migrations/0001_init.sql` (plain SQLite SQL, numbered migrations, no ORM). The runtime layer is `packages/db/src/sqlite.ts` (`openDb`, the `sql` tag, `begin`/`snapshot`, row hydration).

## Commands
- `pnpm install` then `pnpm --filter @pm/core build` (other packages import `@pm/core` from its `dist`).
- `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset -- --yes` (local only; deletes the file).
- `pnpm dev` runs API (:3001) and web (:5173). `pnpm dev:mcp` runs the MCP server on stdio.
- `pnpm -r test` / `pnpm -r typecheck` / `pnpm -r build`.
- Database: one SQLite file at `DATABASE_URL` (default `./data/pmtool.db`; `:memory:` for tests), opened through Node's built-in `node:sqlite` by `@pm/db`. Nothing to start, no containers, no native modules, no sudo. `sqlite3 data/pmtool.db` to inspect it by hand.

## Rules of the road
- Every write goes through `applyMutation` in `packages/api/src/mutations` (REST, sync push, MCP, integrations all converge there). Never write to synced tables elsewhere.
- One activity_events row per changed field, grouped by `txn_id`. The table is append-only; don't try to edit it.
- New item types, fields, workflows, states, transitions, views, relation types are DATA (inserts), not migrations.
- Rows are snake_case end-to-end (SQL → API JSON → client store). Don't camelCase.
- `QuerySpec` is the only query language; add a field to both `compileQuery` (SQL) and `evaluate.ts` (client) and extend the parity test.
- Keep `@pm/core` browser-safe (no `node:` imports, no DB driver in `dependencies`).
- Booleans are 0/1 and JSON is text in SQL; let the `@pm/db` runtime hydrate rows (JSON columns parsed, 0/1 → true/false by column name). Don't hand-parse in routes.
- Never hold a write transaction (`sql.begin`, BEGIN IMMEDIATE) across network I/O. SQLite has one writer: claim rows in a short transaction, do the HTTP/SMTP call outside it, record the result in another.
- Trigger-assigned columns (`number`, `key`, `version`) are null/0 in `RETURNING`; read the row back after insert.
