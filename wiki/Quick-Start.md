# Quick Start

From a clean machine to a running pm-tool with seeded data, an API key and the MCP server connected to Claude Code.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ | `package.json` declares `"engines": { "node": ">=22" }` |
| pnpm | 10 | `corepack enable` picks up `"packageManager": "pnpm@10.28.0"` automatically |
| Docker | any recent | only for the bundled Postgres; skip it if you have Postgres 15+ |
| Postgres | 15+ | `docker compose up -d postgres` starts Postgres 16 on `:5432` |
| git | any | |

```bash
corepack enable        # makes the pinned pnpm version available
node --version         # v22.x
pnpm --version         # 10.x
```

## Install and run

```bash
git clone https://github.com/jamjorf/pm-tool.git
cd pm-tool

cp .env.example .env
docker compose up -d postgres        # or point DATABASE_URL at your own Postgres 15+
pnpm install
pnpm --filter @pm/core build         # other packages import @pm/core from its dist
pnpm db:migrate && pnpm db:seed
pnpm dev                             # API on :3001, web on :5173
```

`scripts/dev.sh` does all of the above in one go (it copies `.env`, waits for Postgres, installs, builds core, migrates, seeds and starts `pnpm dev`).

Open http://localhost:5173.

## First login

`.env.example` sets `AUTH_MODE=dev`, so the login page shows a **Dev login** box: enter a seeded email and press Dev login. There are no passwords. The box also offers "Email me a magic link"; in dev the link is printed to the API log instead of being sent.

Sign in as `alice@firm.com`, the firm owner.

### Seeded users

| Email | Name | Firm role | Notes |
|---|---|---|---|
| alice@firm.com | Alice Chen | owner | owns the cross-project views |
| bob@firm.com | Bob Okafor | admin | |
| carol@firm.com | Carol Nakamura | member | lead of RATES |
| dan@firm.com | Dan Whitfield | member | lead of EQD |
| eve@firm.com | Eve Lindqvist | member | viewer on ONB |
| frank@firm.com | Frank Moreau | member | lead of OPS |
| grace@firm.com | Grace Patel | member | lead of ONB (project admin) |
| hugo@firm.com | Hugo Schmidt | member | editor on ONB |
| agent@firm.com | PM Agent | member | service user (`is_service = true`) for API keys and MCP |

### Seeded projects

| Key | Name | Visibility | Who sees it |
|---|---|---|---|
| `RATES` | Rates Desk Platform | firm | every member |
| `EQD` | Equity Derivs Tooling | firm | every member |
| `OPS` | Operations Backlog | firm | every member |
| `ONB` | Client Onboarding | private | grace, hugo, eve, plus firm owner/admin |

Plus 60 work items across `task`, `bug`, `initiative` and `request` types with relations, comments, labels (`regulatory`, `tech-debt`, `quick-win`), watchers, activity history and four shared views per project (`All open`, `Board`, `Roadmap`, `Overview`).

## Five-minute tour

1. **Open the RATES board.** In the sidebar pick RATES, then the `Board` view (`/p/RATES/v/<viewId>`). Columns are workflow states; every read comes from the local Replicache store, so navigation is instant.
2. **Drag a card that has no assignee from Todo to In Progress.** The drop maps to the `start` transition, whose guards are `require_field assignee_id` and `no_open_blockers`. The workflow engine runs locally, refuses, shows the failing guard in a toast and snaps the card back. Press `a` on the card to assign it, then drag again.
3. **Press `⌘K` (`Ctrl+K`).** The command palette navigates to projects, views and items (type `RATES-12`), and offers actions on the focused or selected rows. `>`-style actions appear when rows are selected.
4. **Press `c`.** Quick-create an item in the current project; `⌘Enter` creates it and opens it. The row appears immediately with a placeholder key `RATES-?` until the server assigns the real number.
5. **Change the filter and save a view.** Edit the filter in the toolbar; the unsaved spec lives in the URL (`?filter=...`) so the link is shareable. Press **Save** to write it back, or **Save as** for a new view.
6. **Check the Inbox** (`g` then `i`). Notifications are synced rows: mentions, assignments, replies and state changes on your items. If the server ever rejects an optimistic change, a `mutation_rejected` row explains why.

Press `?` at any time for the shortcut cheatsheet. The full map is in [[Keyboard and Palette]].

## Create an API key and call the API

```bash
API=http://localhost:3001

# log in (dev mode) and keep the cookie
curl -s -c cj -X POST $API/auth/dev-login -H 'content-type: application/json' \
  -d '{"email":"alice@firm.com"}'

# create an API key (the key is shown once)
curl -s -b cj -X POST $API/me/api-keys -H 'content-type: application/json' \
  -d '{"name":"laptop"}'
# → {"id":"…","key":"pm_…","name":"laptop","key_prefix":"pm_…","scopes":["read","write"],"created_at":"…"}
export PM_API_KEY=pm_…
```

You can also create keys in the web app under **Settings → API keys** (`/settings`).

```bash
H=(-H "authorization: Bearer $PM_API_KEY" -H 'content-type: application/json')

# who am I
curl -s "${H[@]}" $API/me

# my open items, with the same QuerySpec a saved view uses
curl -s "${H[@]}" -X POST $API/api/v1/items/query -d '{
  "spec": { "filter": { "and": [
    { "field": "assignee_id", "op": "eq", "value": "$me" },
    { "field": "state.category", "op": "nin", "value": ["done","canceled"] }
  ] } }
}'

# read one item with its relations and available transitions
curl -s "${H[@]}" $API/api/v1/items/RATES-12
```

More in [[API]].

## Connect the MCP server to Claude Code

```bash
pnpm --filter @pm/mcp build
claude mcp add pm-tool \
  -e API_URL=http://localhost:3001 \
  -e PM_API_KEY=$PM_API_KEY \
  -- node "$PWD/packages/mcp/dist/server.js"
```

Then ask Claude Code "what's on my plate in RATES?" and it will call `my_work` and `query_items`. `pnpm dev:mcp` runs the server from source for development (same env vars). Claude Desktop config and the HTTP transport are in [[MCP Server]].

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on 3001 or 5173 | Something else is listening. Change `PORT` in `.env` for the API (and `API_URL` to match), or start the web app on another port with `pnpm --filter @pm/web exec vite --port 5174`. |
| `ECONNREFUSED` / `password authentication failed` | Check `DATABASE_URL` in `.env` (default `postgres://postgres:postgres@localhost:5432/pmtool`) and that `docker compose ps` shows Postgres healthy. |
| `Cannot find module '@pm/core'` or typecheck errors in api/web/mcp | Run `pnpm --filter @pm/core build` first. Other packages import `@pm/core` from its `dist`, so a fresh clone must build core before `pnpm -r typecheck`, `pnpm -r test` or `pnpm -r build`. |
| React type errors from `react-router`, `cmdk`, `dnd-kit` | `.npmrc` hoists `@types/react` and `@types/react-dom` to the root (`public-hoist-pattern`). If you changed `.npmrc` or installed with another package manager, restore it and run `pnpm install` again. |
| Seed says users already exist | `pnpm db:seed` is a no-op when any user exists. Use `pnpm --filter @pm/db seed --force` to wipe data tables and reseed, or start over below. |
| Want a clean database | `pnpm db:reset -- --yes` drops the schema, migrates and seeds (local databases only). |
| Dev login returns 403 | `AUTH_MODE` is not `dev`. Set `AUTH_MODE=dev` in `.env` and restart the API. |
| Magic link never arrives | With no `SMTP_URL` the link is logged by the API process; copy it from the terminal. |

## Next steps

- [[Data Model]] for the tables behind what you just clicked.
- [[Workflows and Item Types]] to add a desk-specific type with an approval workflow using INSERT statements only.
- [[Views and Queries]] for the QuerySpec grammar behind every view.
- [[Integrations]] to connect Slack, GitHub and email.
- [[Development]] for the test suites and conventions before your first change.
