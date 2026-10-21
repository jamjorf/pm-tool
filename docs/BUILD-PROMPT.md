# BUILD PROMPT — pm-tool, one shot

> Paste this entire document into Claude Code (or another coding agent) in an
> **empty directory**. It contains everything needed to reproduce the system:
> requirements, the complete database migration, the shared TypeScript
> contracts, the architecture contract, a package-by-package plan with tests,
> seed data, a verification checklist and a definition of done. Nothing else
> is required; do not ask for the original repository.

---

## 0. How to work

You are building a complete, working project management tool as a pnpm
monorepo. Read this whole document before writing a file. Then:

1. **Plan first, briefly.** Write `PLAN.md` at the repo root listing the
   phases in §7 with checkboxes. Update it as you go. Do not ask the user
   questions — every decision you need is in this document; where it is
   silent, choose the simplest option consistent with it and note the choice
   in `PLAN.md` under "Decisions".
2. **Build in order:** repo scaffold → `@pm/db` → `@pm/core` → `@pm/api` →
   `@pm/integrations` → `@pm/mcp` → `@pm/web` → docs. Each phase has
   acceptance criteria (tests). Do not start a phase before the previous
   phase's tests pass.
3. **Copy the embedded files verbatim.** §3 (ARCHITECTURE.md), §4 (SQL
   migration), §5 (core contract files) and §6 (integrations contract) are
   byte-for-byte the files you must create at the given paths. Do not
   "improve" them. Build the rest of the code against them.
4. **Verify with tests, not by reading.** Every package has a `test` script
   (vitest). The database is SQLite through Node's built-in `node:sqlite`
   (Node 22.13+): `DATABASE_URL` is a file path (default `./data/pmtool.db`)
   and tests open `:memory:` or a temporary file and apply the migration
   themselves. Nothing has to be installed or started for any test.
5. **Commit as you go.** `git init` at the start; one commit per phase with a
   message naming the phase and what passes. Never commit `.env`,
   `node_modules` or `dist`.
6. **No questions, no placeholders.** Do not leave `TODO`s in shipped code.
   If something is genuinely ambiguous, implement the simplest version that
   satisfies the tests and document it.
7. **Finish with the verification checklist (§9)** and make every line pass
   before declaring done (§10).

Tooling assumptions: Node ≥ 22.13 (for `node:sqlite`), pnpm 10 (`corepack
enable && corepack prepare pnpm@10.28.0 --activate`), git. No database
server, no container runtime, no native modules, no `sudo`. The `sqlite3`
shell is optional (handy for the verification checklist).

---

## 1. What you are building

A firm-wide project management tool for a financial firm (desks, strategies,
regulated). It starts generic and must let the firm add desk-level and
strategy-level tooling later by adding **data** (item types, workflows,
views), not applications.

### 1.1 The data model (five non-negotiables)

1. **One generic work item** with a `type` and typed columns plus validated
   JSON fields (`work_items.fields`, JSON text validated against
   `item_types.field_defs` by DB triggers using `json_each`/`json_type` and by
   `@pm/core`). No table per type.
2. **Workflows as an explicit, data-driven state machine per type**:
   `workflows` → `workflow_states` (with a closed `category`) →
   `workflow_transitions` with `guards[]` and `effects[]` as JSON, evaluated
   by a pure engine shared by client and server.
3. **A typed relation edge table** (`relations` + `relation_types`
   registry): parent/child, blocks, duplicates, relates-to, links to external
   entities (GitHub PR, Slack thread, email, URL). Dependencies and rollups
   are graph queries over the views `item_parents`, `item_ancestry`,
   `open_blockers`, `item_rollups`. Triggers enforce acyclicity, reject the
   reverse of a symmetric edge, and a partial unique index enforces a single
   parent.
4. **An append-only activity log, one event per field change**
   (`activity_events`, UPDATE/DELETE physically blocked by triggers). It
   drives history, audit, notifications, undo, webhooks and analytics.
5. **Permissions decided up front: per-project roles** (`admin`/`editor`/
   `viewer`) plus firm role (`owner`/`admin`/`member`/`guest`), project
   visibility (`firm`/`private`) and a per-item `confidential` flag.
   Attribute-style rules live in workflow guards. The SQL views
   `effective_roles(user_id, project_id, role)` and
   `visible_items(user_id, item_id)` are the authority; `@pm/core` mirrors
   them.

### 1.2 The tool

* **Views are saved queries.** Lists, boards, timelines and dashboards are
  the same `QuerySpec` (filter / sort / group) plus presentation, stored in
  `views.spec`. One composable query layer with two executors: SQL on the
  server (`compileQuery`) and in-memory on the client (`runSpec`), with
  parity tests.
* **UX:** keyboard-first command palette (`⌘K`), instant navigation on
  local data (Replicache, IndexedDB), bulk edit, good search (SQLite FTS5 +
  bm25 ranking with a LIKE fallback, until it isn't), low-noise notifications
  (inbox, collapsing, digests, quiet hours).
* **Integrations:** webhooks out (HMAC-signed, retried), a clean REST API
  in (session cookie or API key), Slack (unfurls, autolink, `/pm` slash
  command, interactive buttons, DMs), email (inbound address scheme
  `pm+KEY-12@domain`, SMTP out), GitHub (PR/issue links, `Fixes KEY-12` on
  merge), and an **MCP server** so agents can read and act on tickets.
* **Stack:** SQLite via Node's built-in `node:sqlite` (one file in WAL mode;
  no server, no native module), TypeScript monorepo (pnpm, ESM, NodeNext),
  Fastify 5 API, React 18 + Vite + Replicache web app, zod 3, vitest.
  **Single region, one API process, one writer, no microservices, no queue,
  no cache.** The hard parts are the data model and the sync, not scale.

### 1.3 Non-goals

Multi-region, horizontal scaling, SSO (magic-link + dev login only; SSO is
a proxy concern), file storage (attachments are URLs), mobile apps, rich text
beyond markdown.

---

## 2. Repository layout and root files

Create exactly this layout:

```
pm-tool/
├── package.json                 (root, embedded below)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .npmrc
├── .gitignore
├── .env.example
├── README.md
├── PLAN.md                      (yours)
├── docs/
│   └── ARCHITECTURE.md          (§3, verbatim)
└── packages/
    ├── db/            @pm/db            migrations/0001_init.sql (§4), src/{sqlite,client,index,migrate,seed,reset}.ts
    ├── core/          @pm/core          src/{index,schema/entities,query/{spec,compile,evaluate},mutations,workflow/{types,engine},permissions/{types,evaluate},fields,events}.ts
    ├── api/           @pm/api           src/{server,app,db,auth,sync,mutations/*,routes/*,workers/*,integrations}.ts
    ├── integrations/  @pm/integrations  src/{index,deps,slack,github,email,render}.ts
    ├── mcp/           @pm/mcp           src/{server,client,tools}.ts
    └── web/           @pm/web           index.html, src/{main,app,replicache,...}.tsx
```

Conventions (binding): ESM (`"type":"module"`), TypeScript `NodeNext`,
imports inside a package use `.js` extensions, rows are **snake_case exactly
as in SQL**, ids are UUIDs generated by the client (`crypto.randomUUID()`),
booleans are 0/1 and JSON is text in SQL (the `@pm/db` runtime hydrates rows
to `true`/`false` and parsed JSON by column name), validation with zod 3,
tests with vitest, build order `@pm/core` first then `pnpm -r build`.

### 2.1 `package.json` (root)

```json
{
  "name": "pm-tool",
  "private": true,
  "version": "0.1.0",
  "description": "Firm-wide project management tool: generic work items, data-driven workflows, graph relations, append-only activity log, views as saved queries, local-first sync, MCP server.",
  "type": "module",
  "packageManager": "pnpm@10.28.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "pnpm -r --filter './packages/*' run build",
    "typecheck": "pnpm -r --filter './packages/*' run typecheck",
    "test": "pnpm -r --filter './packages/*' run test",
    "lint": "pnpm -r --filter './packages/*' run lint",
    "db:migrate": "pnpm --filter @pm/db run migrate",
    "db:seed": "pnpm --filter @pm/db run seed",
    "db:reset": "pnpm --filter @pm/db run reset",
    "dev:api": "pnpm --filter @pm/api run dev",
    "dev:web": "pnpm --filter @pm/web run dev",
    "dev:mcp": "pnpm --filter @pm/mcp run dev",
    "dev": "pnpm -r --parallel --filter @pm/api --filter @pm/web run dev"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.8",
    "@types/node": "^22.10.2"
  },
  "pnpm": {
    "overrides": {
      "@types/react": "^18.3.0",
      "@types/react-dom": "^18.3.0"
    }
  }
}
```

### 2.2 `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
```

### 2.3 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  }
}
```

### 2.4 `.npmrc`

```
auto-install-peers=true
strict-peer-dependencies=false
# Hoist React type packages to the root so third-party .d.ts files (react-router, cmdk, dnd-kit) resolve them under pnpm's isolated layout.
public-hoist-pattern[]=@types/react
public-hoist-pattern[]=@types/react-dom
```

### 2.5 `.gitignore`

```
node_modules/
dist/
build/
.turbo/
*.log
.env
.env.local
.DS_Store
coverage/
.vite/
packages/web/dist/
*.tsbuildinfo
data/
*.db
*.db-wal
*.db-shm
```

### 2.6 `.env.example`

```bash
# SQLite database file used by api and db (path relative to the repo root,
# an absolute path, sqlite:path, or :memory:). Created on first use; no server needed.
DATABASE_URL=./data/pmtool.db

# API server
PORT=3001
HOST=0.0.0.0
# Secret used to sign session cookies and webhook signatures (change in prod)
APP_SECRET=change-me-please-32-bytes-minimum-secret
# Public URL of the web app (for links in notifications / Slack / email)
APP_URL=http://localhost:5173
API_URL=http://localhost:3001

# Auth: in dev, a magic-link flow prints the link to the server log.
AUTH_MODE=dev

# Email (SMTP) - optional; if unset, emails are logged
SMTP_URL=
EMAIL_FROM=pm-tool@example.com

# Slack - optional
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=

# GitHub - optional
GITHUB_WEBHOOK_SECRET=
GITHUB_TOKEN=

# MCP server
MCP_TRANSPORT=stdio
PM_API_KEY=
```

### 2.7 `README.md`

````markdown
# pm-tool

A firm-wide project management tool built around five ideas:

1. **One generic work item** with a type and validated JSON fields — no table per type.
2. **Workflows as data** — states, transitions, guards and effects live in rows, not enums.
3. **Relations as a typed graph** — parent/child, blocks, duplicates and links to external systems are one edge table; rollups and dependencies are graph queries.
4. **Append-only activity log** — one event per field change gives history, audit, notifications, undo and analytics.
5. **Views are saved queries** — lists, boards, timelines and dashboards are the same `QuerySpec`, run on the server as SQL and on the client against local data.

Stack: SQLite via Node's built-in `node:sqlite` (one file, no server, no native module) · TypeScript monorepo (pnpm) · Fastify API · React + Replicache (local-first sync) · MCP server for agents · Slack / email / GitHub integrations · webhooks out · single-region, single process.

| Package | What it is | Tests |
|---|---|---|
| `packages/db` | The data model and the SQLite runtime: plain SQL migrations (`migrations/0001_init.sql` stands alone), `openDb` + the `sql` tag, runner, seed, reset | 7 |
| `packages/core` | Browser-safe shared logic: entity schemas, QuerySpec compiler (SQL) + evaluator (client), workflow engine, permissions, field validation, activity diffs | 155 (incl. 78 SQL/local parity cases) |
| `packages/api` | Fastify server: auth, REST v1, Replicache push/pull/poke, activity log, notifications, webhooks, search | 31 |
| `packages/web` | React app: command palette, saved-query views, bulk edit, item detail, inbox, admin editors | 14 |
| `packages/mcp` | MCP server (stdio + HTTP) exposing 23 tools, resources and prompts to agents | 9 |
| `packages/integrations` | Slack, GitHub and email inbound handlers + outbound senders | 25 |

Documentation lives in `docs/`: start with [`docs/README.md`](docs/README.md). The one-shot rebuild prompt is [`docs/BUILD-PROMPT.md`](docs/BUILD-PROMPT.md).

## Quick start guide

Full guide with a five-minute tour: [Quick Start](https://github.com/jamjorf/pm-tool/wiki/Quick-Start) in the wiki.

**Prerequisites:** Node 22.13+ and pnpm 10 (`corepack enable` is enough). Nothing else: the database is a SQLite file created on first run, so there is no database server, no container runtime and no `sudo`.

```bash
git clone https://github.com/jamjorf/pm-tool && cd pm-tool
cp .env.example .env                 # defaults work for local use (DATABASE_URL=./data/pmtool.db)
pnpm install
pnpm --filter @pm/core build         # other packages import @pm/core from its dist
pnpm db:migrate && pnpm db:seed      # creates ./data/pmtool.db, applies the schema, loads demo data
pnpm dev                             # API on http://localhost:3001, web on http://localhost:5173
```

1. Open http://localhost:5173 and sign in as `alice@firm.com` (firm owner) using the dev login box. No password is needed in dev mode.
2. Open the **Rates Desk Platform** project. The sidebar lists its saved views: All open (list), Board, Roadmap (timeline), Overview (dashboard).
3. Press `Ctrl/⌘ K` for the command palette, `c` to create an item, `?` for the keyboard cheatsheet.
4. Drag a card on the board: transitions whose guards fail (for example "Start" without an assignee) are refused with the reason.
5. Settings → API keys creates a key for scripts and agents; `packages/mcp/README.md` shows how to connect the MCP server to Claude Code.

`scripts/dev.sh` runs the whole sequence above in one command. To start over: `pnpm db:reset -- --yes` (deletes the local database file, migrates, seeds), or stop the API and `rm data/pmtool.db*`.

Seeded data: users alice (owner), bob (admin), carol, dan, eve, frank, grace, hugo (members) and a service user `agent@firm.com`; projects `RATES`, `EQD`, `OPS` (firm-visible) and `ONB` (private); 60 work items across task/bug/initiative/request types with relations, comments, views and notifications.

## Documentation wiki

The wiki at https://github.com/jamjorf/pm-tool/wiki is the task-oriented guide; its source lives in [`wiki/`](wiki/) and is published by the "Sync wiki" workflow on every push to `main` (enable Wikis under Settings → Features and create any first page once, then the workflow takes over).

| Page | What it covers |
|---|---|
| [Quick Start](https://github.com/jamjorf/pm-tool/wiki/Quick-Start) | Install, run, first login, five-minute tour, troubleshooting |
| [Data Model](https://github.com/jamjorf/pm-tool/wiki/Data-Model) | The five pillars, entity diagram, graph and permission views, FTS5 search |
| [Workflows and Item Types](https://github.com/jamjorf/pm-tool/wiki/Workflows-and-Item-Types) | Guards, effects, adding a desk-specific type with SQL or the admin UI |
| [Views and Queries](https://github.com/jamjorf/pm-tool/wiki/Views-and-Queries) | The QuerySpec grammar behind lists, boards, timelines and dashboards |
| [Keyboard and Palette](https://github.com/jamjorf/pm-tool/wiki/Keyboard-and-Palette) | Shortcuts, palette modes, bulk edit |
| [API](https://github.com/jamjorf/pm-tool/wiki/API) | Auth, routes, curl examples |
| [Sync](https://github.com/jamjorf/pm-tool/wiki/Sync) | How local-first sync works and its limits |
| [Integrations](https://github.com/jamjorf/pm-tool/wiki/Integrations) | Webhooks, Slack, GitHub, email |
| [MCP Server](https://github.com/jamjorf/pm-tool/wiki/MCP-Server) | Tools, resources, prompts, setup for Claude Code |
| [Operations](https://github.com/jamjorf/pm-tool/wiki/Operations) | Deployment, env vars, backups, scaling path |
| [Development](https://github.com/jamjorf/pm-tool/wiki/Development) | Repo layout, commands, tests, conventions |
| [Architecture Decisions](https://github.com/jamjorf/pm-tool/wiki/Architecture-Decisions) | ADR-001 to ADR-009 at a glance |

The deeper design documents are in [`docs/`](docs/README.md): data model, system design, UX, integrations, operations, ADRs, and the one-shot rebuild prompt [`docs/BUILD-PROMPT.md`](docs/BUILD-PROMPT.md).

## Everyday commands

```bash
pnpm -r build | typecheck | test     # whole repo (build @pm/core first on a fresh clone)
pnpm db:reset -- --yes               # delete the local SQLite file, migrate, seed
sqlite3 data/pmtool.db               # inspect the database by hand (optional tool)
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
data/            pmtool.db (+ -wal/-shm while running); created by pnpm db:migrate, git-ignored
packages/db      migrations/*.sql, src/{sqlite,client,migrate,seed,reset}.ts   (sqlite.ts = openDb + sql tag)
packages/core    src/{schema,query,workflow,permissions}, fields.ts, events.ts, mutations.ts
packages/api     src/{auth,mutations,sync,notifications,webhooks,routes}, test/
packages/web     src/{sync,store,components,pages}
packages/mcp     src/{server,tools,resources,prompts,client}.ts
packages/integrations  src/{slack,github,email}, render.ts, routes.ts
```
````

### 2.8 Per-package `package.json` files

Use these as given (versions are known-good; you may bump patch versions if
installation fails). Each package also gets a `tsconfig.json` extending
`../../tsconfig.base.json` with `outDir: dist`, `rootDir: src`, `include:
["src"]`, `exclude: ["src/**/*.test.ts"]` (add `"lib": ["ES2023","DOM"]` for
core/web/mcp, `"types": ["node"]` for db/api) and a `vitest.config.ts`:
`export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })`
(web: `environment: 'jsdom'`, include `src/**/*.test.{ts,tsx}`).

`packages/core/package.json`:

```json
{
  "name": "@pm/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@pm/db": "workspace:*",
    "@types/node": "^22.10.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/db/package.json`:

```json
{
  "name": "@pm/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./migrate": {
      "types": "./dist/migrate.d.ts",
      "import": "./dist/migrate.js"
    },
    "./seed": {
      "types": "./dist/seed.d.ts",
      "import": "./dist/seed.js"
    },
    "./sqlite": {
      "types": "./dist/sqlite.d.ts",
      "import": "./dist/sqlite.js"
    }
  },
  "scripts": {
    "migrate": "tsx src/migrate.ts",
    "seed": "tsx src/seed.ts",
    "reset": "tsx src/reset.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "tsx": "^4.19.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/integrations/package.json`:

```json
{
  "name": "@pm/integrations",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Slack, GitHub and email integrations for pm-tool: inbound Fastify routes + outbound senders and notification rendering. Pure library (no DB driver).",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@pm/core": "workspace:*",
    "nodemailer": "^7.0.13"
  },
  "peerDependencies": {
    "fastify": "^5.0.0"
  },
  "peerDependenciesMeta": {
    "fastify": {
      "optional": false
    }
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/nodemailer": "^6.4.24",
    "fastify": "^5.12.7",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/mcp/package.json`:

```json
{
  "name": "@pm/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "MCP server exposing pm-tool projects, items, workflows and views to agents (stdio or Streamable HTTP). Talks to @pm/api over HTTP with an API key.",
  "main": "./dist/server.js",
  "bin": {
    "pm-mcp": "./dist/server.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.1",
    "@pm/core": "workspace:*",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.23.15",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/web/package.json`:

```json
{
  "name": "@pm/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "vite build",
    "preview": "vite preview --port 5173",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@pm/core": "workspace:*",
    "@tanstack/react-virtual": "^3.14.20",
    "cmdk": "^1.1.1",
    "date-fns": "^4.4.0",
    "lucide-react": "^0.468.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.1.0",
    "react-router-dom": "^6.30.6",
    "replicache": "^15.3.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.8",
    "@types/node": "^22.20.5",
    "@types/react": "^18.3.31",
    "@types/react-dom": "^18.3.7",
    "@vitejs/plugin-react": "^4.7.0",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.9.3",
    "vite": "^6.4.4",
    "vitest": "^3.2.7"
  }
}
```

`packages/api/package.json`:

```json
{
  "name": "@pm/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/server.js",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.3",
    "@fastify/cors": "^11.3.1",
    "@pm/core": "workspace:*",
    "@pm/db": "workspace:*",
    "@pm/integrations": "workspace:*",
    "fastify": "^5.12.7",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.23.15",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

---

## 3. The architecture contract — `docs/ARCHITECTURE.md` (verbatim)

Create this file exactly. It is the contract every package is built against:
query layer, mutation pipeline, sync protocol, HTTP API v1 route list,
webhooks, notification rules, web app behaviour, integrations interface.

````markdown
# Architecture & package contracts

This file is the contract every package is built against. Read it before
touching code. The SQL in `packages/db/migrations/0001_init.sql` and the
TypeScript in `packages/core/src/{schema,query/spec.ts,mutations.ts,workflow/types.ts,permissions/types.ts}`
are the source of truth; this doc explains how the pieces connect.

## Monorepo layout

| Package | npm name | Purpose |
|---|---|---|
| `packages/db` | `@pm/db` | The SQLite runtime layer (`openDb`, the `sql` tag, transactions, row hydration), SQL migrations (plain `.sql`, numbered), tiny migration runner, seed and reset scripts. **Standalone data model.** Built on Node's `node:sqlite`; no native module, no server. |
| `packages/core` | `@pm/core` | Pure, browser-safe TypeScript shared by everything: entity zod schemas, QuerySpec (+ SQL compiler + local evaluator), workflow engine, permission evaluator, mutation vocabulary, field validation, event helpers. **No Node-only imports, no I/O.** |
| `packages/api` | `@pm/api` | Fastify 5 server: auth, REST API v1, Replicache-style sync (`/sync/push`, `/sync/pull`, `/sync/poke` SSE), activity log writer, notifications, webhooks-out dispatcher, FTS search, integration inbound routes (mounted from `@pm/integrations`). |
| `packages/web` | `@pm/web` | Vite + React 18 SPA. Local-first via Replicache (IndexedDB). Command palette, saved-query views (list/board/timeline/dashboard), bulk edit, search, notifications inbox, item detail, admin (workflows/types/webhooks). |
| `packages/mcp` | `@pm/mcp` | MCP server (stdio + Streamable HTTP) exposing tickets to agents. Talks to the API over HTTP with an API key. |
| `packages/integrations` | `@pm/integrations` | Slack, GitHub, email: inbound handlers (Fastify plugins) + outbound senders. Pure library consumed by `@pm/api`. |

Conventions: ESM (`"type":"module"`), TS `NodeNext`, imports inside a package
use `.js` extensions, rows are **snake_case exactly as in SQL**, ids are
UUIDs generated by the client (`crypto.randomUUID()`) so optimistic UI is
stable. In SQL, booleans are 0/1 and JSON is text; the `@pm/db` runtime
hydrates rows (JSON columns parsed, 0/1 → `true`/`false` by column name) so
every layer above it sees typed values. Validation with zod 3. Tests with
vitest. Build order: `@pm/core` first (`pnpm --filter @pm/core build`), then
the rest (`pnpm -r build`).

Env vars: see `.env.example`. `DATABASE_URL` is the path of the SQLite file
(relative to the repo root, absolute, `sqlite:`/`file:` prefixed, or
`:memory:`); it defaults to `./data/pmtool.db`, so nothing is strictly
required. The file and its directory are created on first open.

## Data model (summary; details in docs/01-data-model.md)

* `work_items` — one generic entity. `type_id` → `item_types`, whose
  `field_defs` (JSON array of `FieldDef`) describe the validated JSON object
  in `work_items.fields`. DB triggers (`work_items_validate_fields_*`,
  using `json_each`/`json_type`) reject unknown keys / wrong kinds / missing
  required; `@pm/core` `validateFields()` does the same + option membership
  before the write. `number`/`key` (`RATES-12`) are assigned by an AFTER
  INSERT trigger, so `RETURNING` shows them as null: read the row back.
  Full-text search is the FTS5 table `work_items_fts` (key/title/description,
  `porter unicode61`), kept in sync by triggers.
* Workflows are data: `workflows` → `workflow_states` (with `category`) →
  `workflow_transitions` (`from_state_id` null = any; `guards[]`, `effects[]`).
  Evaluated by `@pm/core` `workflowEngine`.
* Relations: one `relations` edge table, `type` ∈ `relation_types`
  (`parent_of`, `blocks`, `duplicates`, `relates_to`, `links_to`). External
  entities use `to_item_id = null` + `external_kind`/`external_ref`. Triggers
  (`relations_no_cycle_*`, recursive CTE) enforce acyclicity and reject the
  reverse of a symmetric edge; a partial unique index enforces single parent.
  Graph helpers are views: `item_parents(item_id, parent_id)`,
  `item_ancestry(ancestor_id, item_id, depth)`, `open_blockers(item_id,
  blocker_id)`, `item_rollups(root_id, total, done, in_progress, todo,
  canceled, estimate_total, estimate_done)`.
* `activity_events` — append-only (triggers block UPDATE and DELETE; SQLite
  has no TRUNCATE). One row per field change, grouped by `txn_id`. `id` is
  `integer primary key autoincrement`, a monotonic cursor for feeds, webhooks
  and notifications.
* Permissions: `users.firm_role` (owner/admin/member/guest) +
  `project_members.role` (admin/editor/viewer) + `projects.visibility`
  (firm/private) + `work_items.confidential`. SQL: the views
  `effective_roles(user_id, project_id, role)` and
  `visible_items(user_id, item_id)` (SQLite has no SQL functions). TS:
  `permissions.can()`. Firm `member` gets `editor` on every `firm`-visible
  project without an explicit membership row; `guest` only sees projects they
  are added to.
* Views are saved queries: `views.spec` is a `ViewSpec` (= `QuerySpec` +
  presentation). All synced tables have `version` (stamped by trigger from
  the one-row `sync_state` table) and `deleted_at` tombstones. Types: ids
  are UUID text, timestamps ISO-8601 UTC text, dates `YYYY-MM-DD` text,
  booleans 0/1 with CHECK, enums CHECK constraints, JSON columns text; former
  arrays (`scopes`, `event_kinds`, `allowed_type_ids`, `notification_ids`) are
  JSON arrays. Seeded workflows/states/types have fixed UUIDs
  (`…a01`/`…a02` workflows, `…b01`–`…b14` states, `…d01`–`…d04` types).

## The query layer (one spec, two executors)

`QuerySpec = { filter?: FilterExpr, sort?: SortSpec[], group_by?: FieldRef, limit?, offset? }`.

* Server: `compileQuery(spec, ctx, opts)` → `{ text, values }` (SQLite SQL
  with positional `?` placeholders) over the `work_items_v` view (columns:
  everything in `work_items` plus `type_key`, `state_key`, `state_category`,
  `project_key`, `assignee_name`, `label_names` (JSON array), `parent_id`,
  `is_blocked` (0/1)). `fields.<key>` compiles to
  `json_extract(w.fields, '$.key')`; multi-valued kinds use `json_each`.
  `labels` compiles to an EXISTS over `work_item_labels`. `search` compiles
  to a join on `w.id` against the FTS hit set
  `(select id, bm25(work_items_fts, 10.0, 5.0, 1.0) as rank from work_items_fts where work_items_fts match ?)`,
  deduplicated by id and ordered by `rank`; the search route falls back to
  `LIKE` on key/title when FTS finds nothing. The permission scope is
  added as an extra WHERE: `visibilityWhere(userId)` =
  `exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id)`.
  Widget time buckets (`day`/`week`/`month`) are computed in UTC with
  `strftime`; weeks start on Monday.
* Client: `runSpec(spec, items, ctx, lookups)` evaluates the same spec over
  rows from the local Replicache store. `matchesFilter` must agree with the
  SQL compiler for every op (the core tests assert parity on a fixture set).
* Dashboards: each widget = `QuerySpec` + `group_by` + `measure`. Server
  `compileWidget()`; client aggregates `runSpec().groups`.

Macros (`$me`, `$today`, `$now`, `$start_of_week`, `$end_of_week`,
`$start_of_month`) are resolved by both executors with `ctx.userId`/`ctx.tz`.

## Mutations (one write vocabulary)

`packages/core/src/mutations.ts` lists every mutation and its zod args. The
same names are used by:

* the web client's Replicache mutators (optimistic, local KV),
* `POST /sync/push` (authoritative replay, in order, per client),
* REST v1 (each route maps to one mutation; e.g. `PATCH /items/:key` → `updateItem`),
* MCP tools (via REST).

Server implementation lives in `packages/api/src/mutations/` as
`applyMutation(tx, actor, mutation, meta)` where `meta = { source, txnId,
mutationName, actorKind, actorLabel }`. It must:

1. Check permissions with `permissions.assert()`.
2. Validate `fields` with `validateFields()` for the item's type.
3. For `transitionItem`, load `GuardContext` (role from `effective_roles`,
   open blockers via `open_blockers`, children categories, labels) and call
   `workflowEngine.evaluate()`; apply `patch`; execute `deferredEffects`
   (notify → notifications; webhook → enqueue; transition_parent_if /
   transition_children → recursive transitions; add/remove_label).
4. Diff before/after and insert **one `activity_events` row per changed
   field** (JSON keys as `fields.<key>`), all sharing `txn_id`.
5. Maintain `item_watchers` (assignee, reporter, commenter, mention → auto-watch).
6. Produce notifications per `notification_preferences.rules`, never for the actor's own action, collapsing unread duplicates per (user, item, kind).
7. Enqueue `webhook_deliveries` for endpoints whose `event_kinds` match (`*` matches all).
8. Set `sync_client_groups.resync_required = true` for affected users when membership / visibility / confidentiality changes.

Every write transaction that touches synced tables runs in `sql.begin()`
from `@pm/db`, i.e. `BEGIN IMMEDIATE`: SQLite's single write lock serialises
writers for the life of the transaction, so `version` order equals commit
order (global version strategy) without an advisory lock. Transactions must
be short and must never span network I/O; workers claim rows in one short
transaction, do the I/O, and record the result in another. Trigger
`RAISE(ABORT)` messages (`sqliteErrorKind(e) === 'trigger'`) and CHECK/NOT
NULL failures map to 400 `validation`; UNIQUE failures map to 409 `conflict`.

## Sync protocol (Replicache-compatible)

* `POST /sync/push` body `PushRequest`. For each mutation: in one
  `BEGIN IMMEDIATE` transaction, read `sync_clients.last_mutation_id`; skip if
  `mutation.id <= last`; error if `> last + 1`; otherwise
  `applyMutation()` and set `last_mutation_id = mutation.id`,
  `version = sql.nextVersion()` (`sync_state.version + 1`). Errors inside a mutation are
  logged, the mutation is **still marked applied** (Replicache semantics:
  the client's optimistic change is rolled back on next pull) and a
  `notifications` row of kind `mutation_rejected` is created for the user so the UI can show "that change was rejected: <reason>". After the push, poke.
* `POST /sync/pull` body `PullRequest`; `cookie` is the last `version` the
  client saw (null → 0). The pull runs in one deferred read transaction
  (`sql.snapshot()`, a consistent WAL snapshot) and reads `sync_state.version`
  inside it. Response `PullResponse`:
  `{ cookie: <sync_state.version in that snapshot>, lastMutationIDChanges, patch }`.
  If cookie is null/0 or the client group has `resync_required`, send
  `{op:'clear'}` followed by `put`s of every visible row and clear the
  flag. Otherwise, for each synced table, select rows with
  `version > cookie`: emit `put` when the row is visible to the user and
  `deleted_at is null`, otherwise `del`. Visibility per table:
  * `users`, `teams`, `workflows`, `workflow_states`, `workflow_transitions`, `item_types`, `labels` (firm-wide + visible projects): everyone.
  * `projects`, `project_members`: project in `select project_id from effective_roles where user_id = ?`.
  * `work_items`: `exists (select 1 from visible_items where user_id = ? and item_id = ?)`.
  * `comments`, `relations` (either end visible), `work_item_labels`, `item_watchers`: parent item visible.
  * `views`: `owner_id = user` or (`is_shared` and project visible / null project).
  * `notifications`, `notification_preferences`: `user_id = user`.
  KV key for a row is `rowKey(table, row)` = `"<table>/<pk...>"` from `@pm/core`.
* `GET /sync/poke` — Server-Sent Events. Server sends `event: poke` whenever
  any push/REST write commits. Clients call `replicache.pull()` on poke.
  (Single-region, single process: an in-memory EventEmitter is enough.)

## HTTP API v1 (served by `@pm/api`)

Auth: session cookie `pm_session` (httpOnly, signed with `APP_SECRET`) **or**
`Authorization: Bearer pm_<key>` (API key; `api_keys.key_hash = sha256`).
Errors: `{ "error": { "code": "not_found" | "forbidden" | "validation" | "conflict" | "guard_failed" | "unauthorized" | "internal", "message": string, "details"?: unknown } }`.
Item routes accept the item key (`RATES-12`) or UUID. Project routes accept the project key or UUID.

```
GET  /health
POST /auth/dev-login            {email, name?}       AUTH_MODE=dev only. First user becomes firm owner.
POST /auth/magic-link           {email}              sends link (dev: logs it)
GET  /auth/callback?token=      sets cookie, 302 → APP_URL
POST /auth/logout
GET  /me                        → {user, memberships:[{project_id, role}], preferences:[...]}
POST /me/api-keys               {name, scopes?} → {id, key}   (key shown once)
GET  /me/api-keys ; DELETE /me/api-keys/:id

POST /sync/push | POST /sync/pull | GET /sync/poke

GET    /api/v1/projects                       ?include_archived
POST   /api/v1/projects                       createProject args (id optional)
GET    /api/v1/projects/:key                  → project + members + item counts by category + views
PATCH  /api/v1/projects/:key                  updateProject.patch
GET    /api/v1/projects/:key/members
PUT    /api/v1/projects/:key/members/:userId  {role}
DELETE /api/v1/projects/:key/members/:userId

GET    /api/v1/items                          ?project=KEY&type=task&state_category=todo,in_progress&assignee=me|<uuid>&label=name&q=text&updated_since=ISO&limit=50&cursor=
POST   /api/v1/items/query                    {spec: QuerySpec} → {items, groups?, total}
POST   /api/v1/items                          createItem args (id optional; project may be given as project_key)
GET    /api/v1/items/:key                     → {item, labels, relations:[{...relation, other_item:{id,key,title,state}}], parent, children, rollup, available_transitions:[{key,name,to_state,allowed,failures}], watchers}
PATCH  /api/v1/items/:key                     ItemPatch
DELETE /api/v1/items/:key                     soft delete
POST   /api/v1/items/:key/restore
POST   /api/v1/items/:key/transitions/:transitionKey   {comment?} → 200 item | 409 guard_failed {failures}
GET    /api/v1/items/:key/transitions         available transitions with guard evaluation
GET    /api/v1/items/:key/activity            ?before=<event id>&limit
GET    /api/v1/items/:key/comments
POST   /api/v1/items/:key/comments            {body, parent_id?}
PATCH  /api/v1/comments/:id ; DELETE /api/v1/comments/:id
GET    /api/v1/items/:key/relations
POST   /api/v1/items/:key/relations           {type, to_item?: key|uuid, external_kind?, external_ref?}
DELETE /api/v1/relations/:id
PUT    /api/v1/items/:key/parent              {parent: key|uuid|null}
POST   /api/v1/items/:key/labels              {label: name|uuid}  ; DELETE /api/v1/items/:key/labels/:labelId
POST   /api/v1/items/:key/watch ; DELETE /api/v1/items/:key/watch
POST   /api/v1/items/bulk                     {ids|keys, patch}
POST   /api/v1/items/bulk-transition          {ids|keys, transition_key} → {ok:[], failed:[{id, failures}]}

GET    /api/v1/search                         ?q=&project=&limit → {items:[{...item, rank, snippet}]}   (FTS5 bm25 rank; LIKE fallback)
GET    /api/v1/my-work                        → {assigned, created, watching, due_soon, mentions}   (used by MCP + palette)

GET    /api/v1/types ; PUT /api/v1/types/:key (admin, upsertItemType)
GET    /api/v1/workflows ; GET /api/v1/workflows/:key ; PUT /api/v1/workflows/:key (admin, upsertWorkflow; validates with workflowEngine.validateDefinition)
GET    /api/v1/labels ?project= ; POST /api/v1/labels
GET    /api/v1/users ; PATCH /api/v1/users/:id (firm admin: firm_role, is_active)
GET    /api/v1/views ?project= ; POST /api/v1/views ; PATCH /api/v1/views/:id ; DELETE /api/v1/views/:id ; POST /api/v1/views/:id/run → same as items/query (dashboards: {widgets:[{id, rows:[{key,label,value}]}]})
GET    /api/v1/notifications ?unread=1 ; POST /api/v1/notifications/:id/read ; POST /api/v1/notifications/read-all
GET    /api/v1/notification-preferences ; PUT /api/v1/notification-preferences/:channel
GET    /api/v1/activity                       ?project=&item=&actor=&since=<event id>&limit  (firm/project feed; respects visibility)
GET    /api/v1/webhooks ; POST /api/v1/webhooks {name,url,event_kinds,project?} ; PATCH/DELETE /api/v1/webhooks/:id ; GET /api/v1/webhooks/:id/deliveries ; POST /api/v1/webhooks/:id/test
GET    /api/v1/integrations ; PUT /api/v1/integrations/:kind {config, is_active}
GET    /api/v1/export/items.csv               ?project= (respects visibility)

POST   /integrations/slack/events             Slack Events API (url_verification, link_shared → unfurl, message → autolink KEY-123)
POST   /integrations/slack/commands           slash command `/pm create|find|mine|KEY-123`
POST   /integrations/slack/interactions       block actions (transition buttons on notifications)
POST   /integrations/github/webhook           pull_request / issues / push events; links PRs mentioning KEY-123; "Fixes KEY-123" + merge → runs the `complete` transition
POST   /integrations/email/inbound            provider-agnostic JSON {from, to, subject, text, html?, message_id, in_reply_to?}; `pm+KEY-12@…` → comment, `pm+PROJECT@…` → new item
```

## Webhooks out

`webhook_endpoints.event_kinds` filter on `EventKind` (`item.created`,
`item.updated`, `item.transitioned`, `item.completed`, `item.deleted`,
`item.restored`, `comment.created`, `comment.updated`, `comment.deleted`,
`relation.added`, `relation.removed`, `project.created`, `project.updated`).
A dispatcher loop in the API process (every 5s) delivers pending rows with
headers `X-PM-Event`, `X-PM-Delivery`, `X-PM-Signature: sha256=<hmac(secret, body)>`,
body `{ id, kind, created_at, actor:{id,name,kind}, project:{id,key,name},
item:{...work_items_v row}, changes:[{field, old, new}], event_ids:[...] }`.
Retries with backoff 1m → 5m → 30m → 2h → 12h, then `dead`.
Changes within one `txn_id` for the same item are coalesced into one delivery.

## Notifications (low-noise rules)

Generated in `applyMutation` from the activity diff:

| kind | recipient | default on |
|---|---|---|
| `mention` | users mentioned in description/comment | yes |
| `assigned` | new assignee | yes |
| `reply` | parent comment author | yes |
| `state_change` | assignee (rule `state_change_assigned`), other watchers (rule `state_change_watching`, default off) | partly |
| `comment` | watchers (rule `comment_watching`, default off) | no |
| `due_soon` | assignee, 24h before `due_date` (scheduler) | yes |
| `mutation_rejected` | actor whose optimistic mutation failed server-side | always |

Never notify the actor about their own action. In-app: one unread row per
(user, item, kind) — later events update `body`/`updated_at` instead of
inserting. Email/Slack: `notification_deliveries` scheduled per
`cadence` (immediate / hourly / daily digest) and quiet hours.

## Web app (local-first)

* Replicache client (`replicache` npm, v15) with `pushURL=/sync/push`,
  `pullURL=/sync/pull`, poke via SSE. `mutators` object is generated from
  `MutationArgs`: each mutator validates args, then applies an optimistic
  local write mirroring the server (e.g. `createItem` puts a `work_items/<id>`
  row with a temporary `key = "<PROJECT>-?"` and `number = 0`; the pull
  replaces it; `transitionItem` sets `state_id` using the local workflow
  definition and `workflowEngine.evaluate` with a best-effort GuardContext).
* All reads come from the local store (`useSubscribe` over key prefixes);
  navigation never waits on the network. Deep search goes to `/api/v1/search`.
* Views: the route `/p/:projectKey/v/:viewId` renders `views.spec` with the
  component for `spec.kind` (List/Board/Timeline/Dashboard), all fed by
  `runSpec()` from `@pm/core`. Unsaved filter/sort edits live in URL state
  until "Save view".
* Command palette (`cmdk`), `⌘K`: navigate (projects, views, items by key or
  title), create item (`c`), actions on the selected/focused items
  (assign, set priority, transition, label, move), bulk mode when multiple
  rows are selected (`x` toggles selection, `shift+click` ranges, `⌘A`).
* Keyboard: `j/k` move, `enter` open, `esc` close, `c` new, `e` edit title,
  `a` assign, `p` priority, `s` state, `l` label, `/` search, `g` then `i/p/n`
  go to inbox/projects/notifications, `?` cheatsheet.

## Integrations contract

`@pm/integrations` exports:

```ts
registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationDeps): Promise<void>  // mounts /integrations/*
sendSlackMessage(deps, { channel, text, blocks? }): Promise<void>
sendEmail(deps, { to, subject, text, html? }): Promise<void>
renderNotification(n: OutboundNotification): { subject: string; text: string; html: string; slackBlocks: unknown[] }
renderDigest(items: OutboundNotification[]): { subject: string; text: string; html: string; slackBlocks: unknown[] }
```

`IntegrationDeps` is defined in `packages/integrations/src/deps.ts` and
implemented by `packages/api/src/integrations.ts`. The API's notification
delivery worker calls `renderNotification`/`renderDigest` and then
`sendEmail`/`sendSlackMessage`.
````

---

## 4. The database migration — `packages/db/migrations/0001_init.sql` (verbatim, complete)

Create this file exactly. It is self-contained and applies to any SQLite
3.38+ with `sqlite3 pmtool.db < 0001_init.sql` (no extensions). It defines
every table, trigger, view and index, the FTS5 table `work_items_fts`, the
one-row `sync_state` counter and the per-table version triggers, the seeded
`standard` and `simple` workflows and `task`/`bug`/`initiative`/`request`
item types (fixed UUIDs), and the `work_items_v` view. Ids are UUID text,
timestamps ISO-8601 UTC text, booleans 0/1, enums CHECK constraints, JSON
columns text.

```sql
-- ============================================================================
-- pm-tool :: core data model (SQLite)
-- ----------------------------------------------------------------------------
-- Self-contained: apply to any SQLite 3.38+ database (3.45+ recommended) with
--   sqlite3 pmtool.db < 0001_init.sql
-- and use standalone, without the rest of the monorepo. No extensions, no
-- native modules, no server process. The application opens the file with
-- Node's built-in `node:sqlite`.
--
-- Conventions
--   * ids are UUID strings (text); defaults generate a v4 UUID in SQL.
--   * timestamps are ISO-8601 UTC text ("2026-10-21T04:55:21.249Z");
--     dates are "YYYY-MM-DD" text. Both sort and compare correctly as text.
--   * booleans are integer 0/1 with a CHECK; enums are text with a CHECK.
--   * JSON columns are text validated with json_valid()/json_type().
--   * arrays (scopes, event_kinds, allowed_type_ids, ...) are JSON arrays.
--
-- Design pillars (see docs/01-data-model.md)
--   1. One generic `work_items` entity with a `type_id` + validated JSON `fields`.
--   2. Workflows are DATA: states + transitions + guards + effects per workflow.
--   3. Relations are one typed edge table (parent/child, blocks, duplicates,
--      external links). Rollups and dependency checks are graph queries.
--   4. Activity log is append-only, one row per field change; UPDATE/DELETE
--      are blocked by triggers.
--   5. Permissions: per-project roles + firm role + project visibility,
--      exposed as views (effective_roles, visible_items).
--   6. Views are saved queries (`views.spec`), not screens.
--   7. Every synced table carries `version` (global version stamped by
--      triggers from `sync_state`) and uses soft-delete tombstones.
--
-- Runtime pragmas (set by the application on every connection):
--   PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 0. Sync plumbing (global version strategy)
-- ----------------------------------------------------------------------------
-- One monotonically increasing counter. Triggers below stamp every inserted or
-- updated row of a synced table with the next value. SQLite serialises writers
-- (BEGIN IMMEDIATE), so version order == commit order without any extra lock.
create table sync_state (
  id       integer primary key check (id = 1),
  version  integer not null default 0
);
insert into sync_state(id, version) values (1, 0);

-- ----------------------------------------------------------------------------
-- 1. Principals
-- ----------------------------------------------------------------------------
create table users (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  email         text not null,
  name          text not null,
  avatar_url    text,
  firm_role     text not null default 'member' check (firm_role in ('owner','admin','member','guest')),
  is_active     integer not null default 1 check (is_active in (0,1)),
  is_service    integer not null default 0 check (is_service in (0,1)),   -- bots / integrations / agents
  settings      text not null default '{}' check (json_valid(settings) and json_type(settings) = 'object'),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create unique index users_email_uq on users (lower(email)) where deleted_at is null;

create table sessions (
  id            text primary key default (lower(hex(randomblob(16)))),
  user_id       text not null references users(id) on delete cascade,
  token_hash    text not null unique,
  expires_at    text not null,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  text
);
create index sessions_user_idx on sessions(user_id);

create table api_keys (
  id            text primary key default (lower(hex(randomblob(16)))),
  user_id       text not null references users(id) on delete cascade,
  name          text not null,
  key_prefix    text not null,          -- first 8 chars, for display
  key_hash      text not null unique,   -- sha256 of full key
  scopes        text not null default '["read","write"]' check (json_valid(scopes) and json_type(scopes) = 'array'),
  expires_at    text,
  last_used_at  text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    text
);
create index api_keys_user_idx on api_keys(user_id);

create table teams (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique,   -- e.g. "RATES", "OPS"
  name          text not null,
  description   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

create table team_members (
  team_id       text not null references teams(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  is_lead       integer not null default 0 check (is_lead in (0,1)),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (team_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 2. Workflows (state machines as data)
-- ----------------------------------------------------------------------------
create table workflows (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique,
  name          text not null,
  description   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- Category lets generic UI/queries treat states uniformly across workflows
-- (e.g. "show me everything not done" regardless of type).
create table workflow_states (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  workflow_id   text not null references workflows(id) on delete cascade,
  key           text not null,
  name          text not null,
  category      text not null check (category in ('backlog','todo','in_progress','done','canceled')),
  color         text,
  sort          integer not null default 0,
  is_initial    integer not null default 0 check (is_initial in (0,1)),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  unique (workflow_id, key)
);
create unique index workflow_states_one_initial on workflow_states(workflow_id) where is_initial = 1 and deleted_at is null;

-- A transition with from_state_id = NULL is allowed from ANY state.
-- guards:  JSON array of guard specs evaluated by the @pm/core workflow engine, e.g.
--   [{"type":"require_field","field":"assignee_id"},
--    {"type":"no_open_blockers"},
--    {"type":"children_in_category","categories":["done","canceled"]},
--    {"type":"require_role","roles":["admin","editor"]},
--    {"type":"field_equals","field":"fields.approved","value":true}]
-- effects: JSON array of side effects applied after the transition, e.g.
--   [{"type":"set_field","field":"completed_at","value":"$now"},
--    {"type":"set_field","field":"assignee_id","value":null},
--    {"type":"notify","audience":["watchers"],"template":"state_changed"},
--    {"type":"webhook","event":"item.transitioned"},
--    {"type":"transition_parent_if","all_children_category":["done","canceled"],"to":"done"}]
create table workflow_transitions (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  workflow_id   text not null references workflows(id) on delete cascade,
  key           text not null,
  name          text not null,
  from_state_id text references workflow_states(id) on delete cascade,
  to_state_id   text not null references workflow_states(id) on delete cascade,
  guards        text not null default '[]' check (json_valid(guards) and json_type(guards) = 'array'),
  effects       text not null default '[]' check (json_valid(effects) and json_type(effects) = 'array'),
  sort          integer not null default 0,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  unique (workflow_id, key)
);
create index workflow_transitions_from_idx on workflow_transitions(workflow_id, from_state_id);

-- ----------------------------------------------------------------------------
-- 3. Item types (one generic entity, typed fields via registry + JSON)
-- ----------------------------------------------------------------------------
-- field_defs: JSON array describing the type-specific fields stored in
-- work_items.fields. Validated by triggers (DB) and by the zod schema generated
-- from the same defs in @pm/core (app).
--   [{"key":"severity","label":"Severity","kind":"select",
--     "options":[{"value":"s1","label":"S1"},...],"required":true},
--    {"key":"desk","label":"Desk","kind":"text"},
--    {"key":"notional","label":"Notional (USD)","kind":"number"},
--    {"key":"go_live","label":"Go-live","kind":"date"},
--    {"key":"approver","label":"Approver","kind":"user"},
--    {"key":"links","label":"Links","kind":"url","multi":true}]
-- kind ∈ text | long_text | number | bool | date | datetime | select |
--        multi_select | user | url
create table item_types (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique,          -- "task", "bug", "initiative", "trade_idea"
  name          text not null,
  plural_name   text,
  icon          text,
  color         text,
  description   text,
  workflow_id   text not null references workflows(id),
  field_defs    text not null default '[]' check (json_valid(field_defs) and json_type(field_defs) = 'array'),
  is_container  integer not null default 0 check (is_container in (0,1)),  -- can have children (epic/initiative)
  sort          integer not null default 0,
  is_active     integer not null default 1 check (is_active in (0,1)),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- ----------------------------------------------------------------------------
-- 4. Projects + membership (permissions backbone)
-- ----------------------------------------------------------------------------
create table projects (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique check (key glob '[A-Z]*' and key not glob '*[^A-Z0-9]*' and length(key) between 2 and 10),  -- "RATES" → item keys RATES-12
  name          text not null,
  description   text,
  status        text not null default 'active' check (status in ('planned','active','paused','completed','archived')),
  visibility    text not null default 'firm' check (visibility in ('firm','private')),
  lead_id       text references users(id),
  team_id       text references teams(id),
  item_seq      integer not null default 0,   -- per-project item numbering
  default_type_id text references item_types(id),
  allowed_type_ids text check (allowed_type_ids is null or (json_valid(allowed_type_ids) and json_type(allowed_type_ids) = 'array')), -- null = all active types
  settings      text not null default '{}' check (json_valid(settings) and json_type(settings) = 'object'),
  start_date    text,
  target_date   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   text,
  deleted_at    text
);

create table project_members (
  project_id    text not null references projects(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  role          text not null default 'editor' check (role in ('admin','editor','viewer')),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (project_id, user_id)
);
create index project_members_user_idx on project_members(user_id);

-- ----------------------------------------------------------------------------
-- 5. Work items (the one generic entity)
-- ----------------------------------------------------------------------------
-- `number` and `key` are filled by the assign_item_number trigger right after
-- insert when omitted (SQLite triggers cannot rewrite NEW before the row
-- exists), which is why they are nullable at the column level.
create table work_items (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  project_id    text not null references projects(id),
  type_id       text not null references item_types(id),
  number        integer,                                 -- per project; filled by trigger when omitted
  key           text,                                    -- "RATES-12" (denormalized for search/links)
  title         text not null check (length(title) between 1 and 500),
  description   text not null default '',               -- markdown
  state_id      text not null references workflow_states(id),
  priority      integer not null default 0 check (priority between 0 and 4), -- 0 none,1 urgent..4 low
  assignee_id   text references users(id),
  reporter_id   text references users(id),
  start_date    text,
  due_date      text,
  estimate      real,                                    -- points/hours; unit per project settings
  fields        text not null default '{}' check (json_valid(fields) and json_type(fields) = 'object'),
  confidential  integer not null default 0 check (confidential in (0,1)),  -- visible to project admins + assignee + reporter + creator only
  sort_order    real not null default 0,                 -- manual ordering within a board column
  version       integer not null default 0,
  created_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  text,
  canceled_at   text,
  archived_at   text,
  deleted_at    text,
  unique (project_id, number)
);
create unique index work_items_key_uq on work_items(key);
create index work_items_project_state_idx on work_items(project_id, state_id) where deleted_at is null;
create index work_items_assignee_idx on work_items(assignee_id) where deleted_at is null;
create index work_items_type_idx on work_items(type_id) where deleted_at is null;
create index work_items_due_idx on work_items(due_date) where deleted_at is null and due_date is not null;
create index work_items_version_idx on work_items(version);

-- Full-text search: an FTS5 index over key/title/description, kept in sync by
-- triggers. Query with:  select id from work_items_fts where work_items_fts match ?
-- Rank with bm25(work_items_fts, 0.0, 10.0, 5.0, 1.0): one weight per column INCLUDING the
-- unindexed id (id, key, title, description); lower is better.
create virtual table work_items_fts using fts5(
  id unindexed, key, title, description,
  tokenize = 'porter unicode61'
);

-- AFTER INSERT triggers fire most-recently-created first, so assign_item_number
-- (below) may already have re-indexed this row through work_items_fts_au;
-- delete first so an item never has two FTS rows.
create trigger work_items_fts_ai after insert on work_items begin
  delete from work_items_fts where id = new.id;
  insert into work_items_fts(id, key, title, description)
    select id, coalesce(key, ''), title, description from work_items where id = new.id;
end;
create trigger work_items_fts_au after update of key, title, description on work_items begin
  delete from work_items_fts where id = old.id;
  insert into work_items_fts(id, key, title, description) values (new.id, coalesce(new.key,''), new.title, new.description);
end;
create trigger work_items_fts_ad after delete on work_items begin
  delete from work_items_fts where id = old.id;
end;

-- Assign per-project number + key on insert (when omitted)
create trigger assign_item_number after insert on work_items
when new.number is null or new.number = 0 or new.key is null
begin
  update projects set item_seq = item_seq + 1 where id = new.project_id and (new.number is null or new.number = 0);
  update work_items
     set number = case when new.number is null or new.number = 0 then (select item_seq from projects where id = new.project_id) else new.number end,
         key    = (select key from projects where id = new.project_id) || '-' ||
                  case when new.number is null or new.number = 0 then (select item_seq from projects where id = new.project_id) else new.number end
   where rowid = new.rowid;
end;

-- Validate `fields` against item_types.field_defs (unknown keys, required, kinds).
-- Deep validation (option membership, user existence) happens in @pm/core.
create trigger work_items_validate_fields_ins before insert on work_items begin
  select raise(abort, 'unknown item type') where not exists (select 1 from item_types where id = new.type_id);
  select raise(abort, 'field "' || k.key || '" is not defined for this item type')
    from json_each(new.fields) k
   where not exists (select 1 from json_each((select field_defs from item_types where id = new.type_id)) d where json_extract(d.value, '$.key') = k.key);
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" is required')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.required') = 1 and json_extract(new.fields, '$.' || json_extract(d.value, '$.key')) is null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be an array')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where (json_extract(d.value, '$.multi') = 1 or json_extract(d.value, '$.kind') = 'multi_select')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('array', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a string')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') in ('text','long_text','select','user','url','date','datetime')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('text', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a number')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'number'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('integer', 'real', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a boolean')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'bool'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('true', 'false', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
end;
create trigger work_items_validate_fields_upd before update of fields, type_id on work_items begin
  select raise(abort, 'unknown item type') where not exists (select 1 from item_types where id = new.type_id);
  select raise(abort, 'field "' || k.key || '" is not defined for this item type')
    from json_each(new.fields) k
   where not exists (select 1 from json_each((select field_defs from item_types where id = new.type_id)) d where json_extract(d.value, '$.key') = k.key);
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" is required')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.required') = 1 and json_extract(new.fields, '$.' || json_extract(d.value, '$.key')) is null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be an array')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where (json_extract(d.value, '$.multi') = 1 or json_extract(d.value, '$.kind') = 'multi_select')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('array', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a string')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') in ('text','long_text','select','user','url','date','datetime')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('text', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a number')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'number'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('integer', 'real', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a boolean')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'bool'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('true', 'false', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
end;

-- Enforce that state belongs to the item type's workflow
create trigger work_items_validate_state_ins before insert on work_items begin
  select raise(abort, 'state does not belong to the workflow of this item type')
   where not exists (select 1 from workflow_states s join item_types t on t.workflow_id = s.workflow_id where s.id = new.state_id and t.id = new.type_id);
end;
create trigger work_items_validate_state_upd before update of state_id, type_id on work_items begin
  select raise(abort, 'state does not belong to the workflow of this item type')
   where not exists (select 1 from workflow_states s join item_types t on t.workflow_id = s.workflow_id where s.id = new.state_id and t.id = new.type_id);
end;

create table labels (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  project_id    text references projects(id) on delete cascade, -- null = firm-wide label
  name          text not null,
  color         text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create unique index labels_name_uq on labels(coalesce(project_id, ''), lower(name)) where deleted_at is null;

create table work_item_labels (
  item_id       text not null references work_items(id) on delete cascade,
  label_id      text not null references labels(id) on delete cascade,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (item_id, label_id)
);

create table comments (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  item_id       text not null references work_items(id) on delete cascade,
  author_id     text references users(id),
  body          text not null,                       -- markdown; @mentions as @[name](user:uuid)
  parent_id     text references comments(id),        -- threaded replies
  source        text not null default 'app',         -- app | email | slack | github | mcp | api
  external_ref  text check (external_ref is null or json_valid(external_ref)),  -- e.g. slack ts, email message-id
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at     text,
  deleted_at    text
);
create index comments_item_idx on comments(item_id, created_at);

create table attachments (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  item_id       text not null references work_items(id) on delete cascade,
  name          text not null,
  url           text not null,
  mime_type     text,
  size_bytes    integer,
  created_by    text references users(id),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- ----------------------------------------------------------------------------
-- 6. Relations: one typed edge table
-- ----------------------------------------------------------------------------
-- relation_types is a registry so new edge kinds are data, not migrations.
--   is_hierarchy: forms the parent/child tree (single parent, acyclic)
--   is_blocking : participates in "is blocked" computations
--   is_symmetric: A r B implies B r A (duplicates, relates_to)
create table relation_types (
  key           text primary key,
  name          text not null,          -- forward label  ("blocks")
  inverse_name  text not null,          -- inverse label  ("is blocked by")
  is_hierarchy  integer not null default 0 check (is_hierarchy in (0,1)),
  is_blocking   integer not null default 0 check (is_blocking in (0,1)),
  is_symmetric  integer not null default 0 check (is_symmetric in (0,1)),
  sort          integer not null default 0
);
insert into relation_types (key, name, inverse_name, is_hierarchy, is_blocking, is_symmetric, sort) values
  ('parent_of',  'parent of',  'child of',         1, 0, 0, 0),
  ('blocks',     'blocks',     'is blocked by',    0, 1, 0, 1),
  ('duplicates', 'duplicates', 'is duplicated by', 0, 0, 1, 2),
  ('relates_to', 'relates to', 'relates to',       0, 0, 1, 3),
  ('links_to',   'links to',   'linked from',      0, 0, 0, 4); -- external entities

-- Edge: from_item -(type)-> to_item | external entity.
-- External entities (GitHub PR, Slack thread, email, document, a row in
-- another system) live in the same table with to_item_id = null and
-- external_kind/external_ref set, so "everything connected to this item" is
-- one query.
create table relations (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  type          text not null references relation_types(key),
  from_item_id  text not null references work_items(id) on delete cascade,
  to_item_id    text references work_items(id) on delete cascade,
  external_kind text,                                   -- github_pr | github_issue | slack_thread | email | url | doc | ...
  external_ref  text check (external_ref is null or json_valid(external_ref)),  -- {"url":..., "repo":..., "number":..., "title":...}
  external_key  text generated always as (
                  case when external_kind is not null
                       then external_kind || ':' || coalesce(json_extract(external_ref, '$.id'), json_extract(external_ref, '$.url'), '')
                  end) stored,
  meta          text not null default '{}' check (json_valid(meta) and json_type(meta) = 'object'),
  created_by    text references users(id),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  check ((to_item_id is not null and external_kind is null and external_ref is null)
      or (to_item_id is null and external_kind is not null and external_ref is not null)),
  check (to_item_id is null or to_item_id <> from_item_id)
);
create unique index relations_item_edge_uq on relations(type, from_item_id, to_item_id) where to_item_id is not null and deleted_at is null;
create unique index relations_external_edge_uq on relations(type, from_item_id, external_key) where external_key is not null and deleted_at is null;
create index relations_from_idx on relations(from_item_id) where deleted_at is null;
create index relations_to_idx on relations(to_item_id) where deleted_at is null;
create index relations_external_idx on relations(external_kind, json_extract(external_ref, '$.url')) where deleted_at is null;
-- single parent in the hierarchy
create unique index relations_single_parent_uq on relations(to_item_id) where type = 'parent_of' and deleted_at is null;

-- Reject reverse duplicates of symmetric edges; prevent cycles in hierarchy and blocking graphs.
create trigger relations_no_cycle_ins before insert on relations
when new.to_item_id is not null and new.deleted_at is null
begin
  select raise(abort, 'symmetric relation already exists in the other direction')
   where (select is_symmetric from relation_types where key = new.type) = 1
     and exists (select 1 from relations r where r.type = new.type and r.from_item_id = new.to_item_id and r.to_item_id = new.from_item_id and r.deleted_at is null);
  select raise(abort, 'relation would create a cycle')
   where (select is_hierarchy = 1 or is_blocking = 1 from relation_types where key = new.type)
     and exists (
       with recursive walk(item_id, depth) as (
         select new.to_item_id, 0
         union all
         select r.to_item_id, w.depth + 1 from relations r join walk w on r.from_item_id = w.item_id
          where r.type = new.type and r.deleted_at is null and w.depth < 1000
       )
       select 1 from walk where item_id = new.from_item_id);
end;
create trigger relations_no_cycle_upd before update of from_item_id, to_item_id, type, deleted_at on relations
when new.to_item_id is not null and new.deleted_at is null
begin
  select raise(abort, 'symmetric relation already exists in the other direction')
   where (select is_symmetric from relation_types where key = new.type) = 1
     and exists (select 1 from relations r where r.type = new.type and r.from_item_id = new.to_item_id and r.to_item_id = new.from_item_id and r.deleted_at is null and r.id <> new.id);
  select raise(abort, 'relation would create a cycle')
   where (select is_hierarchy = 1 or is_blocking = 1 from relation_types where key = new.type)
     and exists (
       with recursive walk(item_id, depth) as (
         select new.to_item_id, 0
         union all
         select r.to_item_id, w.depth + 1 from relations r join walk w on r.from_item_id = w.item_id
          where r.type = new.type and r.deleted_at is null and r.id <> new.id and w.depth < 1000
       )
       select 1 from walk where item_id = new.from_item_id);
end;

-- Graph helpers (views; SQLite has no SQL functions) -------------------------
-- Direct parent of each item
create view item_parents as
  select r.to_item_id as item_id, r.from_item_id as parent_id
    from relations r where r.type = 'parent_of' and r.deleted_at is null;

-- Every (ancestor, descendant) pair with depth, through parent_of
create view item_ancestry as
  with recursive a(ancestor_id, item_id, depth) as (
    select r.from_item_id, r.to_item_id, 1 from relations r where r.type = 'parent_of' and r.deleted_at is null
    union all
    select a.ancestor_id, r.to_item_id, a.depth + 1
      from relations r join a on r.from_item_id = a.item_id
     where r.type = 'parent_of' and r.deleted_at is null and a.depth < 100
  )
  select ancestor_id, item_id, depth from a;

-- Open blockers: (blocked item, blocker) where the blocker is not done/canceled
create view open_blockers as
  select r.to_item_id as item_id, r.from_item_id as blocker_id
    from relations r
    join work_items b on b.id = r.from_item_id and b.deleted_at is null
    join workflow_states s on s.id = b.state_id
   where r.type = 'blocks' and r.deleted_at is null and s.category not in ('done', 'canceled');

-- Rollup over each subtree: counts by category + estimate sums
--   select * from item_rollups where root_id = ?
create view item_rollups as
  select a.ancestor_id as root_id,
         count(*) as total,
         sum(case when s.category = 'done' then 1 else 0 end) as done,
         sum(case when s.category = 'in_progress' then 1 else 0 end) as in_progress,
         sum(case when s.category in ('todo','backlog') then 1 else 0 end) as todo,
         sum(case when s.category = 'canceled' then 1 else 0 end) as canceled,
         coalesce(sum(w.estimate), 0) as estimate_total,
         coalesce(sum(case when s.category = 'done' then w.estimate end), 0) as estimate_done
    from item_ancestry a
    join work_items w on w.id = a.item_id and w.deleted_at is null
    join workflow_states s on s.id = w.state_id
   group by a.ancestor_id;

-- ----------------------------------------------------------------------------
-- 7. Activity log: append-only, one event per field change
-- ----------------------------------------------------------------------------
create table activity_events (
  id            integer primary key autoincrement,  -- monotonic cursor
  txn_id        text not null,                     -- groups events from one mutation (undo unit)
  entity_type   text not null,                     -- work_item | comment | relation | project | view | label | ...
  entity_id     text not null,
  item_id       text,                              -- denormalized: the work item this touches (for timelines)
  project_id    text,                              -- denormalized: for scoping/permissions
  actor_kind    text not null default 'user' check (actor_kind in ('user','api_key','integration','system','agent')),
  actor_id      text,                              -- users.id (also for api_key/agent: the owning user)
  actor_label   text,                              -- "github", "slack", api key name, agent name
  action        text not null,                     -- create | update | delete | restore | transition | relation_add | relation_remove | comment | ...
  field         text,                              -- "title", "state_id", "fields.severity", null for create/delete
  old_value     text check (old_value is null or json_valid(old_value)),   -- JSON
  new_value     text check (new_value is null or json_valid(new_value)),   -- JSON
  mutation_name text,                              -- client mutator / API op that produced it
  source        text not null default 'app',       -- app | api | mcp | slack | email | github | system
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index activity_item_idx on activity_events(item_id, id) where item_id is not null;
create index activity_project_idx on activity_events(project_id, id);
create index activity_entity_idx on activity_events(entity_type, entity_id, id);
create index activity_actor_idx on activity_events(actor_id, id);
create index activity_txn_idx on activity_events(txn_id);
create index activity_created_idx on activity_events(created_at);

-- Physically block mutation of history.
create trigger activity_events_no_update before update on activity_events begin
  select raise(abort, 'activity_events is append-only (UPDATE denied)');
end;
create trigger activity_events_no_delete before delete on activity_events begin
  select raise(abort, 'activity_events is append-only (DELETE denied)');
end;

-- ----------------------------------------------------------------------------
-- 8. Views as saved queries
-- ----------------------------------------------------------------------------
-- spec is a QuerySpec (see @pm/core/query): the SAME spec drives lists, boards,
-- timelines and dashboards, compiled to SQL on the server and evaluated as a
-- predicate on the client against local data.
--   {
--     "filter": {"and":[{"field":"project_id","op":"eq","value":"..."},
--                       {"field":"state.category","op":"nin","value":["done","canceled"]},
--                       {"field":"fields.severity","op":"in","value":["s1","s2"]}]},
--     "sort":   [{"field":"priority","dir":"asc"},{"field":"due_date","dir":"asc"}],
--     "group_by": "state_id",
--     "columns": ["key","title","assignee_id","priority","due_date","fields.severity"],
--     "board":   {"column_field":"state_id","swimlane_field":null},
--     "timeline":{"start_field":"start_date","end_field":"due_date"},
--     "dashboard":{"widgets":[{"title":"Open by assignee","viz":"bar","group_by":"assignee_id","measure":"count"}]}
--   }
create table views (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  project_id    text references projects(id) on delete cascade,  -- null = cross-project
  owner_id      text references users(id),                        -- null = system/shared default
  name          text not null,
  kind          text not null default 'list' check (kind in ('list','board','timeline','dashboard')),
  spec          text not null default '{}' check (json_valid(spec) and json_type(spec) = 'object'),
  is_shared     integer not null default 0 check (is_shared in (0,1)),   -- visible to all project members
  is_default    integer not null default 0 check (is_default in (0,1)),
  icon          text,
  sort          integer not null default 0,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create index views_project_idx on views(project_id) where deleted_at is null;
create index views_owner_idx on views(owner_id) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- 9. Watchers + notifications (low-noise by construction)
-- ----------------------------------------------------------------------------
create table item_watchers (
  item_id       text not null references work_items(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  reason        text not null check (reason in ('assignee','reporter','mention','commenter','manual')),
  muted         integer not null default 0 check (muted in (0,1)),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (item_id, user_id)
);

-- One row per (user, channel). `rules` selects which event kinds are worth a
-- ping: default = mentions + assignments + replies + state changes on items you
-- are assigned to. Everything else only appears in the activity feed.
create table notification_preferences (
  user_id       text not null references users(id) on delete cascade,
  channel       text not null check (channel in ('in_app','email','slack')),
  cadence       text not null default 'immediate' check (cadence in ('immediate','hourly','daily','off')),
  rules         text not null default '{"mention":true,"assigned":true,"reply":true,"state_change_assigned":true,"state_change_watching":false,"comment_watching":false,"due_soon":true}' check (json_valid(rules) and json_type(rules) = 'object'),
  quiet_hours   text check (quiet_hours is null or json_valid(quiet_hours)),   -- {"start":"19:00","end":"07:00","tz":"America/New_York"}
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (user_id, channel)
);

create table notifications (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id       text not null references users(id) on delete cascade,
  item_id       text references work_items(id) on delete cascade,
  event_id      integer references activity_events(id),
  kind          text not null,                -- mention | assigned | reply | state_change | due_soon | mutation_rejected | ...
  title         text not null,
  body          text,
  actor_id      text references users(id),
  read_at       text,
  archived_at   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create index notifications_user_unread_idx on notifications(user_id, created_at desc) where read_at is null and deleted_at is null;

-- Outbound deliveries (email/slack) are collapsed per (user, window)
create table notification_deliveries (
  id            integer primary key autoincrement,
  user_id       text not null references users(id) on delete cascade,
  channel       text not null check (channel in ('in_app','email','slack')),
  notification_ids text not null check (json_valid(notification_ids) and json_type(notification_ids) = 'array'),
  scheduled_for text not null,
  sent_at       text,
  error         text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index notification_deliveries_pending_idx on notification_deliveries(scheduled_for) where sent_at is null;

-- ----------------------------------------------------------------------------
-- 10. Integrations: webhooks out, inbound links
-- ----------------------------------------------------------------------------
create table webhook_endpoints (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  name          text not null,
  url           text not null,
  secret        text not null,                   -- HMAC-SHA256 of body in X-PM-Signature
  event_kinds   text not null default '["*"]' check (json_valid(event_kinds) and json_type(event_kinds) = 'array'),  -- e.g. ["item.created","comment.created"]
  project_id    text references projects(id) on delete cascade,  -- null = all projects
  is_active     integer not null default 1 check (is_active in (0,1)),
  created_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

create table webhook_deliveries (
  id            integer primary key autoincrement,
  endpoint_id   text not null references webhook_endpoints(id) on delete cascade,
  event_id      integer not null references activity_events(id),
  event_kind    text not null,
  payload       text not null check (json_valid(payload)),
  status        text not null default 'pending' check (status in ('pending','delivered','failed','dead')),
  attempts      integer not null default 0,
  next_attempt_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempt_at text,
  response_status integer,
  response_body text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index webhook_deliveries_pending_idx on webhook_deliveries(next_attempt_at) where status in ('pending','failed');

-- Integration configs: one row per kind, config validated by the integration
--   slack : {"team_id":..., "channel_map": {"RATES":"C0123"}, "notify_on": [...]}
--   github: {"repos": ["org/repo"], "autolink": true}
--   email : {"inbound_domain": "pm.example.com"}
create table integration_configs (
  kind          text primary key,                 -- slack | github | email
  config        text not null default '{}' check (json_valid(config) and json_type(config) = 'object'),
  is_active     integer not null default 0 check (is_active in (0,1)),
  updated_by    text references users(id),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Idempotency for inbound events (Slack retries, GitHub redeliveries, email dupes)
create table inbound_events (
  source        text not null,
  external_id   text not null,
  received_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (source, external_id)
);

-- ----------------------------------------------------------------------------
-- 11. Sync bookkeeping (Replicache-style push/pull)
-- ----------------------------------------------------------------------------
create table sync_client_groups (
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  resync_required integer not null default 0 check (resync_required in (0,1)),  -- set when the user's visibility changes
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table sync_clients (
  id              text primary key,
  client_group_id text not null references sync_client_groups(id) on delete cascade,
  last_mutation_id integer not null default 0,
  version         integer not null default 0,      -- global version at which last_mutation_id changed
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index sync_clients_group_idx on sync_clients(client_group_id);

-- ----------------------------------------------------------------------------
-- 12. Permissions as views (used by API + sync pull)
-- ----------------------------------------------------------------------------
-- Effective project role for every (active user, live project) pair that has
-- access: explicit membership wins; else firm owner/admin → admin; else firm
-- member on a firm-visible project → editor; guests only via membership.
create view effective_roles as
  select user_id, project_id, role from (
    select u.id as user_id, p.id as project_id,
           coalesce(pm.role,
                    case when u.firm_role in ('owner','admin') then 'admin'
                         when u.firm_role = 'member' and p.visibility = 'firm' then 'editor'
                    end) as role
      from users u
      cross join projects p
      left join project_members pm on pm.user_id = u.id and pm.project_id = p.id and pm.deleted_at is null
     where u.deleted_at is null and u.is_active = 1 and p.deleted_at is null
  ) where role is not null;

-- Items each user may see: project access + the confidential rule.
--   exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id)
create view visible_items as
  select er.user_id, w.id as item_id
    from work_items w
    join effective_roles er on er.project_id = w.project_id
   where w.deleted_at is null
     and (w.confidential = 0
          or w.assignee_id = er.user_id or w.reporter_id = er.user_id or w.created_by = er.user_id
          or er.role = 'admin');

-- ----------------------------------------------------------------------------
-- 13. Firm-level settings
-- ----------------------------------------------------------------------------
create table settings (
  key           text primary key,
  value         text not null check (json_valid(value)),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
insert into settings(key, value) values
  ('firm', '{"name":"The Firm","item_key_prefix_style":"project"}'),
  ('sync', '{"strategy":"global_version"}');

-- ----------------------------------------------------------------------------
-- 14. Sync version + updated_at triggers for every synced table
-- ----------------------------------------------------------------------------
-- Insert: stamp version with the next global value.
-- Update: when the statement did not itself change `version` (i.e. an
-- application write, not our own stamp), bump the counter, stamp the row and
-- refresh updated_at. recursive_triggers is off by default, so the stamping
-- UPDATE cannot re-fire the same trigger.
create trigger users_version_ins after insert on users begin
  update sync_state set version = version + 1 where id = 1;
  update users set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger users_version_upd after update on users when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update users set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger teams_version_ins after insert on teams begin
  update sync_state set version = version + 1 where id = 1;
  update teams set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger teams_version_upd after update on teams when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update teams set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger workflows_version_ins after insert on workflows begin
  update sync_state set version = version + 1 where id = 1;
  update workflows set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger workflows_version_upd after update on workflows when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update workflows set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger workflow_states_version_ins after insert on workflow_states begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_states set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger workflow_states_version_upd after update on workflow_states when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_states set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger workflow_transitions_version_ins after insert on workflow_transitions begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_transitions set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger workflow_transitions_version_upd after update on workflow_transitions when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_transitions set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger item_types_version_ins after insert on item_types begin
  update sync_state set version = version + 1 where id = 1;
  update item_types set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger item_types_version_upd after update on item_types when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update item_types set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger projects_version_ins after insert on projects begin
  update sync_state set version = version + 1 where id = 1;
  update projects set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger projects_version_upd after update on projects when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update projects set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger project_members_version_ins after insert on project_members begin
  update sync_state set version = version + 1 where id = 1;
  update project_members set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger project_members_version_upd after update on project_members when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update project_members set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger work_items_version_ins after insert on work_items begin
  update sync_state set version = version + 1 where id = 1;
  update work_items set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger work_items_version_upd after update on work_items when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update work_items set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger labels_version_ins after insert on labels begin
  update sync_state set version = version + 1 where id = 1;
  update labels set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger labels_version_upd after update on labels when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update labels set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger work_item_labels_version_ins after insert on work_item_labels begin
  update sync_state set version = version + 1 where id = 1;
  update work_item_labels set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger work_item_labels_version_upd after update on work_item_labels when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update work_item_labels set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger comments_version_ins after insert on comments begin
  update sync_state set version = version + 1 where id = 1;
  update comments set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger comments_version_upd after update on comments when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update comments set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger attachments_version_ins after insert on attachments begin
  update sync_state set version = version + 1 where id = 1;
  update attachments set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger attachments_version_upd after update on attachments when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update attachments set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger relations_version_ins after insert on relations begin
  update sync_state set version = version + 1 where id = 1;
  update relations set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger relations_version_upd after update on relations when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update relations set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger views_version_ins after insert on views begin
  update sync_state set version = version + 1 where id = 1;
  update views set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger views_version_upd after update on views when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update views set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger item_watchers_version_ins after insert on item_watchers begin
  update sync_state set version = version + 1 where id = 1;
  update item_watchers set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger item_watchers_version_upd after update on item_watchers when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update item_watchers set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger notification_preferences_version_ins after insert on notification_preferences begin
  update sync_state set version = version + 1 where id = 1;
  update notification_preferences set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger notification_preferences_version_upd after update on notification_preferences when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update notification_preferences set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger notifications_version_ins after insert on notifications begin
  update sync_state set version = version + 1 where id = 1;
  update notifications set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger notifications_version_upd after update on notifications when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update notifications set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

-- ----------------------------------------------------------------------------
-- 15. Default workflows + item types (fixed ids so the schema is usable at once)
-- ----------------------------------------------------------------------------
insert into workflows(id, key, name, description) values
  ('00000000-0000-4000-8000-000000000a01', 'standard', 'Standard', 'Backlog → Todo → In Progress → In Review → Done'),
  ('00000000-0000-4000-8000-000000000a02', 'simple',   'Simple',   'Todo → Doing → Done');

insert into workflow_states(id, workflow_id, key, name, category, color, sort, is_initial) values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000a01', 'backlog',     'Backlog',     'backlog',     '#9ca3af', 0, 0),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-000000000a01', 'todo',        'Todo',        'todo',        '#60a5fa', 1, 1),
  ('00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-000000000a01', 'in_progress', 'In Progress', 'in_progress', '#f59e0b', 2, 0),
  ('00000000-0000-4000-8000-000000000b04', '00000000-0000-4000-8000-000000000a01', 'in_review',   'In Review',   'in_progress', '#a78bfa', 3, 0),
  ('00000000-0000-4000-8000-000000000b05', '00000000-0000-4000-8000-000000000a01', 'done',        'Done',        'done',        '#10b981', 4, 0),
  ('00000000-0000-4000-8000-000000000b06', '00000000-0000-4000-8000-000000000a01', 'canceled',    'Canceled',    'canceled',    '#6b7280', 5, 0),
  ('00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000a02', 'todo',        'Todo',        'todo',        '#60a5fa', 0, 1),
  ('00000000-0000-4000-8000-000000000b12', '00000000-0000-4000-8000-000000000a02', 'doing',       'Doing',       'in_progress', '#f59e0b', 1, 0),
  ('00000000-0000-4000-8000-000000000b13', '00000000-0000-4000-8000-000000000a02', 'done',        'Done',        'done',        '#10b981', 2, 0),
  ('00000000-0000-4000-8000-000000000b14', '00000000-0000-4000-8000-000000000a02', 'canceled',    'Canceled',    'canceled',    '#6b7280', 3, 0);

insert into workflow_transitions(id, workflow_id, key, name, from_state_id, to_state_id, guards, effects, sort) values
  ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000a01', 'triage',   'Triage',          '00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000b02', '[]', '[]', 0),
  ('00000000-0000-4000-8000-000000000c02', '00000000-0000-4000-8000-000000000a01', 'start',    'Start',           null,                                   '00000000-0000-4000-8000-000000000b03',
     '[{"type":"require_field","field":"assignee_id"},{"type":"no_open_blockers"}]',
     '[{"type":"set_field","field":"start_date","value":"$today","only_if_null":true}]', 1),
  ('00000000-0000-4000-8000-000000000c03', '00000000-0000-4000-8000-000000000a01', 'review',   'Send to review',  '00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-000000000b04', '[]', '[{"type":"notify","audience":["watchers"],"template":"review_requested"}]', 2),
  ('00000000-0000-4000-8000-000000000c04', '00000000-0000-4000-8000-000000000a01', 'reopen',   'Reopen',          '00000000-0000-4000-8000-000000000b04', '00000000-0000-4000-8000-000000000b03', '[]', '[]', 3),
  ('00000000-0000-4000-8000-000000000c05', '00000000-0000-4000-8000-000000000a01', 'complete', 'Complete',        null,                                   '00000000-0000-4000-8000-000000000b05',
     '[{"type":"children_in_category","categories":["done","canceled"]}]',
     '[{"type":"set_field","field":"completed_at","value":"$now"},{"type":"webhook","event":"item.completed"}]', 4),
  ('00000000-0000-4000-8000-000000000c06', '00000000-0000-4000-8000-000000000a01', 'cancel',   'Cancel',          null,                                   '00000000-0000-4000-8000-000000000b06',
     '[{"type":"require_role","roles":["admin","editor"]}]',
     '[{"type":"set_field","field":"canceled_at","value":"$now"}]', 5),
  ('00000000-0000-4000-8000-000000000c07', '00000000-0000-4000-8000-000000000a01', 'restore',  'Restore',         '00000000-0000-4000-8000-000000000b06', '00000000-0000-4000-8000-000000000b02', '[]', '[{"type":"set_field","field":"canceled_at","value":null}]', 6),
  ('00000000-0000-4000-8000-000000000c08', '00000000-0000-4000-8000-000000000a01', 'backlog',  'Back to backlog', null,                                   '00000000-0000-4000-8000-000000000b01', '[]', '[{"type":"set_field","field":"completed_at","value":null}]', 7),
  ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000a02', 'start',    'Start',           null, '00000000-0000-4000-8000-000000000b12', '[]', '[]', 0),
  ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000a02', 'complete', 'Complete',        null, '00000000-0000-4000-8000-000000000b13', '[]', '[{"type":"set_field","field":"completed_at","value":"$now"}]', 1),
  ('00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000a02', 'cancel',   'Cancel',          null, '00000000-0000-4000-8000-000000000b14', '[]', '[{"type":"set_field","field":"canceled_at","value":"$now"}]', 2),
  ('00000000-0000-4000-8000-000000000c14', '00000000-0000-4000-8000-000000000a02', 'reopen',   'Reopen',          null, '00000000-0000-4000-8000-000000000b11', '[]', '[{"type":"set_field","field":"completed_at","value":null},{"type":"set_field","field":"canceled_at","value":null}]', 3);

insert into item_types(id, key, name, plural_name, icon, color, workflow_id, is_container, sort, field_defs) values
  ('00000000-0000-4000-8000-000000000d01', 'task', 'Task', 'Tasks', 'check-square', '#60a5fa', '00000000-0000-4000-8000-000000000a01', 0, 0, '[]'),
  ('00000000-0000-4000-8000-000000000d02', 'bug',  'Bug',  'Bugs',  'bug', '#ef4444', '00000000-0000-4000-8000-000000000a01', 0, 1,
    '[{"key":"severity","label":"Severity","kind":"select","required":true,
       "options":[{"value":"s1","label":"S1 – Critical"},{"value":"s2","label":"S2 – High"},{"value":"s3","label":"S3 – Medium"},{"value":"s4","label":"S4 – Low"}]},
      {"key":"environment","label":"Environment","kind":"select",
       "options":[{"value":"prod","label":"Production"},{"value":"uat","label":"UAT"},{"value":"dev","label":"Dev"}]},
      {"key":"steps","label":"Steps to reproduce","kind":"long_text"}]'),
  ('00000000-0000-4000-8000-000000000d03', 'initiative', 'Initiative', 'Initiatives', 'flag', '#a78bfa', '00000000-0000-4000-8000-000000000a01', 1, 2,
    '[{"key":"owner_desk","label":"Owning desk","kind":"text"},
      {"key":"business_case","label":"Business case","kind":"long_text"},
      {"key":"budget","label":"Budget (USD)","kind":"number"},
      {"key":"quarter","label":"Target quarter","kind":"select",
       "options":[{"value":"2026Q4","label":"2026 Q4"},{"value":"2027Q1","label":"2027 Q1"},{"value":"2027Q2","label":"2027 Q2"}]}]'),
  ('00000000-0000-4000-8000-000000000d04', 'request', 'Request', 'Requests', 'inbox', '#f59e0b', '00000000-0000-4000-8000-000000000a02', 0, 3,
    '[{"key":"requester_desk","label":"Requesting desk","kind":"text"},
      {"key":"urgency","label":"Urgency","kind":"select",
       "options":[{"value":"today","label":"Today"},{"value":"this_week","label":"This week"},{"value":"whenever","label":"Whenever"}]},
      {"key":"approved","label":"Approved","kind":"bool"}]');

-- ----------------------------------------------------------------------------
-- 16. Convenience view: items with resolved display columns
-- ----------------------------------------------------------------------------
-- label_names is a JSON array; is_blocked is 0/1.
create view work_items_v as
select w.*,
       t.key  as type_key, t.name as type_name,
       s.key  as state_key, s.name as state_name, s.category as state_category,
       p.key  as project_key, p.name as project_name,
       a.name as assignee_name,
       (select json_group_array(name) from (select l.name from work_item_labels wl join labels l on l.id = wl.label_id where wl.item_id = w.id and wl.deleted_at is null and l.deleted_at is null order by l.name)) as label_names,
       (select r.from_item_id from relations r where r.to_item_id = w.id and r.type = 'parent_of' and r.deleted_at is null) as parent_id,
       exists(select 1 from open_blockers ob where ob.item_id = w.id) as is_blocked
from work_items w
join item_types t on t.id = w.type_id
join workflow_states s on s.id = w.state_id
join projects p on p.id = w.project_id
left join users a on a.id = w.assignee_id;
```

---

## 5. Core contract files — `packages/core/src/…` (verbatim)

These five files are the shared contract. Create them exactly; then implement
the stubs listed in §5.6 against them.

### 5.1 `packages/core/src/schema/entities.ts`

```ts
// ============================================================================
// Entity types mirroring packages/db/migrations/0001_init.sql
// These are the canonical row shapes shared by API, web (local store), MCP.
// Keep column names identical to the SQL (snake_case) so sync is a straight copy.
// ============================================================================
import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD
export const isoDateTime = z.string(); // ISO 8601 timestamptz

export const FirmRole = z.enum(['owner', 'admin', 'member', 'guest']);
export type FirmRole = z.infer<typeof FirmRole>;
export const ProjectRole = z.enum(['admin', 'editor', 'viewer']);
export type ProjectRole = z.infer<typeof ProjectRole>;
export const ProjectVisibility = z.enum(['firm', 'private']);
export type ProjectVisibility = z.infer<typeof ProjectVisibility>;
export const ProjectStatus = z.enum(['planned', 'active', 'paused', 'completed', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;
export const StateCategory = z.enum(['backlog', 'todo', 'in_progress', 'done', 'canceled']);
export type StateCategory = z.infer<typeof StateCategory>;
export const ViewKind = z.enum(['list', 'board', 'timeline', 'dashboard']);
export type ViewKind = z.infer<typeof ViewKind>;
export const ActorKind = z.enum(['user', 'api_key', 'integration', 'system', 'agent']);
export type ActorKind = z.infer<typeof ActorKind>;
export const WatchReason = z.enum(['assignee', 'reporter', 'mention', 'commenter', 'manual']);
export type WatchReason = z.infer<typeof WatchReason>;
export const NotifyChannel = z.enum(['in_app', 'email', 'slack']);
export type NotifyChannel = z.infer<typeof NotifyChannel>;
export const NotifyCadence = z.enum(['immediate', 'hourly', 'daily', 'off']);
export type NotifyCadence = z.infer<typeof NotifyCadence>;

/** Common sync columns present on every synced row */
const synced = {
  version: z.number().int(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  deleted_at: isoDateTime.nullable(),
};

export const User = z.object({
  id: uuid,
  email: z.string().email(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  firm_role: FirmRole,
  is_active: z.boolean(),
  is_service: z.boolean(),
  settings: z.record(z.unknown()),
  ...synced,
});
export type User = z.infer<typeof User>;

export const Team = z.object({
  id: uuid, key: z.string(), name: z.string(), description: z.string().nullable(), ...synced,
});
export type Team = z.infer<typeof Team>;

export const Workflow = z.object({
  id: uuid, key: z.string(), name: z.string(), description: z.string().nullable(), ...synced,
});
export type Workflow = z.infer<typeof Workflow>;

export const WorkflowState = z.object({
  id: uuid,
  workflow_id: uuid,
  key: z.string(),
  name: z.string(),
  category: StateCategory,
  color: z.string().nullable(),
  sort: z.number().int(),
  is_initial: z.boolean(),
  ...synced,
});
export type WorkflowState = z.infer<typeof WorkflowState>;

// ---- Guards & effects (stored as JSON in workflow_transitions) -------------
export const Guard = z.discriminatedUnion('type', [
  z.object({ type: z.literal('require_field'), field: z.string() }),           // field must be non-null/non-empty
  z.object({ type: z.literal('field_equals'), field: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('field_in'), field: z.string(), values: z.array(z.unknown()) }),
  z.object({ type: z.literal('no_open_blockers') }),
  z.object({ type: z.literal('children_in_category'), categories: z.array(StateCategory) }), // all children in one of these
  z.object({ type: z.literal('require_role'), roles: z.array(ProjectRole) }),
  z.object({ type: z.literal('require_assignee_is_actor') }),
  z.object({ type: z.literal('require_label'), label: z.string() }),
]);
export type Guard = z.infer<typeof Guard>;

export const Effect = z.discriminatedUnion('type', [
  // value may be a literal or a macro: "$now" | "$today" | "$actor" | null
  z.object({ type: z.literal('set_field'), field: z.string(), value: z.unknown(), only_if_null: z.boolean().optional() }),
  z.object({ type: z.literal('notify'), audience: z.array(z.enum(['watchers', 'assignee', 'reporter', 'project_admins'])), template: z.string() }),
  z.object({ type: z.literal('webhook'), event: z.string() }),
  z.object({ type: z.literal('add_label'), label: z.string() }),
  z.object({ type: z.literal('remove_label'), label: z.string() }),
  z.object({ type: z.literal('transition_parent_if'), all_children_category: z.array(StateCategory), to: z.string() }), // to = state key
  z.object({ type: z.literal('transition_children'), to: z.string() }),
]);
export type Effect = z.infer<typeof Effect>;

export const WorkflowTransition = z.object({
  id: uuid,
  workflow_id: uuid,
  key: z.string(),
  name: z.string(),
  from_state_id: uuid.nullable(), // null = from any state
  to_state_id: uuid,
  guards: z.array(Guard),
  effects: z.array(Effect),
  sort: z.number().int(),
  ...synced,
});
export type WorkflowTransition = z.infer<typeof WorkflowTransition>;

// ---- Item type field registry ----------------------------------------------
export const FieldKind = z.enum(['text', 'long_text', 'number', 'bool', 'date', 'datetime', 'select', 'multi_select', 'user', 'url']);
export type FieldKind = z.infer<typeof FieldKind>;

export const FieldDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  kind: FieldKind,
  required: z.boolean().optional(),
  multi: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string(), color: z.string().optional() })).optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  show_in_list: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const ItemType = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  plural_name: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  workflow_id: uuid,
  field_defs: z.array(FieldDef),
  is_container: z.boolean(),
  sort: z.number().int(),
  is_active: z.boolean(),
  ...synced,
});
export type ItemType = z.infer<typeof ItemType>;

export const Project = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatus,
  visibility: ProjectVisibility,
  lead_id: uuid.nullable(),
  team_id: uuid.nullable(),
  item_seq: z.number().int(),
  default_type_id: uuid.nullable(),
  allowed_type_ids: z.array(uuid).nullable(),
  settings: z.record(z.unknown()),
  start_date: isoDate.nullable(),
  target_date: isoDate.nullable(),
  archived_at: isoDateTime.nullable(),
  ...synced,
});
export type Project = z.infer<typeof Project>;

export const ProjectMember = z.object({
  project_id: uuid, user_id: uuid, role: ProjectRole, ...synced,
});
export type ProjectMember = z.infer<typeof ProjectMember>;

export const WorkItem = z.object({
  id: uuid,
  project_id: uuid,
  type_id: uuid,
  number: z.number().int(),
  key: z.string(),
  title: z.string().min(1).max(500),
  description: z.string(),
  state_id: uuid,
  priority: z.number().int().min(0).max(4), // 0 none, 1 urgent, 2 high, 3 medium, 4 low
  assignee_id: uuid.nullable(),
  reporter_id: uuid.nullable(),
  start_date: isoDate.nullable(),
  due_date: isoDate.nullable(),
  estimate: z.number().nullable(),
  fields: z.record(z.unknown()),
  confidential: z.boolean(),
  sort_order: z.number(),
  created_by: uuid.nullable(),
  completed_at: isoDateTime.nullable(),
  canceled_at: isoDateTime.nullable(),
  archived_at: isoDateTime.nullable(),
  ...synced,
});
export type WorkItem = z.infer<typeof WorkItem>;

export const Label = z.object({
  id: uuid, project_id: uuid.nullable(), name: z.string(), color: z.string().nullable(), ...synced,
});
export type Label = z.infer<typeof Label>;

export const WorkItemLabel = z.object({ item_id: uuid, label_id: uuid, ...synced });
export type WorkItemLabel = z.infer<typeof WorkItemLabel>;

export const Comment = z.object({
  id: uuid,
  item_id: uuid,
  author_id: uuid.nullable(),
  body: z.string(),
  parent_id: uuid.nullable(),
  source: z.string(),
  external_ref: z.record(z.unknown()).nullable(),
  edited_at: isoDateTime.nullable(),
  ...synced,
});
export type Comment = z.infer<typeof Comment>;

export const RelationTypeKey = z.enum(['parent_of', 'blocks', 'duplicates', 'relates_to', 'links_to']);
export type RelationTypeKey = z.infer<typeof RelationTypeKey>;

export const Relation = z.object({
  id: uuid,
  type: z.string(), // RelationTypeKey or custom registered key
  from_item_id: uuid,
  to_item_id: uuid.nullable(),
  external_kind: z.string().nullable(),
  external_ref: z.record(z.unknown()).nullable(),
  external_key: z.string().nullable(),
  meta: z.record(z.unknown()),
  created_by: uuid.nullable(),
  ...synced,
});
export type Relation = z.infer<typeof Relation>;

export const ActivityEvent = z.object({
  id: z.number().int(),
  txn_id: uuid,
  entity_type: z.string(),
  entity_id: uuid,
  item_id: uuid.nullable(),
  project_id: uuid.nullable(),
  actor_kind: ActorKind,
  actor_id: uuid.nullable(),
  actor_label: z.string().nullable(),
  action: z.string(),
  field: z.string().nullable(),
  old_value: z.unknown(),
  new_value: z.unknown(),
  mutation_name: z.string().nullable(),
  source: z.string(),
  created_at: isoDateTime,
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const View = z.object({
  id: uuid,
  project_id: uuid.nullable(),
  owner_id: uuid.nullable(),
  name: z.string(),
  kind: ViewKind,
  spec: z.record(z.unknown()), // validated as ViewSpec in query/spec.ts
  is_shared: z.boolean(),
  is_default: z.boolean(),
  icon: z.string().nullable(),
  sort: z.number().int(),
  ...synced,
});
export type View = z.infer<typeof View>;

export const ItemWatcher = z.object({ item_id: uuid, user_id: uuid, reason: WatchReason, muted: z.boolean(), ...synced });
export type ItemWatcher = z.infer<typeof ItemWatcher>;

export const Notification = z.object({
  id: uuid,
  user_id: uuid,
  item_id: uuid.nullable(),
  event_id: z.number().int().nullable(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  actor_id: uuid.nullable(),
  read_at: isoDateTime.nullable(),
  archived_at: isoDateTime.nullable(),
  ...synced,
});
export type Notification = z.infer<typeof Notification>;

export const NotificationPreference = z.object({
  user_id: uuid, channel: NotifyChannel, cadence: NotifyCadence,
  rules: z.record(z.boolean()), quiet_hours: z.record(z.unknown()).nullable(), ...synced,
});
export type NotificationPreference = z.infer<typeof NotificationPreference>;

/** Names of tables that are synced to clients (and their primary keys). */
export const SYNCED_TABLES = {
  users: ['id'],
  teams: ['id'],
  workflows: ['id'],
  workflow_states: ['id'],
  workflow_transitions: ['id'],
  item_types: ['id'],
  projects: ['id'],
  project_members: ['project_id', 'user_id'],
  work_items: ['id'],
  labels: ['id'],
  work_item_labels: ['item_id', 'label_id'],
  comments: ['id'],
  relations: ['id'],
  views: ['id'],
  item_watchers: ['item_id', 'user_id'],
  notifications: ['id'],
  notification_preferences: ['user_id', 'channel'],
} as const;
export type SyncedTable = keyof typeof SYNCED_TABLES;

/** Key in the client KV store for a row: `<table>/<pk1>[/<pk2>]` */
export function rowKey(table: SyncedTable, row: Record<string, unknown>): string {
  const pks = SYNCED_TABLES[table] as readonly string[];
  return `${table}/${pks.map((k) => String(row[k])).join('/')}`;
}

export const PRIORITY_LABELS: Record<number, string> = { 0: 'None', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
```

### 5.2 `packages/core/src/query/spec.ts`

```ts
// ============================================================================
// QuerySpec: the ONE composable query layer.
// Lists, boards, timelines, dashboards, the API `/items/query` endpoint, MCP
// `search_items`, saved views, and the command palette all speak this spec.
//   - Server: compileQuery(spec) -> parameterized SQL  (query/compile.ts)
//   - Client: matchesSpec(spec, item, ctx) -> boolean, sortItems, groupItems
//             over the local synced store  (query/evaluate.ts)
// ============================================================================
import { z } from 'zod';
import { StateCategory, ViewKind } from '../schema/entities.js';

/**
 * Field references. Dotted paths resolve through joins/lookups:
 *   "title" | "state_id" | "priority" | "assignee_id" | "due_date" ...  (work_items columns)
 *   "state.category" | "state.key"       (via workflow_states)
 *   "type.key"                           (via item_types)
 *   "project.key"                        (via projects)
 *   "fields.<key>"                       (JSON type-specific field)
 *   "labels"                             (array of label ids; ops: has / has_any / has_all / is_empty)
 *   "parent_id"                          (derived from relations parent_of)
 *   "is_blocked"                         (derived: has open blockers)
 *   "search"                             (full text; op: match)
 */
export const FieldRef = z.string().regex(/^[a-z_]+(\.[a-z0-9_]+)?$/);
export type FieldRef = z.infer<typeof FieldRef>;

export const FilterOp = z.enum([
  'eq', 'neq', 'in', 'nin', 'lt', 'lte', 'gt', 'gte',
  'contains', 'starts_with',           // text
  'is_null', 'not_null', 'is_empty', 'not_empty',
  'has', 'has_any', 'has_all',         // arrays (labels, multi_select fields)
  'match',                             // full-text search (field = "search")
  'before', 'after', 'within_days',    // dates; value may be a macro
]);
export type FilterOp = z.infer<typeof FilterOp>;

/**
 * Value macros resolved at evaluation time (both server and client):
 *   "$me"          current user id
 *   "$today"       YYYY-MM-DD in ctx.tz
 *   "$now"         ISO timestamp
 *   "$start_of_week" / "$end_of_week" / "$start_of_month"
 */
export const ValueMacro = z.enum(['$me', '$today', '$now', '$start_of_week', '$end_of_week', '$start_of_month']);
export type ValueMacro = z.infer<typeof ValueMacro>;

export type FilterExpr =
  | { field: FieldRef; op: FilterOp; value?: unknown }
  | { and: FilterExpr[] }
  | { or: FilterExpr[] }
  | { not: FilterExpr };

export const FilterExpr: z.ZodType<FilterExpr> = z.lazy(() =>
  z.union([
    z.object({ field: FieldRef, op: FilterOp, value: z.unknown().optional() }),
    z.object({ and: z.array(FilterExpr) }),
    z.object({ or: z.array(FilterExpr) }),
    z.object({ not: FilterExpr }),
  ]),
);

export const SortSpec = z.object({ field: FieldRef, dir: z.enum(['asc', 'desc']).default('asc'), nulls: z.enum(['first', 'last']).optional() });
export type SortSpec = z.infer<typeof SortSpec>;

export const Measure = z.enum(['count', 'sum_estimate', 'avg_estimate', 'sum_field', 'avg_field']);

/** The core query: what rows, in what order, grouped how. */
export const QuerySpec = z.object({
  filter: FilterExpr.optional(),
  sort: z.array(SortSpec).optional(),
  group_by: FieldRef.nullable().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().nonnegative().optional(),
  include_archived: z.boolean().optional(),
});
export type QuerySpec = z.infer<typeof QuerySpec>;

/** Dashboard widget: a QuerySpec + a visualization over it. */
export const Widget = z.object({
  id: z.string(),
  title: z.string(),
  viz: z.enum(['number', 'bar', 'pie', 'line', 'table', 'list']),
  query: QuerySpec,                   // filter scope for the widget
  group_by: FieldRef.optional(),      // for bar/pie/line
  measure: Measure.default('count'),
  measure_field: FieldRef.optional(), // for sum_field/avg_field
  time_bucket: z.enum(['day', 'week', 'month']).optional(), // for line charts on date fields
  w: z.number().int().min(1).max(12).default(4),
  h: z.number().int().min(1).max(12).default(3),
});
export type Widget = z.infer<typeof Widget>;

/** views.spec — kind-specific presentation on top of the same QuerySpec. */
export const ViewSpec = QuerySpec.extend({
  kind: ViewKind.optional(),
  columns: z.array(FieldRef).optional(),                 // list
  board: z.object({
    column_field: FieldRef.default('state_id'),
    swimlane_field: FieldRef.nullable().optional(),
    column_order: z.array(z.string()).optional(),
    hide_empty: z.boolean().optional(),
  }).optional(),
  timeline: z.object({
    start_field: FieldRef.default('start_date'),
    end_field: FieldRef.default('due_date'),
    zoom: z.enum(['week', 'month', 'quarter']).default('month'),
    show_dependencies: z.boolean().optional(),
  }).optional(),
  dashboard: z.object({ widgets: z.array(Widget) }).optional(),
});
export type ViewSpec = z.infer<typeof ViewSpec>;

/** Context needed to resolve macros and permission scope. */
export interface QueryContext {
  userId: string;
  tz?: string;            // IANA, default UTC
  now?: Date;             // injectable for tests
  /** Project ids the user may see; server fills from visible_project_ids(). Client: all local. */
  visibleProjectIds?: string[] | 'all';
}

/** Result of compiling a QuerySpec to SQL (server side). */
export interface CompiledQuery {
  text: string;            // SELECT ... FROM work_items_v w ... WHERE ... ORDER BY ... LIMIT ...
  values: unknown[];       // positional `?` params, in order (plain SQLite scalars)
  /** For group_by queries: SELECT <group>, count(*), ... */
  isAggregate: boolean;
}

/** Fields that sort/filter can target, with their storage kind (used by compiler + UI pickers). */
export const BUILTIN_FIELDS: Record<string, { kind: 'text' | 'number' | 'bool' | 'date' | 'datetime' | 'uuid' | 'enum' | 'array' | 'fts'; label: string; sortable: boolean }> = {
  id: { kind: 'uuid', label: 'Id', sortable: false },
  key: { kind: 'text', label: 'Key', sortable: true },
  number: { kind: 'number', label: 'Number', sortable: true },
  title: { kind: 'text', label: 'Title', sortable: true },
  description: { kind: 'text', label: 'Description', sortable: false },
  project_id: { kind: 'uuid', label: 'Project', sortable: true },
  type_id: { kind: 'uuid', label: 'Type', sortable: true },
  state_id: { kind: 'uuid', label: 'State', sortable: true },
  priority: { kind: 'number', label: 'Priority', sortable: true },
  assignee_id: { kind: 'uuid', label: 'Assignee', sortable: true },
  reporter_id: { kind: 'uuid', label: 'Reporter', sortable: true },
  created_by: { kind: 'uuid', label: 'Created by', sortable: true },
  start_date: { kind: 'date', label: 'Start date', sortable: true },
  due_date: { kind: 'date', label: 'Due date', sortable: true },
  estimate: { kind: 'number', label: 'Estimate', sortable: true },
  confidential: { kind: 'bool', label: 'Confidential', sortable: true },
  sort_order: { kind: 'number', label: 'Manual order', sortable: true },
  created_at: { kind: 'datetime', label: 'Created', sortable: true },
  updated_at: { kind: 'datetime', label: 'Updated', sortable: true },
  completed_at: { kind: 'datetime', label: 'Completed', sortable: true },
  canceled_at: { kind: 'datetime', label: 'Canceled', sortable: true },
  archived_at: { kind: 'datetime', label: 'Archived', sortable: true },
  'state.category': { kind: 'enum', label: 'State category', sortable: true },
  'state.key': { kind: 'text', label: 'State key', sortable: true },
  'type.key': { kind: 'text', label: 'Type key', sortable: true },
  'project.key': { kind: 'text', label: 'Project key', sortable: true },
  labels: { kind: 'array', label: 'Labels', sortable: false },
  parent_id: { kind: 'uuid', label: 'Parent', sortable: true },
  is_blocked: { kind: 'bool', label: 'Blocked', sortable: true },
  search: { kind: 'fts', label: 'Search', sortable: false },
};

export const STATE_CATEGORY_ORDER: StateCategory[] = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
```

### 5.3 `packages/core/src/mutations.ts`

```ts
// ============================================================================
// Mutations: the single write vocabulary shared by the web client (optimistic,
// via Replicache mutators), the API (REST maps onto these), and MCP tools.
// Each mutation is validated with zod here; the server is the authority.
// ============================================================================
import { z } from 'zod';
import { uuid, isoDate, FieldDef, Guard, Effect, StateCategory, ProjectRole, ProjectVisibility, ProjectStatus, ViewKind } from './schema/entities.js';
import { ViewSpec } from './query/spec.js';

export const ItemPatch = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  type_id: uuid.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignee_id: uuid.nullable().optional(),
  reporter_id: uuid.nullable().optional(),
  start_date: isoDate.nullable().optional(),
  due_date: isoDate.nullable().optional(),
  estimate: z.number().nullable().optional(),
  fields: z.record(z.unknown()).optional(),     // merged (shallow) into existing fields
  confidential: z.boolean().optional(),
  sort_order: z.number().optional(),
  archived_at: z.string().nullable().optional(),
});
export type ItemPatch = z.infer<typeof ItemPatch>;

export const MutationArgs = {
  createItem: z.object({
    id: uuid,                                    // client-generated so optimistic UI has a stable id
    project_id: uuid,
    type_id: uuid,
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    state_id: uuid.optional(),                  // default: workflow initial state
    priority: z.number().int().min(0).max(4).optional(),
    assignee_id: uuid.nullable().optional(),
    start_date: isoDate.nullable().optional(),
    due_date: isoDate.nullable().optional(),
    estimate: z.number().nullable().optional(),
    fields: z.record(z.unknown()).optional(),
    label_ids: z.array(uuid).optional(),
    parent_id: uuid.nullable().optional(),
    confidential: z.boolean().optional(),
  }),
  updateItem: z.object({ id: uuid, patch: ItemPatch }),
  /** Bulk edit: same patch applied to many items in one txn (one activity txn_id). */
  bulkUpdateItems: z.object({ ids: z.array(uuid).min(1).max(500), patch: ItemPatch }),
  /** Explicit state machine transition (server enforces guards + runs effects). */
  transitionItem: z.object({ id: uuid, transition_key: z.string(), comment: z.string().optional() }),
  bulkTransitionItems: z.object({ ids: z.array(uuid).min(1).max(500), transition_key: z.string() }),
  deleteItem: z.object({ id: uuid }),            // soft delete
  restoreItem: z.object({ id: uuid }),
  moveItem: z.object({ id: uuid, project_id: uuid }),
  reorderItem: z.object({ id: uuid, sort_order: z.number() }),

  addLabel: z.object({ item_id: uuid, label_id: uuid }),
  removeLabel: z.object({ item_id: uuid, label_id: uuid }),
  createLabel: z.object({ id: uuid, project_id: uuid.nullable(), name: z.string().min(1), color: z.string().nullable().optional() }),

  addRelation: z.object({
    id: uuid,
    type: z.string(),
    from_item_id: uuid,
    to_item_id: uuid.nullable().optional(),
    external_kind: z.string().nullable().optional(),
    external_ref: z.record(z.unknown()).nullable().optional(),
  }),
  removeRelation: z.object({ id: uuid }),
  setParent: z.object({ id: uuid, parent_id: uuid.nullable() }),

  addComment: z.object({ id: uuid, item_id: uuid, body: z.string().min(1), parent_id: uuid.nullable().optional() }),
  editComment: z.object({ id: uuid, body: z.string().min(1) }),
  deleteComment: z.object({ id: uuid }),

  watchItem: z.object({ item_id: uuid }),
  unwatchItem: z.object({ item_id: uuid }),
  markNotificationRead: z.object({ id: uuid }),
  markAllNotificationsRead: z.object({}),

  createView: z.object({ id: uuid, project_id: uuid.nullable(), name: z.string().min(1), kind: ViewKind, spec: ViewSpec, is_shared: z.boolean().optional(), icon: z.string().nullable().optional() }),
  updateView: z.object({ id: uuid, patch: z.object({ name: z.string().min(1).optional(), kind: ViewKind.optional(), spec: ViewSpec.optional(), is_shared: z.boolean().optional(), is_default: z.boolean().optional(), icon: z.string().nullable().optional(), sort: z.number().int().optional() }) }),
  deleteView: z.object({ id: uuid }),

  createProject: z.object({ id: uuid, key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), name: z.string().min(1), description: z.string().optional(), visibility: ProjectVisibility.optional(), lead_id: uuid.nullable().optional(), team_id: uuid.nullable().optional() }),
  updateProject: z.object({ id: uuid, patch: z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional(), status: ProjectStatus.optional(), visibility: ProjectVisibility.optional(), lead_id: uuid.nullable().optional(), team_id: uuid.nullable().optional(), default_type_id: uuid.nullable().optional(), allowed_type_ids: z.array(uuid).nullable().optional(), start_date: isoDate.nullable().optional(), target_date: isoDate.nullable().optional(), settings: z.record(z.unknown()).optional() }) }),
  setProjectMember: z.object({ project_id: uuid, user_id: uuid, role: ProjectRole }),
  removeProjectMember: z.object({ project_id: uuid, user_id: uuid }),

  // Admin: workflows & types are data
  upsertItemType: z.object({ id: uuid, key: z.string(), name: z.string(), plural_name: z.string().nullable().optional(), icon: z.string().nullable().optional(), color: z.string().nullable().optional(), description: z.string().nullable().optional(), workflow_id: uuid, field_defs: z.array(FieldDef), is_container: z.boolean().optional(), sort: z.number().int().optional(), is_active: z.boolean().optional() }),
  upsertWorkflow: z.object({
    id: uuid, key: z.string(), name: z.string(), description: z.string().nullable().optional(),
    states: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), category: StateCategory, color: z.string().nullable().optional(), sort: z.number().int(), is_initial: z.boolean() })),
    transitions: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), from_state_id: uuid.nullable(), to_state_id: uuid, guards: z.array(Guard), effects: z.array(Effect), sort: z.number().int() })),
  }),
  updateNotificationPreference: z.object({ channel: z.enum(['in_app', 'email', 'slack']), cadence: z.enum(['immediate', 'hourly', 'daily', 'off']).optional(), rules: z.record(z.boolean()).optional(), quiet_hours: z.record(z.unknown()).nullable().optional() }),
} as const;

export type MutationName = keyof typeof MutationArgs;
export type MutationArgsOf<N extends MutationName> = z.infer<(typeof MutationArgs)[N]>;
export type Mutation = { [N in MutationName]: { name: N; args: MutationArgsOf<N> } }[MutationName];

export const MUTATION_NAMES = Object.keys(MutationArgs) as MutationName[];

export function parseMutation(name: string, args: unknown): Mutation {
  if (!(name in MutationArgs)) throw new Error(`unknown mutation: ${name}`);
  const schema = MutationArgs[name as MutationName];
  return { name, args: schema.parse(args) } as Mutation;
}

/** Replicache wire format for a push request (client -> server). */
export const PushRequest = z.object({
  pushVersion: z.literal(1),
  clientGroupID: z.string(),
  profileID: z.string().optional(),
  schemaVersion: z.string().optional(),
  mutations: z.array(z.object({ id: z.number().int(), clientID: z.string(), name: z.string(), args: z.unknown(), timestamp: z.number().optional() })),
});
export type PushRequest = z.infer<typeof PushRequest>;

/** Replicache wire format for a pull request (client -> server). */
export const PullRequest = z.object({
  pullVersion: z.literal(1),
  clientGroupID: z.string(),
  cookie: z.union([z.number(), z.string(), z.null(), z.object({ version: z.number(), order: z.number().optional() })]).optional(),
  profileID: z.string().optional(),
  schemaVersion: z.string().optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export type PatchOp =
  | { op: 'clear' }
  | { op: 'put'; key: string; value: unknown }
  | { op: 'del'; key: string };

export interface PullResponse {
  cookie: number;
  lastMutationIDChanges: Record<string, number>;
  patch: PatchOp[];
}
```

### 5.4 `packages/core/src/workflow/types.ts`

```ts
// ============================================================================
// Workflow engine contract. Implementation in ./engine.ts (pure; no I/O).
// The same evaluator runs on the client (to show/disable transition buttons
// instantly) and on the server (authoritative, before committing).
// ============================================================================
import type { WorkItem, WorkflowState, WorkflowTransition, ProjectRole, StateCategory, Guard, Effect } from '../schema/entities.js';

export interface WorkflowDefinition {
  id: string;
  key: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

/** Everything a guard may need; the caller (server/client) loads it. */
export interface GuardContext {
  actorId: string;
  actorRole: ProjectRole | null;           // effective role in the item's project
  now: Date;
  openBlockerCount: number;                // from item_open_blockers()
  childrenCategories: StateCategory[];     // categories of direct children
  labelNames: string[];
}

export interface GuardFailure { guard: Guard; reason: string }

export interface TransitionResult {
  ok: boolean;
  transition: WorkflowTransition;
  toState: WorkflowState;
  failures: GuardFailure[];
  /** Field patch to apply to the item (state_id + set_field effects). */
  patch: Partial<WorkItem>;
  /** Effects the caller must execute with I/O (notify, webhook, parent/children transitions, labels). */
  deferredEffects: Effect[];
}

export interface WorkflowEngine {
  /** Transitions available from the item's current state (guards NOT evaluated). */
  availableTransitions(def: WorkflowDefinition, item: Pick<WorkItem, 'state_id'>): WorkflowTransition[];
  /** Evaluate guards and compute the patch/effects for one transition. */
  evaluate(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): TransitionResult;
  /** Shortcut used by the client to grey out buttons. */
  canTransition(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): boolean;
  initialState(def: WorkflowDefinition): WorkflowState;
  /** Validate a workflow definition: one initial state, transitions reference known states, keys unique, every state reachable. */
  validateDefinition(def: WorkflowDefinition): string[];
}
```

### 5.5 `packages/core/src/permissions/types.ts`

```ts
// ============================================================================
// Permissions contract. DECISION: per-project roles (RBAC) + firm role +
// project visibility. One pure function decides everything; the DB mirrors it
// in the effective_roles/visible_items views for sync-pull scoping.
// Attribute-style conditions belong in workflow guards, not here.
// ============================================================================
import type { FirmRole, ProjectRole, ProjectVisibility } from '../schema/entities.js';

export type Action =
  | 'project.view' | 'project.edit' | 'project.admin' | 'project.create'
  | 'item.view' | 'item.create' | 'item.edit' | 'item.delete' | 'item.transition' | 'item.bulk_edit'
  | 'comment.create' | 'comment.edit_own' | 'comment.edit_any' | 'comment.delete_any'
  | 'relation.edit'
  | 'view.create' | 'view.edit_own' | 'view.edit_shared'
  | 'label.manage'
  | 'workflow.manage' | 'type.manage' | 'webhook.manage' | 'integration.manage' | 'user.manage'
  | 'activity.view' | 'export';

export interface Actor {
  id: string;
  firmRole: FirmRole;
  /** project_id -> explicit membership role */
  memberships: Record<string, ProjectRole>;
  isService?: boolean;
  /** API key scopes; undefined for session users */
  scopes?: string[];
  /** users.is_active; undefined is treated as active */
  isActive?: boolean;
}

export interface ProjectCtx { id: string; visibility: ProjectVisibility; }

export interface ItemCtx {
  project: ProjectCtx;
  confidential: boolean;
  assignee_id: string | null;
  reporter_id: string | null;
  created_by: string | null;
}

export interface Resource {
  project?: ProjectCtx;
  item?: ItemCtx;
  ownerId?: string;        // for *_own actions (comment author, view owner)
}

export interface PermissionEvaluator {
  effectiveRole(actor: Actor, project: ProjectCtx): ProjectRole | null;
  can(actor: Actor, action: Action, resource?: Resource): boolean;
  /** Throws a PermissionError with a helpful message. */
  assert(actor: Actor, action: Action, resource?: Resource): void;
}

export class PermissionError extends Error {
  readonly status = 403;
  constructor(public readonly action: Action, message?: string) {
    super(message ?? `permission denied: ${action}`);
    this.name = 'PermissionError';
  }
}

/** Role lattice: viewer < editor < admin */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** Minimum project role required per action (firm owner/admin always pass; null = firm-level action) */
export const ACTION_MIN_ROLE: Record<Action, ProjectRole | 'firm_admin' | 'any_user'> = {
  'project.view': 'viewer',
  'project.edit': 'admin',
  'project.admin': 'admin',
  'project.create': 'any_user',
  'item.view': 'viewer',
  'item.create': 'editor',
  'item.edit': 'editor',
  'item.delete': 'editor',
  'item.transition': 'editor',
  'item.bulk_edit': 'editor',
  'comment.create': 'viewer',
  'comment.edit_own': 'viewer',
  'comment.edit_any': 'admin',
  'comment.delete_any': 'admin',
  'relation.edit': 'editor',
  'view.create': 'viewer',
  'view.edit_own': 'viewer',
  'view.edit_shared': 'editor',
  'label.manage': 'editor',
  'workflow.manage': 'firm_admin',
  'type.manage': 'firm_admin',
  'webhook.manage': 'firm_admin',
  'integration.manage': 'firm_admin',
  'user.manage': 'firm_admin',
  'activity.view': 'viewer',
  'export': 'viewer',
};
```

### 5.6 Implementation signatures you must provide (same package)

`packages/core/src/index.ts`:

```ts
export * from './schema/entities.js';
export * from './query/spec.js';
export * from './mutations.js';
export * from './workflow/types.js';
export * from './permissions/types.js';
export * from './query/compile.js';
export * from './query/evaluate.js';
export * from './workflow/engine.js';
export * from './permissions/evaluate.js';
export * from './fields.js';
export * from './events.js';
```

`packages/core/src/query/compile.ts` (server-side SQL compiler):

```ts
import type { QuerySpec, QueryContext, CompiledQuery, Widget } from './spec.js';
import type { FieldDef } from '../schema/entities.js';

export interface CompileOptions {
  /** Base relation; default "work_items_v w" (has state_category, type_key, label ids etc.) */
  from?: string;
  /** Field defs by item type key, to encode JSON fields (fields.<key>) correctly */
  fieldDefs?: Record<string, FieldDef[]>;
  /** Extra WHERE fragments already parameterized (`?` placeholders), e.g. permission scope. */
  extraWhere?: { text: string; values: unknown[] }[];
  select?: string; // default "w.*"
}
/** Compile a QuerySpec to parameterized SQLite SQL over work_items_v (`?` placeholders, values in order). */
export function compileQuery(spec: QuerySpec, ctx: QueryContext, opts?: CompileOptions): CompiledQuery;
/** Compile a dashboard widget into an aggregate query (group_by + measure; time buckets in UTC via strftime, weeks start Monday). */
export function compileWidget(widget: Widget, ctx: QueryContext, opts?: CompileOptions): CompiledQuery;
/** Permission-scope WHERE fragment: exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id). */
export function visibilityWhere(userId: string): { text: string; values: unknown[] };
```

SQL shapes the compiler must emit: `fields.<key>` → `json_extract(w.fields, '$.<key>')`
(multi kinds via `json_each`); `labels` → `exists (select 1 from work_item_labels …)`;
`search match` → a join on `w.id` against the FTS hit set
`(select id, bm25(work_items_fts, 10.0, 5.0, 1.0) as rank from work_items_fts where work_items_fts match ?)`,
deduplicated by `id` (the FTS table can hold two entries per item, see the
migration's trigger order) and ordered by `rank`; `contains`/`starts_with` →
`like` with escaped patterns; booleans bound as 0/1; `nin` keeps NULL rows.
FTS5 auxiliary functions (`bm25`, `snippet`) are only legal in the query that
holds the `MATCH`, so compute them in a `with hits as materialized (…)` CTE
and aggregate outside it.

`packages/core/src/query/evaluate.ts` (client-side evaluator):

```ts
import type { FilterExpr, QuerySpec, QueryContext, SortSpec, FieldRef, ValueMacro } from './spec.js';
import type { WorkItem, WorkflowState, ItemType, Project } from '../schema/entities.js';

/** A work item joined with what the client has locally. Same shape the server's work_items_v exposes. */
export interface ItemRow extends WorkItem {
  state_category?: string; state_key?: string; type_key?: string; project_key?: string;
  label_ids?: string[]; parent_id?: string | null; is_blocked?: boolean;
}
/** Lookup tables the client passes so dotted fields resolve without joins. */
export interface EvalLookups {
  states: Record<string, WorkflowState>;
  types: Record<string, ItemType>;
  projects: Record<string, Project>;
  labelIdsByItem?: Record<string, string[]>;
  parentByItem?: Record<string, string>;
  blockedItems?: Set<string>;
}
export function resolveMacro(value: unknown, ctx: QueryContext): unknown;
export function getField(item: ItemRow, field: FieldRef, lookups: EvalLookups): unknown;
export function matchesFilter(expr: FilterExpr | undefined, item: ItemRow, ctx: QueryContext, lookups: EvalLookups): boolean;
export function matchesSpec(spec: QuerySpec, item: ItemRow, ctx: QueryContext, lookups: EvalLookups): boolean;
export function sortItems(items: ItemRow[], sort: SortSpec[] | undefined, lookups: EvalLookups): ItemRow[];
export function groupItems(items: ItemRow[], groupBy: FieldRef | null | undefined, lookups: EvalLookups): { key: string; label: string; items: ItemRow[] }[];
/** Run a full spec over local rows: filter + sort + group + limit. */
export function runSpec(spec: QuerySpec, items: ItemRow[], ctx: QueryContext, lookups: EvalLookups): { items: ItemRow[]; groups: { key: string; label: string; items: ItemRow[] }[] | null };
export const VALUE_MACROS: ValueMacro[];
```

`packages/core/src/workflow/engine.ts`: `export const workflowEngine:
WorkflowEngine` implementing every method of the interface in §5.4. Macros in
`set_field` values: `$now` → `ctx.now.toISOString()`, `$today` → `YYYY-MM-DD`
of `ctx.now`, `$actor` → `ctx.actorId`, `null` → null. `only_if_null` skips the
set when the current value is non-null. Guard failure reasons must be
human-readable (e.g. `"assignee_id is required"`, `"2 open blockers"`,
`"requires role admin or editor"`).

`packages/core/src/permissions/evaluate.ts`: `export const permissions:
PermissionEvaluator` implementing `effectiveRole` (explicit membership →
firm owner/admin = admin → firm member on `firm`-visible project = editor →
null), `can` (uses `ACTION_MIN_ROLE`, `ROLE_RANK`; `firm_admin` actions need
`firmRole ∈ {owner, admin}`; `any_user` needs an active, non-guest user for
`project.create`; `*_own` actions need `resource.ownerId === actor.id`;
`item.view` and item-level actions additionally apply the confidential rule:
non-admins must be assignee, reporter or creator; `isActive === false` → false
for everything) and `assert` (throws `PermissionError`).

`packages/core/src/fields.ts`:

```ts
/** Build a zod object schema for work_items.fields from an item type's field_defs (strict: unknown keys rejected). */
export function fieldsSchemaFor(defs: FieldDef[]): z.ZodTypeAny;
/** Validate + coerce a fields object; returns {ok, value|errors}. */
export function validateFields(defs: FieldDef[], fields: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; errors: { field: string; message: string }[] };
/** Human label for a field ref, given type defs (e.g. "fields.severity" -> "Severity"). */
export function fieldLabel(field: string, defs?: FieldDef[]): string;
```

Rules: `select` values must be one of `options[].value`; `multi_select` and
`multi: true` are arrays; `number` honours `min`/`max`; `date` is
`YYYY-MM-DD`; `datetime` is ISO 8601; `user` is a UUID; `url` is a URL;
`required` keys must be present and non-null; unknown keys are errors;
`default` is applied when the key is absent; light coercion (numeric strings →
numbers, `'true'/'false'` → booleans).

`packages/core/src/events.ts`:

```ts
export const EVENT_KINDS = [
  'item.created', 'item.updated', 'item.transitioned', 'item.completed', 'item.deleted', 'item.restored',
  'comment.created', 'comment.updated', 'comment.deleted',
  'relation.added', 'relation.removed',
  'project.created', 'project.updated',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
/** Fields of work_items that are tracked one-event-per-field in the activity log (JSON fields are tracked per key as "fields.<key>"). */
export const TRACKED_ITEM_FIELDS: (keyof WorkItem)[] = [
  'title', 'description', 'type_id', 'state_id', 'priority', 'assignee_id', 'reporter_id', 'start_date', 'due_date',
  'estimate', 'confidential', 'archived_at', 'project_id', 'sort_order',
];
export type FieldChange = { field: string; old: unknown; new: unknown };
/** Diff two item snapshots into one change per field (JSON fields expanded to "fields.<key>"). */
export function diffItem(before: Partial<WorkItem>, after: Partial<WorkItem>): FieldChange[];
/** Map an activity event to the webhook event kind it represents (or null if internal). */
export function eventKindOf(e: Pick<ActivityEvent, 'entity_type' | 'action' | 'field'>): EventKind | null;
/** Extract @mentions of the form @[Name](user:<uuid>) from markdown. */
export function extractMentions(markdown: string): string[];
/** Extract item keys like RATES-12 from free text (used by Slack/GitHub/email autolinking). */
export function extractItemKeys(text: string): string[];
```

---

## 6. Integrations contract — `packages/integrations/src/deps.ts` (verbatim)

```ts
// ============================================================================
// Contract between @pm/api (which owns the database, auth and mutations) and
// @pm/integrations (Slack / GitHub / email). The API implements IntegrationDeps
// in packages/api/src/integrations.ts and calls registerIntegrationRoutes().
// @pm/integrations must not import a database driver; it only uses these deps.
// ============================================================================
import type { Actor, Mutation } from '@pm/core';

export interface ItemSummary {
  id: string;
  key: string;            // "RATES-12"
  title: string;
  description: string;
  type_key: string;
  project_id: string;
  project_key: string;
  state_name: string;
  state_category: string;
  priority: number;
  assignee_name: string | null;
  assignee_id: string | null;
  due_date: string | null;
  url: string;            // deep link into the web app
}

export interface IntegrationConfig {
  appUrl: string;
  apiUrl: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  githubWebhookSecret?: string;
  githubToken?: string;
  emailFrom: string;
  smtpUrl?: string;
  /** e.g. "pm.example.com" → inbound addresses pm+RATES-12@pm.example.com */
  inboundDomain?: string;
}

export interface IntegrationDeps {
  config: IntegrationConfig;
  /** Row from integration_configs (admin-editable JSON), or null when unset. */
  getIntegrationConfig(kind: 'slack' | 'github' | 'email'): Promise<{ config: Record<string, unknown>; is_active: boolean } | null>;
  findItemByKey(key: string): Promise<ItemSummary | null>;
  findProjectByKey(key: string): Promise<{ id: string; key: string; name: string; default_type_id: string | null } | null>;
  /** Map an external identity to a user (email for email/GitHub-noreply, Slack user id via users.settings.slack_user_id). */
  resolveUserByEmail(email: string): Promise<{ id: string; name: string; email: string } | null>;
  resolveUserBySlackId(slackUserId: string): Promise<{ id: string; name: string; email: string } | null>;
  /** Actor to use for writes done by an integration on behalf of nobody in particular (a service user). */
  systemActor(label: 'slack' | 'github' | 'email'): Promise<Actor>;
  /** Actor for a resolved user. */
  actorForUser(userId: string): Promise<Actor>;
  /** Run one mutation from the shared vocabulary; throws on validation/permission/guard failure. Returns the affected row when applicable. */
  runMutation(actor: Actor, mutation: Mutation, meta: { source: 'slack' | 'github' | 'email'; actorLabel: string }): Promise<unknown>;
  /** Idempotency guard for inbound events. Returns false if (source, externalId) was already seen. */
  recordInbound(source: string, externalId: string): Promise<boolean>;
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

/** Message rendered for an outbound notification (email + Slack share the same model). */
export interface OutboundNotification {
  kind: string;             // mention | assigned | reply | state_change | comment | due_soon | digest
  title: string;
  body: string | null;
  item: ItemSummary | null;
  actorName: string | null;
  createdAt: string;
}
```

`packages/integrations/src/index.ts` must export exactly (see §3, "Integrations
contract"):

```ts
export type { IntegrationDeps, IntegrationConfig, ItemSummary, OutboundNotification } from './deps.js';
export function registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationDeps): Promise<void>; // mounts /integrations/*
export function sendSlackMessage(deps: IntegrationDeps, msg: { channel: string; text: string; blocks?: unknown[] }): Promise<void>;
export function sendEmail(deps: IntegrationDeps, msg: { to: string; subject: string; text: string; html?: string }): Promise<void>;
export function renderNotification(n: OutboundNotification): { subject: string; text: string; html: string; slackBlocks: unknown[] };
export function renderDigest(items: OutboundNotification[]): { subject: string; text: string; html: string; slackBlocks: unknown[] };
// Also export the pure helpers so they can be unit-tested:
export function verifySlackSignature(signingSecret: string, timestamp: string, rawBody: string, signature: string): boolean;
export function verifyGithubSignature(secret: string, rawBody: string, signature256: string): boolean;
export function parseInboundAddress(to: string, inboundDomain?: string): { kind: 'item'; key: string } | { kind: 'project'; key: string } | null;
export function parseSlashCommand(text: string): { cmd: 'create'; title: string } | { cmd: 'find'; q: string } | { cmd: 'mine' } | { cmd: 'item'; key: string } | { cmd: 'help' };
```

---

## 7. Build plan with acceptance criteria

Each phase ends with its tests green and a commit.

### Phase 0 — Scaffold

* Create the root files from §2, the per-package `package.json`, `tsconfig.json`
  and `vitest.config.ts` files, `docs/ARCHITECTURE.md` from §3, and empty
  `src/` directories. `pnpm install` succeeds.
* `git init`, first commit.

### Phase 1 — `@pm/db`

Files: `migrations/0001_init.sql` (§4, verbatim), `src/sqlite.ts` (the
runtime layer), `src/client.ts`, `src/migrate.ts`, `src/seed.ts`,
`src/reset.ts`, `src/index.ts` (re-exports everything below plus
`connect()`, `databaseUrl()`, `databasePath()`), `src/*.test.ts`. The package
depends on nothing but `node:sqlite` (and `tsx` to run scripts).

* `sqlite.ts`: `openDb(pathOrUrl?, opts?)` resolves the path
  (`resolveDbPath`: `:memory:`, `sqlite:`/`file:` prefixes, absolute, or
  relative to the repo root found via `pnpm-workspace.yaml`; default
  `./data/pmtool.db`; creates the directory), opens a `DatabaseSync`, sets
  `pragma busy_timeout = 5000`, `journal_mode = WAL` (file databases),
  `foreign_keys = ON`, `synchronous = NORMAL`, registers SQL functions
  `now()`, `uuid()`, `gen_random_uuid()`, `today()`, and returns a `Sql`:
  a tagged template (`sql\`select … where id = ${id}\``) that compiles to
  `?` placeholders, is thenable (returns hydrated rows) and has sync
  accessors `.all()`, `.get()`, `.run()`; `sql(list)` → `(?, ?, ?)`
  (empty → `(null)`); `sql.raw(text)`, `sql.unsafe(text, params)`,
  `sql.json(v)`; nested fragments splice with their params. Params:
  booleans → 0/1, objects/arrays → JSON text, `Date` → ISO, `undefined` →
  null. Rows: `hydrateRow` parses `JSON_COLUMNS` (and `*_json` aliases) and
  turns 0/1 in `BOOLEAN_COLUMNS` (and `is_*`) into booleans; export
  `registerJsonColumns`/`registerBooleanColumns`. Transactions:
  `sql.begin(fn)` = `BEGIN IMMEDIATE` behind an async mutex, statements in
  the same async context (AsyncLocalStorage) join it, nested `begin` →
  `SAVEPOINT`; `sql.snapshot(fn)` = `BEGIN DEFERRED`; `sql.savepoint(fn)`;
  `sql.exec(text)` for multi-statement scripts; `sql.nextVersion()` /
  `sql.currentVersion()` on `sync_state`; `sql.inTransaction`, `sql.path`,
  `sql.db`, `sql.close()`. `sqliteErrorKind(e)` → `'unique' | 'check' |
  'foreign_key' | 'not_null' | 'trigger' | 'busy' | 'other'` from the
  extended errcode (2067, 275, 787, 1299, 1811, 5/6).
* `migrate.ts`: `runMigrations(sql, { dir?, log? })` creates
  `schema_migrations(name text primary key, applied_at text)` if missing;
  inside one `sql.begin`, if no migration is recorded but `work_items`
  exists, records the first file as **adopted** (schema applied out of band
  with `sqlite3`); then applies every `migrations/*.sql` not yet recorded in
  filename order with `tx.exec(text)` and records it. Returns
  `{ applied, skipped, adopted }`. The CLI (`tsx src/migrate.ts`) prints the
  database path and the summary; exits non-zero on error.
* `reset.ts`: `reset(url?)` refuses unless `isLocalDatabaseUrl(url)` (a
  plain file path or `:memory:`; never a URL) and the CLI was given `--yes`;
  deletes the file and its `-wal`/`-shm` siblings, then migrates and seeds.
* `seed.ts`: `seed(sql, { force?, now?, log? })` implements §8 through the
  `sql` tag inside one `sql.begin` (it may import nothing from other
  packages). Idempotent: returns `null` when any user exists unless `force`.
  Remember `RETURNING` shows `number`/`key`/`version` before the triggers
  run: read rows back when the seed needs keys.

**Tests (`src/*.test.ts`; each opens `openDb(':memory:')` or a file under
`os.tmpdir()` and runs `runMigrations`):**

1. Migration applies on an empty database without error; running
   `runMigrations` twice is a no-op (`skipped` lists it); a database created
   with `sql.exec(readFileSync('0001_init.sql'))` is **adopted** on the first
   run.
2. `insert into work_items` without `number` yields `number = 1`, `key =
   'RATES-1'` when read back; the second item gets `RATES-2`;
   `projects.item_seq` is 2; `RETURNING` returned null for both.
3. Field validation triggers: unknown key rejected (`sqliteErrorKind` =
   `'trigger'`, message names the field); missing required `severity` on a
   `bug` rejected; wrong type (`severity: 1`) rejected; a valid bug inserts.
4. State validation triggers: a `task` with a `simple`-workflow state is
   rejected.
5. Relations: self-edge rejected (`check`); duplicate (type, from, to)
   rejected (`unique`); second parent rejected (unique index); `blocks`
   cycle A→B→C→A rejected with `relation would create a cycle`;
   `parent_of` cycle rejected; `relates_to` reverse duplicate rejected with
   the symmetric message; external edge requires `external_kind` +
   `external_ref` and forbids `to_item_id`; `external_key` is generated as
   `github_pr:<url>`.
6. Views: `item_ancestry` depths; `open_blockers` ignores done/canceled
   blockers and deleted items; `item_rollups` counts and estimate sums.
7. `activity_events`: UPDATE and DELETE each raise the append-only message.
8. `effective_roles` matrix: explicit member row wins over firm role; firm
   owner/admin → admin everywhere; member on firm project → editor; member
   on private project → no row; guest without row → no row; deleted
   membership ignored. `visible_items`: confidential visible to admin,
   assignee, reporter, creator; not to another editor.
9. Version triggers: `version` strictly increases across inserts/updates on
   two different tables and equals `sync_state.version` after each;
   `updated_at` changes on update.
10. `work_items_v` exposes `type_key`, `state_category`, `project_key`,
    `assignee_name`, `label_names` (hydrated to an array), `parent_id`,
    `is_blocked` (hydrated to a boolean).
11. `work_items_fts`: a title word matches with `match`, ranking puts a key
    hit first, an update re-indexes, a delete removes the row.
12. Runtime: `sql(list)` renders `(?, ?)`; booleans bind as 0/1 and read
    back as booleans; JSON columns round-trip; nested `begin` is a savepoint
    that rolls back alone; two concurrent `begin` calls serialise;
    `snapshot` sees a consistent state while a `begin` is pending.
13. Seed: after `seed()`, counts match §8 and every seeded view's `spec`
    parses with `ViewSpec` (import from `@pm/core` **in the test only**);
    `seed()` again returns `null`; `seed(sql, { force: true })` reseeds.

### Phase 2 — `@pm/core`

Files per §5. Pure: no Node-only imports, no I/O (the parity test is the only
file that touches a database, an in-memory SQLite opened through `@pm/db`
as a dev dependency, and it lives in `src/query/parity.test.ts`).

**Tests:**

* `schema/entities.test.ts`: every zod entity parses a fixture row shaped
  like the SQL; `rowKey('project_members', row)` = `project_members/<p>/<u>`.
* `fields.test.ts`: all rules in §5.6 (required, unknown key, select
  membership, multi arrays, number min/max, date/datetime formats, user uuid,
  url, default, coercion); `fieldLabel('fields.severity', defs)` = `Severity`;
  `fieldLabel('due_date')` = `Due date`.
* `workflow/engine.test.ts` on the seeded `standard` definition: `initialState`
  = todo; `availableTransitions` from `in_review` = review-specific ones plus
  all `from_state_id = null`; `evaluate('start')` fails with
  `require_field` when no assignee and with `no_open_blockers` when
  `openBlockerCount > 0`, passes otherwise and patches `state_id` and
  `start_date` (`only_if_null` respected); `complete` fails when a child is
  `in_progress`; `cancel` fails for `viewer`; `set_field` macros (`$now`,
  `$today`, `$actor`, null); `deferredEffects` contains `notify`/`webhook`
  but not `set_field`; `validateDefinition` reports: no initial state, two
  initial states, unknown state reference, duplicate transition key,
  unreachable state; `canTransition` mirrors `evaluate().ok`.
* `permissions/evaluate.test.ts`: the full matrix of §5.6 (`effectiveRole`
  for every firm role × visibility × membership; `can` for every `Action` at
  each role; confidential rule; `*_own`; `firm_admin`; inactive user; `assert`
  throws `PermissionError` with `status 403`).
* `query/compile.test.ts`: for every `FilterOp` on a representative field the
  SQL text contains the expected fragment and `values` are positional `?`
  placeholders in order, no string interpolation of values; `fields.<key>`
  → `json_extract` (multi kinds → `json_each`); `labels has` → `EXISTS`;
  `search match` → `work_items_fts match` with `bm25` ordering; macros
  resolved; `sort` with `nulls`; `group_by` → `isAggregate`; `extraWhere`
  appended (`visibilityWhere` → `exists (select 1 from visible_items …)`);
  `limit/offset`; `include_archived`; `compileWidget` for each
  `Measure`/`time_bucket` (UTC `strftime`, weeks start Monday).
* `query/evaluate.test.ts`: every op against in-memory rows, dotted refs via
  lookups, macros with injected `now` and `tz`, sort stability and nulls,
  grouping labels (state name, assignee id, field option label).
* `query/parity.test.ts` (**SQL ↔ local parity**): load a fixture of ≥ 30
  items across 2 projects, 3 types, labels, parent/blocks relations and
  varied dates/fields into `openDb(':memory:')` with §4 applied; define ≥ 40
  specs covering every op, dotted refs, macros, `and/or/not` nesting, sorts
  with nulls and `group_by`; for each spec assert `compileQuery` executed
  against SQLite and `runSpec` over the same (hydrated) rows return
  **identical ordered id lists** and identical group keys.
* `events.test.ts`: `diffItem` yields one change per changed tracked field
  and `fields.<key>` entries, ignores unchanged and absent fields, treats
  `undefined` and `null` as equal; `eventKindOf` maps `work_item/create` →
  `item.created`, `update` with `field = state_id` → `item.transitioned`,
  `comment/create` → `comment.created`, `relation/relation_add` →
  `relation.added`, unknown → null; `extractMentions` finds
  `@[Bob](user:<uuid>)` uniquely; `extractItemKeys('see RATES-12 and ops-3
  and RATES-12')` = `['RATES-12']`.
* `mutations.test.ts`: `parseMutation` accepts every name with a valid
  payload and rejects unknown names and bad args; `PushRequest`/`PullRequest`
  parse Replicache wire samples.

### Phase 3 — `@pm/api`

Fastify 5 server implementing every route of §3 "HTTP API v1", the sync
protocol, auth, the mutation pipeline, workers and search.

Structure (suggested): `src/server.ts` (boot), `src/app.ts` (`buildApp(opts)`
returns a Fastify instance without listening — tests use `app.inject`),
`src/db.ts` (opens the database with `openDb(DATABASE_URL)` from `@pm/db`;
`withTxn(fn)` = `sql.begin(fn)`, i.e. `BEGIN IMMEDIATE`), `src/auth.ts`
(cookie + bearer → `Actor`), `src/mutations/apply.ts` (`applyMutation(tx,
actor, mutation, meta)` implementing the 8 steps of §3 "Mutations"),
`src/mutations/<name>.ts` one per mutation, `src/activity.ts` (diff → rows),
`src/notify.ts` (rules, collapsing, deliveries), `src/webhooks.ts` (enqueue +
dispatcher loop), `src/sync/{push,pull,poke}.ts`, `src/routes/*.ts`,
`src/search.ts`, `src/integrations.ts` (implements `IntegrationDeps`),
`src/workers/{webhooks,notifications,due_soon}.ts`.

Binding behaviours:

* Error shape and codes exactly as §3; zod errors → 400 `validation` with
  `details.issues`; `PermissionError` → 403 `forbidden`; guard failures →
  409 `guard_failed` with `details.failures`; `sqliteErrorKind(e)` =
  `'trigger'` (RAISE from a validation trigger), `'check'` or `'not_null'`
  → 400 `validation` with the SQLite message; `'unique'` → 409 `conflict`;
  `'busy'` → retry once, then 503; unknown key/uuid → 404 `not_found`.
* Transactions are short and never span network I/O: workers claim due rows
  in one `sql.begin` (`update … set status = 'sending' where id in (select …
  limit N) returning *`), do the HTTP/SMTP call outside it, and record the
  outcome in another. Read-only multi-statement work (pull, export) runs in
  `sql.snapshot`.
* Auth: `pm_session` cookie (httpOnly, signed with `APP_SECRET`; a row in
  `sessions`) or `Authorization: Bearer pm_<key>` (`sha256` lookup in
  `api_keys`, respects `revoked_at`/`expires_at`, updates `last_used_at`).
  `AUTH_MODE=dev` enables `/auth/dev-login`; first user ever becomes firm
  `owner`. Magic link: token row in `sessions` with short expiry, link
  logged when `SMTP_URL` is unset.
* `applyMutation`: steps 1–8 of §3; one `activity_events` row per changed
  field (`diffItem`), same `txn_id`; `source` from meta; `actor_kind` from the
  credential (`user` for sessions, `api_key` for keys, `agent` when the key
  name starts with `agent:` or the request carries `X-PM-Actor-Kind: agent`
  — choose one and document it; `integration` for Slack/GitHub/email service
  actors).
* `transitionItem`: `GuardContext` from SQL (`open_blockers`, children
  categories via `item_parents`, labels, the role from `effective_roles`), then
  `workflowEngine.evaluate`, patch, effects (`notify`, `webhook`,
  `add_label`, `remove_label`, `transition_parent_if`, `transition_children`
  — recursive, same `txn_id`).
* Watchers: upsert `item_watchers` for assignee (`assignee`), reporter
  (`reporter`), commenter (`commenter`), mentioned users (`mention`);
  `watchItem`/`unwatchItem` use `manual` and tombstone.
* Notifications: table in §3 "Notifications"; never the actor; collapse
  unread per (user, item, kind) by updating `body`/`updated_at`; create
  `notification_deliveries` for `email`/`slack` channels per `cadence` and
  `quiet_hours`; `mutation_rejected` always in-app.
* Webhooks: enqueue per matching endpoint (`event_kinds` contains the kind or
  `*`; `project_id` null or equal); coalesce one delivery per (endpoint,
  item, txn); dispatcher loop every 5 s with the backoff schedule 1m → 5m →
  30m → 2h → 12h → `dead`; headers `X-PM-Event`, `X-PM-Delivery`,
  `X-PM-Signature: sha256=<hmac>`; body as §3.
* Sync: push/pull/poke exactly as §3 "Sync protocol": push per mutation in
  `sql.begin` with `version = sql.nextVersion()`; pull inside `sql.snapshot`
  with `cookie = sync_state.version` read in that snapshot. KV keys via
  `rowKey()`. Visibility per table as listed. `resync_required` set on
  membership change, project visibility change, item `confidential` change,
  `moveItem`.
* Search: `work_items_fts match ?` (sanitise the user's words into FTS5
  syntax; quote tokens that contain punctuation) ranked by
  `bm25(work_items_fts, 10.0, 5.0, 1.0)` with a `snippet()` excerpt; when it
  returns nothing, fall back to `w.key like ? or w.title like ?` ordered by
  `updated_at desc`; visibility applied in both.
* `GET /api/v1/items`: query params build a `QuerySpec`; `cursor` is opaque
  base64 of `(sort value, id)`; `assignee=me` → `$me`.
* `GET /api/v1/export/items.csv`: streaming CSV of `work_items_v` columns plus
  flattened `fields.*` keys, visibility-filtered.
* Due-soon scheduler: every 10 minutes, `due_soon` notifications for items
  with `due_date = today + 1` not already notified (dedupe via existing
  unread row).
* CORS: `APP_URL` only, credentials true. Rate limit: 600/min per credential,
  60/min on `/auth/*`.

**Tests (`test/*.test.ts`, vitest, a temporary SQLite file or `:memory:`
per suite with the migration applied, `buildApp()` + `app.inject`):**

1. `GET /health` → 200 `{ok:true}`.
2. Dev login → cookie → `GET /me` returns user, memberships, preferences; first
   user is `owner`, second is `member`.
3. API keys: create (key shown once, starts `pm_`), list (prefix only), use as
   bearer, revoke → 401.
4. Projects: create (key validation `^[A-Z][A-Z0-9]{1,9}$`), get with counts
   and views, members PUT/DELETE, visibility change sets `resync_required`.
5. Items: create (defaults: initial state, `number`/`key` assigned, reporter
   = actor), create with invalid `fields` → 400 `validation` with the field
   name, get by key and by uuid, patch (fields shallow-merged), soft delete
   + restore, `GET /items` filters (`project`, `type`, `state_category`,
   `assignee=me`, `label`, `q`, `updated_since`, `limit`, `cursor`),
   `POST /items/query` with `group_by` → `groups`.
6. Transitions: `GET /items/:key/transitions` lists allowed/failing with
   reasons; `start` without assignee → 409 `guard_failed`; assign then
   `start` → 200, `start_date` set, `activity_events` has rows for
   `state_id` and `start_date` with one `txn_id`; `complete` on a parent with
   open children → 409; `transition_children` / `transition_parent_if`
   effects on a custom workflow created via `PUT /workflows/:key`.
7. Activity: one row per changed field for a 3-field patch; JSON keys as
   `fields.<key>`; `GET /items/:key/activity` paginates with `before`;
   `GET /activity?project=&since=` respects visibility.
8. Bulk: `POST /items/bulk` on 3 keys → one `txn_id`; `bulk-transition` →
   `{ok, failed}` with failures.
9. Relations: add `blocks`, cycle → 400 `validation`; `is_blocked` true in
   `GET /items/:key`; external `links_to` with `external_ref`; `PUT
   /items/:key/parent` replaces the parent; `rollup` in `GET /items/:key`.
10. Comments: create with mention → `mention` notification for the mentioned
    user and none for the author; reply → `reply` notification; watcher rows
    for commenter/mention; edit/delete own; `comment.edit_any` forbidden for
    editors.
11. Notifications: `assigned` on assignee change, not for self-assign;
    `state_change` to assignee; collapsing: two comments → one unread row with
    updated body; `read`, `read-all`; preferences `PUT` and rule `off`
    suppresses.
12. Webhooks: create endpoint, patch an item → `webhook_deliveries` row with
    the §3 body shape; signature verifies with the endpoint secret; a failing
    receiver (mock `fetch`) schedules `next_attempt_at` +1m then +5m; after
    five failures `dead`; `event_kinds` filter and `project` filter; `test`
    route; deliveries listing.
13. Sync push: three mutations in order applied once; replay of the same ids
    is a no-op; a gap (`id = last + 2`) → error; a mutation that fails a guard
    is marked applied and creates a `mutation_rejected` notification; push
    emits poke (subscribe to the emitter).
14. Sync pull: cookie null → `clear` + puts of every visible row for every
    `SYNCED_TABLES` entry; cookie = returned cookie → empty patch; after an
    update → one `put`; after delete → `del`; after making an item
    confidential (actor is not assignee) → `del` for the other user; after
    removing a member from a private project → that user's next pull is a
    full resync (`clear`); `views` visibility (own / shared / project);
    `notifications` only own.
15. Permissions: guest sees no firm projects; member cannot read a private
    project (404); viewer cannot patch (403); editor cannot change members
    (403); firm admin can; `export` for viewer OK; confidential item hidden
    from `GET /items`, `/search`, `/export`.
16. Search: FTS5 hit with rank and snippet; a partial word (`curv`) hits
    via the LIKE fallback; project filter; visibility.
17. Views: CRUD, `run` for list (items) and dashboard (`widgets[].rows`),
    shared view visible to project members only.
18. Types/workflows admin: `PUT /types/:key` with bad `field_defs` → 400;
    `PUT /workflows/:key` invalid definition → 400 with `validateDefinition`
    messages; non-admin → 403.
19. Integrations deps: `findItemByKey`, `resolveUserBySlackId`,
    `systemActor('slack')` creates/uses a service user, `recordInbound`
    returns false on repeat, `runMutation` writes with `source` and
    `actor_label`.
20. Export CSV: header includes `key,title,…,fields.severity`; rows filtered.

### Phase 4 — `@pm/integrations`

Pure library: no database driver; uses only `IntegrationDeps`. Routes mounted
by `registerIntegrationRoutes`:

* `POST /integrations/slack/events`: verify `X-Slack-Signature` (v0 HMAC over
  `v0:<ts>:<body>`, reject skew > 5 min); `url_verification` → `{challenge}`;
  `link_shared` → `chat.unfurl` with item summary blocks; `message` (not from
  bots) containing item keys → `chat.postMessage` thread reply + `addRelation`
  `links_to` with `external_kind: 'slack_thread'` (dedupe via
  `recordInbound('slack', event_id)`).
* `POST /integrations/slack/commands`: `/pm create <title>` → `createItem`
  in the channel-mapped project (`integration_configs.slack.channel_map`, else
  the first project the user can edit); `/pm find <q>` → top 5 via the search
  route (call through `deps`: add `searchItems(actor, q)` to your `deps`
  implementation only if needed — otherwise use `findItemByKey` + a
  `searchItems` method you add to `IntegrationDeps` **and document it in
  PLAN.md**); `/pm mine`; `/pm KEY-12` → item card with transition buttons.
* `POST /integrations/slack/interactions`: block actions
  `transition:<key>:<transitionKey>` → `transitionItem` as the resolved user;
  reply with updated card or the guard failure text.
* `POST /integrations/github/webhook`: verify `X-Hub-Signature-256`;
  `X-GitHub-Delivery` idempotency; `pull_request` opened/edited/closed →
  link PRs mentioning keys in title/body/branch (`extractItemKeys`),
  `external_kind: 'github_pr'`, `external_ref: {url, repo, number, title,
  state}`; merged PR whose body matches `/(fixes|closes|resolves)\s+([A-Z][A-Z0-9]{1,9}-\d+)/i`
  → `transitionItem('complete')` as the user resolved by the PR author's
  noreply email, else the `github` service actor; guard failure → `addComment`
  explaining it; `issues` → `github_issue` links; `push` → one comment per
  push listing commits that mention keys.
* `POST /integrations/email/inbound`: body `{from, to, subject, text, html?,
  message_id, in_reply_to?}`; `parseInboundAddress`; `pm+KEY-12@` →
  `addComment` (`source: 'email'`, `external_ref: {message_id}`); `pm+PROJECT@`
  → `createItem` (title = subject, description = text); unknown sender → use
  the `email` service actor and prefix the body with the sender; dedupe on
  `message_id`.
* `sendSlackMessage` → `chat.postMessage` with `slackBotToken`; `sendEmail`
  → nodemailer over `smtpUrl`, or `deps.log.info` when unset.
* `renderNotification` / `renderDigest`: subject `[KEY] title`, text, html,
  Slack blocks with "Open" button and, for `state_change`/`assigned`, action
  buttons.

**Tests (vitest, Fastify instance + a fake `IntegrationDeps` with in-memory
state and recorded `runMutation` calls):**

1. Slack signature: valid passes, wrong secret fails, stale timestamp fails;
   `url_verification` echoes the challenge.
2. `link_shared` produces an unfurl payload with key/title/state; `message`
   with `RATES-12` records a `links_to` mutation once (second delivery with
   the same `event_id` is ignored).
3. Slash command parsing for all four forms + help; `/pm create` records
   `createItem` with `project_id` from `channel_map`.
4. Interactions: `transition:RATES-12:start` records `transitionItem` as the
   Slack user; guard failure text is returned.
5. GitHub: signature valid/invalid; PR opened with `RATES-12` in branch
   records `addRelation` with `github_pr`; merged PR with `Fixes RATES-12`
   records `transitionItem('complete')`; redelivery ignored.
6. Email: `parseInboundAddress` for item/project/invalid; inbound to
   `pm+RATES-12@pm.example.com` records `addComment` with `source: 'email'`;
   to `pm+RATES@` records `createItem`; duplicate `message_id` ignored.
7. `renderNotification`/`renderDigest` snapshot tests for each kind;
   `sendEmail` without `smtpUrl` logs instead of throwing.

### Phase 5 — `@pm/mcp`

`src/server.ts`: `@modelcontextprotocol/sdk` server, transport `stdio`
(default) or Streamable HTTP (`MCP_TRANSPORT=http`, `PORT`), tools in
`src/tools.ts` calling the REST API via `src/client.ts` (`fetch`, `API_URL`,
`Authorization: Bearer ${PM_API_KEY}`). Tools: `my_work`, `list_projects`,
`get_project`, `search_items` (accepts `spec` or `q`), `get_item`,
`create_item`, `update_item`, `transition_item` (returns guard failures as a
result, not an error), `bulk_update`, `bulk_transition`, `add_comment`,
`add_relation`, `set_parent`, `list_types`, `list_workflows`,
`item_activity`, `run_view`, `export_items`. Input schemas with zod; tool
descriptions include the error shape and the guard vocabulary. API errors map
to MCP tool errors with the `code` and `message`.

**Tests (vitest, SDK `InMemoryTransport` pair + a mocked `fetch` that records
requests and returns canned API responses):**

1. `tools/list` returns every tool with a non-empty description and schema.
2. `my_work` → `GET /api/v1/my-work` with the bearer header.
3. `search_items {q}` → `/api/v1/search?q=`; `{spec}` → `POST /items/query`.
4. `create_item` → `POST /items` with the body; validation error surfaces as a
   tool error with code `validation`.
5. `transition_item` on 409 returns `{ok:false, failures}` as a normal result.
6. Missing `PM_API_KEY` → server refuses to start with a clear message.

### Phase 6 — `@pm/web`

Vite + React 18 + Tailwind 4 + `react-router-dom` 6 + `replicache` 15 +
`cmdk` + `@dnd-kit` + `@tanstack/react-virtual` + `react-markdown` +
`date-fns` + `lucide-react`. Behaviour per §3 "Web app" and the keyboard list
there.

* `src/replicache.ts`: `new Replicache({ name: userId, pushURL: '/sync/push',
  pullURL: '/sync/pull', mutators })`; `mutators` generated from
  `MutationArgs` (each validates with zod, then applies the optimistic local
  write mirroring the server: `createItem` puts `work_items/<id>` with `key =
  "<PROJECT>-?"`, `number = 0`, initial state from the local workflow;
  `updateItem` merges; `transitionItem` runs `workflowEngine.evaluate` with a
  best-effort `GuardContext`; `addLabel`/`addRelation`/`addComment` put rows;
  deletes set `deleted_at`). SSE `EventSource('/sync/poke')` → `rep.pull()`.
* Hooks: `useRows(table, filter?)` via `useSubscribe` on key prefixes;
  `useItem(key)`, `useLookups()` (states, types, projects, labels, parents,
  blocked set) for `runSpec`.
* Routes: `/` (my work), `/inbox`, `/projects`, `/p/:projectKey` → default
  view, `/p/:projectKey/v/:viewId` (List/Board/Timeline/Dashboard by
  `spec.kind`), `/i/:itemKey` (detail), `/p/:projectKey/activity`,
  `/p/:projectKey/settings`, `/admin/{types,workflows,users,webhooks,integrations}`,
  `/login` (dev login box + magic link form).
* Command palette (`cmdk`, `⌘K`): navigate, create (`c`), actions on focused/
  selected items (assign, priority, transition, label, move, due), bulk mode
  when ≥ 2 selected (`x`, `shift+click`, `⌘A`), search (`/`), `?` cheatsheet.
* Views: toolbar (filter builder editing `FilterExpr`, sort, group, columns,
  board/timeline options, Save/Save as/Share/Default); unsaved spec in URL
  state. Board drag → `transitionItem` (choose transition whose `to_state_id`
  is the column) or `updateItem` for non-state columns. Timeline drag → dates.
  Dashboard widgets aggregate from `runSpec().groups`.
* Item detail: header + transition buttons (engine-evaluated), markdown
  description with mentions, typed field form from `field_defs` with
  `validateFields` errors inline, relations (parent/children/rollup/blocks/
  external), labels, watchers, comments thread, activity timeline grouped by
  `txn_id`.
* Inbox: unread first, grouped, actions; `mutation_rejected` rows shown with
  the reason.
* Admin editors for types (field builder) and workflows (states, transitions,
  guard/effect forms, `validateDefinition` before save).
* Dev proxy: Vite `server.proxy` for `/api`, `/auth`, `/me`, `/sync`,
  `/integrations` → `http://localhost:3001` (with `ws`/SSE passthrough).

**Acceptance:** `pnpm --filter @pm/web typecheck` and `build` succeed;
vitest (jsdom) tests: mutators' optimistic writes (`createItem` key
`RATES-?`, `transitionItem` patches `state_id` via the engine and refuses when
a guard fails locally), `runSpec`-driven List renders grouped rows from a
fixture store, palette opens on `⌘K` and runs "assign" on the focused row,
keyboard `j/k/x` selection, filter builder round-trips a `FilterExpr`.

### Phase 7 — Docs and polish

`docs/01-data-model.md` (standalone data model walkthrough), `docs/02-design.md`
(query layer, mutations, sync, notifications, webhooks), `docs/03-ux.md`,
`docs/04-integrations.md`, `docs/05-operations.md`, `docs/adr/ADR-001..009.md`
(generic item; workflows as data; edge table; append-only log; per-project
roles; views as saved queries; global-version sync; monolith; SQLite over
Postgres). Keep them
consistent with `ARCHITECTURE.md` and the SQL; where you had to decide
something, record it.

---

## 8. Seed data specification (`pnpm db:seed`)

Deterministic UUIDs (use a fixed namespace, e.g. `0000000-…` patterns or
uuid v5 of a name) so tests and docs can reference them. All inserts in one
transaction. Workflows/types come from the migration; the seed adds:

**Users** (`firm_role`): `alice@firm.com` Alice Chen (owner),
`bob@firm.com` Bob Marsh (admin), `carol@firm.com` Carol Diaz (member),
`dave@firm.com` Dave Okafor (member), `erin@firm.com` Erin Walsh (guest),
`frank@firm.com` Frank Liu (member, `is_active = false`). Service users
(`is_service = true`): `slack@system`, `github@system`, `email@system`,
`agent@system` (emails may be `<name>@system.local`). `users.settings` for
Alice: `{"slack_user_id":"U0ALICE"}`.

**Teams**: `RATES` Rates desk (Alice lead, Carol), `OPS` Operations (Bob
lead, Dave).

**Projects**: `RATES` "Rates desk" (firm, team RATES, lead Alice, default type
task, allowed types all), `OPS` "Operations" (firm, team OPS, lead Bob,
default type request), `COMP` "Compliance" (**private**, lead Bob; members:
Bob admin, Erin viewer, Carol editor), `ARCH` "Archive" (status archived,
firm).

**Labels**: firm-wide `urgent` (#ef4444), `tech-debt`, `regulatory`,
`desk-approved`; RATES-only `curve`, `vol`; OPS-only `vendor`.

**Items** (≥ 40):

* RATES: 3 initiatives (`fields.quarter` 2026Q4/2027Q1, `owner_desk` Rates,
  budgets), each with 3–5 child tasks (varied states across backlog/todo/
  in_progress/in_review/done, priorities 1–4, estimates 1–13, due dates from
  −10 to +30 days, assignees Alice/Carol/Dave), 6 bugs (severities s1–s4,
  environments; two `in_review`, one `done`), 2 `blocks` chains (one open
  blocker so an item is `is_blocked`), 1 `duplicates`, 2 external links
  (`github_pr`, `url`), 1 **confidential** task assigned to Alice.
* OPS: 8 requests (`requester_desk`, `urgency`, some `approved`), 4 tasks.
* COMP: 4 tasks (one confidential, assigned to Bob), 1 initiative.
* ARCH: 2 done tasks with `archived_at` set.

**Comments**: ≥ 10 across items including one mention of Bob
(`@[Bob Marsh](user:<bob id>)`), one threaded reply, one with `source =
'email'` and one with `source = 'slack'` and `external_ref`.

**Watchers**: implied by assignee/reporter/commenter/mention (insert rows
accordingly) plus one `manual` watch by Erin on a COMP task.

**Views** (shared, `owner_id` null, `is_default` on the first per project):

* RATES: "Board" (board, `state.category nin [canceled]`, columns by
  `state_id`, swimlane null), "All open" (list, columns key/title/type.key/
  state_id/assignee_id/priority/due_date/fields.severity, group by
  `state.category`), "Initiatives" (timeline, `type.key eq initiative`,
  show_dependencies), "Desk health" (dashboard with 5 widgets: open count,
  blocked count, open by assignee bar, bugs by severity pie, due in 7 days
  list).
* OPS: "Requests board" (board on `state_id`, swimlane `fields.urgency`),
  "Unapproved" (list, `fields.approved neq true`).
* Cross-project (project null): "My work" (`assignee_id eq $me`, open),
  "Due this week" (`due_date within_days 7`).
* One private view owned by Carol in RATES: "Carol's curve work"
  (`labels has <curve id>`).

**Notification preferences**: `in_app` row for every user (defaults),
`email` daily for Alice, `slack` immediate for Alice with quiet hours
19:00–07:00 America/New_York.

**Notifications**: 5 unread for Alice (assigned, mention, state_change,
reply, due_soon) pointing at seeded activity events.

**Activity**: the seed writes `activity_events` rows for every item it
creates (`action = 'create'`, `source = 'system'`, `actor_kind = 'system'`)
and one `transition` row per item not in its initial state, so history is
non-empty.

**Webhook endpoint**: `local-echo` → `http://localhost:9999/hook`,
`event_kinds ["*"]` (JSON array), `is_active = 0`, secret `whsec_seed_do_not_use`.

**Integration configs**: `slack` `{"team_id":"T0SEED","channel_map":{"RATES":"C0RATES","OPS":"C0OPS"}}` inactive;
`github` `{"repos":["firm/curves"],"autolink":true}` inactive; `email`
`{"inbound_domain":"pm.example.com"}` inactive.

**API key** for Alice: name `seed-cli`, raw key `pm_seed_alice_key_0000000000`
(store its sha256), scopes read+write — so curl examples work out of the box.

---

## 9. Verification checklist

Run from the repo root; every line must pass.

```bash
# 0. toolchain
node --version          # ≥ 22
pnpm --version          # 10.x

# 1. install + build
pnpm install
pnpm --filter @pm/core build
pnpm -r build
pnpm typecheck

# 2. database (a file; nothing to start)
cp .env.example .env
pnpm db:migrate         # creates ./data/pmtool.db and applies 0001_init.sql; second run reports it as already applied
pnpm db:seed            # idempotent
sqlite3 data/pmtool.db "select count(*) from work_items"                        # ≥ 40
sqlite3 data/pmtool.db "update activity_events set source='x' where id=1"      # Runtime error: activity_events is append-only (UPDATE denied)
# without the sqlite3 shell:
node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('data/pmtool.db').prepare('select count(*) n from work_items').get())"

# 3. tests
pnpm test               # all packages green; every suite uses an in-memory or temporary SQLite database

# 4. API
pnpm dev:api &          # :3001
curl -s localhost:3001/health                                                   # {"ok":true}
curl -s -c c.txt -X POST localhost:3001/auth/dev-login -H 'content-type: application/json' -d '{"email":"alice@firm.com"}'
curl -s -b c.txt localhost:3001/me | jq .user.firm_role                         # "owner"
K='authorization: Bearer pm_seed_alice_key_0000000000'
curl -s -H "$K" 'localhost:3001/api/v1/items?project=RATES&limit=3' | jq '.items|length'   # 3
curl -s -H "$K" localhost:3001/api/v1/items/RATES-1 | jq .item.key              # "RATES-1"
curl -s -H "$K" 'localhost:3001/api/v1/search?q=curve' | jq '.items|length'     # ≥ 1
curl -s -H "$K" -X POST localhost:3001/api/v1/items/query -H 'content-type: application/json' \
  -d '{"spec":{"filter":{"field":"state.category","op":"nin","value":["done","canceled"]},"group_by":"assignee_id"}}' | jq '.groups|length'  # ≥ 1
curl -s -H "$K" -X POST localhost:3001/api/v1/items -H 'content-type: application/json' \
  -d '{"project_key":"RATES","type_id":"'$(curl -s -H "$K" localhost:3001/api/v1/types | jq -r '.[]|select(.key=="task")|.id')'","title":"Smoke test"}' | jq .key
curl -s -H "$K" -X POST localhost:3001/sync/pull -H 'content-type: application/json' \
  -d '{"pullVersion":1,"clientGroupID":"cg-smoke","cookie":null}' | jq '.patch[0].op, (.patch|length)'   # "clear", > 100
curl -s -H "$K" 'localhost:3001/api/v1/export/items.csv?project=RATES' | head -2

# 5. web
pnpm --filter @pm/web build        # dist/ produced
pnpm dev:web &                     # :5173 → open, dev-login as alice@firm.com, ⌘K works, board drag moves a card

# 6. MCP
pnpm --filter @pm/mcp build
API_URL=http://localhost:3001 PM_API_KEY=pm_seed_alice_key_0000000000 node packages/mcp/dist/server.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"my_work","arguments":{}}}
EOF
# → a result with assigned/created/watching/due_soon/mentions
```

---

## 10. Definition of done

* [ ] Repository matches §2; the four verbatim artefacts (§3, §4, §5.1–5.5, §6)
      are byte-identical to this document.
* [ ] `pnpm install && pnpm --filter @pm/core build && pnpm -r build &&
      pnpm typecheck` succeed on a clean clone.
* [ ] `pnpm db:migrate && pnpm db:seed` succeed on a fresh clone (they create
      `./data/pmtool.db` themselves) and are idempotent.
* [ ] `pnpm test` is green in every package, including the SQL ↔ local
      query parity suite, API push/pull tests, integration signature tests,
      MCP in-memory transport tests, and the web vitest suite.
* [ ] Every route in §3 "HTTP API v1" exists, authenticates with cookie or
      API key, returns the documented shapes and error codes, and respects
      visibility.
* [ ] Every mutation in §5.3 is implemented in `applyMutation` with the
      8-step pipeline; every write produces one `activity_events` row per
      changed field sharing a `txn_id`.
* [ ] Sync: push idempotency/ordering/rejection semantics; pull snapshot,
      delta, tombstones, visibility `del`, `resync_required`; poke over SSE.
* [ ] Workflow guards and effects behave as §5.4 / §1.1 on both client and
      server; `validateDefinition` guards admin writes.
* [ ] Notifications follow the low-noise rules; webhooks are signed, coalesced
      and retried with the documented backoff.
* [ ] Slack, GitHub and email routes verify signatures, are idempotent, and
      write through `runMutation`.
* [ ] The MCP server starts over stdio with `PM_API_KEY` and exposes the
      tool catalogue.
* [ ] The web app builds, logs in, renders list/board/timeline/dashboard from
      `views.spec` on local data, supports the keyboard map and bulk edit,
      and shows rejected mutations in the inbox.
* [ ] `README.md` quick start works as written; `PLAN.md` lists every
      decision you made where this document was silent.
* [ ] Verification checklist §9 passes top to bottom.
