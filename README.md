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

## Quick start guide

Full guide with a five-minute tour: [Quick Start](https://github.com/jamjorf/pm-tool/wiki/Quick-Start) in the wiki.

**Prerequisites:** Node 22, pnpm 10 (`corepack enable` is enough), and Podman 4.1+ with a compose provider (`podman-compose`), or any Postgres 15+ you can point `DATABASE_URL` at.

```bash
git clone https://github.com/jamjorf/pm-tool && cd pm-tool
cp .env.example .env                 # defaults work for local use
podman compose up -d postgres        # skip if you set DATABASE_URL to your own Postgres
pnpm install
pnpm --filter @pm/core build         # other packages import @pm/core from its dist
pnpm db:migrate && pnpm db:seed      # schema + realistic demo data
pnpm dev                             # API on http://localhost:3001, web on http://localhost:5173
```

1. Open http://localhost:5173 and sign in as `alice@firm.com` (firm owner) using the dev login box. No password is needed in dev mode.
2. Open the **Rates Desk Platform** project. The sidebar lists its saved views: All open (list), Board, Roadmap (timeline), Overview (dashboard).
3. Press `Ctrl/⌘ K` for the command palette, `c` to create an item, `?` for the keyboard cheatsheet.
4. Drag a card on the board: transitions whose guards fail (for example "Start" without an assignee) are refused with the reason.
5. Settings → API keys creates a key for scripts and agents; `packages/mcp/README.md` shows how to connect the MCP server to Claude Code.

`scripts/dev.sh` runs the whole sequence above in one command. To start over: `pnpm db:reset -- --yes` (local databases only).

Seeded data: users alice (owner), bob (admin), carol, dan, eve, frank, grace, hugo (members) and a service user `agent@firm.com`; projects `RATES`, `EQD`, `OPS` (firm-visible) and `ONB` (private); 60 work items across task/bug/initiative/request types with relations, comments, views and notifications.

## Documentation wiki

The wiki at https://github.com/jamjorf/pm-tool/wiki is the task-oriented guide; its source lives in [`wiki/`](wiki/) and is published by the "Sync wiki" workflow on every push to `main` (enable Wikis under Settings → Features and create any first page once, then the workflow takes over).

| Page | What it covers |
|---|---|
| [Quick Start](https://github.com/jamjorf/pm-tool/wiki/Quick-Start) | Install, run, first login, five-minute tour, troubleshooting |
| [Data Model](https://github.com/jamjorf/pm-tool/wiki/Data-Model) | The five pillars, entity diagram, graph and permission functions |
| [Workflows and Item Types](https://github.com/jamjorf/pm-tool/wiki/Workflows-and-Item-Types) | Guards, effects, adding a desk-specific type with SQL or the admin UI |
| [Views and Queries](https://github.com/jamjorf/pm-tool/wiki/Views-and-Queries) | The QuerySpec grammar behind lists, boards, timelines and dashboards |
| [Keyboard and Palette](https://github.com/jamjorf/pm-tool/wiki/Keyboard-and-Palette) | Shortcuts, palette modes, bulk edit |
| [API](https://github.com/jamjorf/pm-tool/wiki/API) | Auth, routes, curl examples |
| [Sync](https://github.com/jamjorf/pm-tool/wiki/Sync) | How local-first sync works and its limits |
| [Integrations](https://github.com/jamjorf/pm-tool/wiki/Integrations) | Webhooks, Slack, GitHub, email |
| [MCP Server](https://github.com/jamjorf/pm-tool/wiki/MCP-Server) | Tools, resources, prompts, setup for Claude Code |
| [Operations](https://github.com/jamjorf/pm-tool/wiki/Operations) | Deployment, env vars, backups, scaling path |
| [Development](https://github.com/jamjorf/pm-tool/wiki/Development) | Repo layout, commands, tests, conventions |
| [Architecture Decisions](https://github.com/jamjorf/pm-tool/wiki/Architecture-Decisions) | ADR-001 to ADR-008 at a glance |

The deeper design documents are in [`docs/`](docs/README.md): data model, system design, UX, integrations, operations, ADRs, and the one-shot rebuild prompt [`docs/BUILD-PROMPT.md`](docs/BUILD-PROMPT.md).

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
