# pm-tool

A firm-wide project management tool built around five ideas:

1. **One generic work item** with a type and validated JSONB fields — no table per type.
2. **Workflows as data** — states, transitions, guards and effects live in rows, not enums.
3. **Relations as a typed graph** — parent/child, blocks, duplicates and links to external systems are one edge table; rollups and dependencies are graph queries.
4. **Append-only activity log** — one event per field change gives history, audit, notifications, undo and analytics.
5. **Views are saved queries** — lists, boards, timelines and dashboards are the same `QuerySpec`, run on the server as SQL and on the client against local data.

Stack: Postgres 16 · TypeScript monorepo (pnpm) · Fastify API · React + Replicache (local-first sync) · MCP server for agents · Slack / email / GitHub integrations · webhooks out.

See `docs/` for the data model, design, UX, integrations and the one-shot build prompt (`docs/BUILD-PROMPT.md`).

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres        # or point DATABASE_URL at your own Postgres 15+
pnpm install
pnpm --filter @pm/core build
pnpm db:migrate && pnpm db:seed
pnpm dev                             # API on :3001, web on :5173
```

Log in with any seeded email (e.g. `alice@firm.com`) using the dev login box.
