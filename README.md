# pm-tool

A firm-wide project management tool built around five ideas:

1. **One generic work item** with a type and validated JSONB fields — no table per type.
2. **Workflows as data** — states, transitions, guards and effects live in rows, not enums.
3. **Relations as a typed graph** — parent/child, blocks, duplicates and links to external systems are one edge table; rollups and dependencies are graph queries.
4. **Append-only activity log** — one event per field change gives history, audit, notifications, undo and analytics.
5. **Views are saved queries** — lists, boards, timelines and dashboards are the same `QuerySpec`, run on the server as SQL and on the client against local data.

Stack: Postgres 16 · TypeScript monorepo (pnpm) · Fastify API · React + Replicache (local-first sync) · MCP server for agents · Slack / email / GitHub integrations · webhooks out · single-region, single process.

| Package | What it is | Tests |
|---|---|---|
| `packages/db` | The data model: plain SQL migrations (`migrations/0001_init.sql` stands alone), runner, seed | 7 |
| `packages/core` | Browser-safe shared logic: entity schemas, QuerySpec compiler (SQL) + evaluator (client), workflow engine, permissions, field validation, activity diffs | 155 (incl. 78 SQL/local parity cases) |
| `packages/api` | Fastify server: auth, REST v1, Replicache push/pull/poke, activity log, notifications, webhooks, search | 31 |
| `packages/web` | React app: command palette, saved-query views, bulk edit, item detail, inbox, admin editors | 14 |
| `packages/mcp` | MCP server (stdio + HTTP) exposing 23 tools, resources and prompts to agents | 9 |
| `packages/integrations` | Slack, GitHub and email inbound handlers + outbound senders | 25 |

Documentation lives in `docs/`: start with [`docs/README.md`](docs/README.md). The one-shot rebuild prompt is [`docs/BUILD-PROMPT.md`](docs/BUILD-PROMPT.md).

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres        # or point DATABASE_URL at your own Postgres 15+
pnpm install
pnpm --filter @pm/core build         # other packages import @pm/core from its dist
pnpm db:migrate && pnpm db:seed
pnpm dev                             # API on :3001, web on :5173
```

Open http://localhost:5173 and sign in with a seeded email (e.g. `alice@firm.com`, the firm owner) via the dev login box. `scripts/dev.sh` does all of the above in one go.

Seeded data: users alice (owner), bob (admin), carol, dan, eve, frank, grace, hugo (members) and a service user `agent@firm.com`; projects `RATES`, `EQD`, `OPS` (firm-visible) and `ONB` (private); 60 work items across task/bug/initiative/request types with relations, comments, views and notifications.

## Everyday commands

```bash
pnpm -r build | typecheck | test     # whole repo (build @pm/core first on a fresh clone)
pnpm db:reset -- --yes               # drop, migrate, seed (local databases only)
pnpm dev:mcp                         # MCP server on stdio (needs PM_API_KEY, see packages/mcp/README.md)
python3 scripts/build-prompt/gen.py  # regenerate docs/BUILD-PROMPT.md after changing SQL/contracts
```

## Using the API and MCP server

```bash
# log in (dev mode) and keep the cookie
curl -c cj -H 'content-type: application/json' -d '{"email":"alice@firm.com"}' localhost:3001/auth/dev-login
# create an API key for scripts and agents
curl -b cj -H 'content-type: application/json' -d '{"name":"laptop"}' localhost:3001/me/api-keys
# query with the same spec the UI uses
curl -b cj -H 'content-type: application/json' -d '{"spec":{"filter":{"and":[{"field":"assignee_id","op":"eq","value":"$me"},{"field":"state.category","op":"nin","value":["done","canceled"]}]}}}' localhost:3001/api/v1/items/query
```

Register the MCP server with Claude Code: `claude mcp add pm-tool -e API_URL=http://localhost:3001 -e PM_API_KEY=pm_... -- node packages/mcp/dist/server.js` (details in `packages/mcp/README.md` and `docs/04-integrations.md`).

## Layout

```
docs/            01-data-model · 02-design · 03-ux · 04-integrations · 05-operations · adr/ · BUILD-PROMPT
packages/db      migrations/*.sql, src/{migrate,seed,reset}.ts
packages/core    src/{schema,query,workflow,permissions}, fields.ts, events.ts, mutations.ts
packages/api     src/{auth,mutations,sync,notifications,webhooks,routes}, test/
packages/web     src/{sync,store,components,pages}
packages/mcp     src/{server,tools,resources,prompts,client}.ts
packages/integrations  src/{slack,github,email}, render.ts, routes.ts
```
