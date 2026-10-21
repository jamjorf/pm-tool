# pm-tool — notes for Claude Code sessions

Read `docs/ARCHITECTURE.md` first; it is the contract between packages.
The data model is `packages/db/migrations/0001_init.sql` (plain SQL, numbered migrations, no ORM).

## Commands
- `pnpm install` then `pnpm --filter @pm/core build` (other packages import `@pm/core` from its `dist`).
- `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset -- --yes` (local only).
- `pnpm dev` runs API (:3001) and web (:5173). `pnpm dev:mcp` runs the MCP server on stdio.
- `pnpm -r test` / `pnpm -r typecheck` / `pnpm -r build`.
- Local Postgres: `podman compose up -d postgres` (compose.yml) or any Postgres 15+ at `DATABASE_URL`. Containers are Podman, not Docker.

## Rules of the road
- Every write goes through `applyMutation` in `packages/api/src/mutations` (REST, sync push, MCP, integrations all converge there). Never write to synced tables elsewhere.
- One activity_events row per changed field, grouped by `txn_id`. The table is append-only; don't try to edit it.
- New item types, fields, workflows, states, transitions, views, relation types are DATA (inserts), not migrations.
- Rows are snake_case end-to-end (SQL → API JSON → client store). Don't camelCase.
- `QuerySpec` is the only query language; add a field to both `compileQuery` (SQL) and `evaluate.ts` (client) and extend the parity test.
- Keep `@pm/core` browser-safe (no `node:` imports, no DB driver in `dependencies`).
