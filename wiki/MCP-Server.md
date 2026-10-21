# MCP Server

`packages/mcp` exposes pm-tool to agents over the [Model Context Protocol](https://modelcontextprotocol.io). It is a thin client of the REST API: every tool maps to one or two HTTP calls made with an API key, so an agent can do exactly what the key's user can do and nothing more. It has no database access.

Source and README: [`packages/mcp/README.md`](https://github.com/jamjorf/pm-tool/blob/main/packages/mcp/README.md), [`packages/mcp/src/tools.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/mcp/src/tools.ts). Agent workflows and security notes: [docs/04-integrations.md §6](https://github.com/jamjorf/pm-tool/blob/main/docs/04-integrations.md#6-mcp-server).

## What it exposes

### Tools (23)

| Tool | Arguments | Does |
|---|---|---|
| `list_projects` | `include_archived?` | projects visible to the key: key, name, status, visibility |
| `get_project` | `key` | members, item counts by state category, saved views, default type |
| `search_items` | `q, project?, limit?` | full-text search (`GET /api/v1/search`), FTS5 syntax (`"phrase"`, `OR`, `NOT`, `prefix*`), `LIKE` fallback on key/title for partial words |
| `query_items` | `spec, project?` | structured `QuerySpec` (`POST /api/v1/items/query`); the description documents fields, ops and macros |
| `get_item` | `key` | item, fields, labels, parent and children, relations incl. external links, rollup, watchers, available transitions with guard results |
| `create_item` | `project, type?, title, description?, priority?, assignee?, due_date?, start_date?, estimate?, labels?, parent?, fields?, confidential?` | `assignee` accepts an email, user id or exact name; `type` is a type key (defaults to the project default); labels and parent applied after creation |
| `update_item` | `key, patch, assignee?` | `patch` is the core `ItemPatch`; state is not patchable |
| `bulk_update_items` | `keys, patch, assignee?` | the same patch on many items in one transaction |
| `transition_item` | `key, transition, comment?` | runs a workflow transition; a 409 comes back as a tool error listing each failed guard |
| `list_transitions` | `key` | transitions with guard evaluation (allowed / failures) |
| `add_comment` | `key, body, parent_id?` | markdown comment; mention users as `@[Name](user:<uuid>)` |
| `list_comments` | `key` | comments, oldest first |
| `link_items` | `from, to, type` | `parent_of` (from = parent), `blocks` (from blocks to), `duplicates`, `relates_to` |
| `add_external_link` | `key, kind, url, title?, ref?` | external `links_to` relation (`github_pr`, `github_issue`, `slack_thread`, `doc`, `url`, ...) |
| `unlink` | `relation_id` | delete a relation (ids are shown by `get_item`) |
| `list_activity` | `key?, project?, actor?, since?, limit?` | activity log, one event per changed field; `since` is an event id cursor |
| `my_work` | none | assigned, created, watching, due soon, mentions for the key's user |
| `list_views` | `project?` | saved views with their QuerySpec |
| `run_view` | `view_id` | execute a saved view (dashboards return widget rows) |
| `create_view` | `project?, name, kind, spec, is_shared?` | save a `ViewSpec` as a view |
| `list_types` | none | type keys with workflow and custom field definitions (key, kind, required, options) |
| `list_workflows` | none | states (key, category) and transitions (key, from → to, guards) |
| `list_users` | none | id, name, email, firm role |

Every tool returns a human-readable text block **and** `structuredContent` (JSON). API errors come back as tool errors (`isError: true`) carrying the API's `code`, never as crashes.

### Resources and prompts

| Kind | Name | What |
|---|---|---|
| Resource | `pm://items/{key}` | markdown rendering of a work item |
| Resource | `pm://projects/{key}` | project summary; the list is enumerable |
| Prompt | `triage_project(project)` | review open items, flag unassigned / overdue / blocked / stale, propose priorities and assignees, apply only after confirmation |
| Prompt | `standup(project)` | done since yesterday, in progress by assignee, blocked, due in 3 days, recent activity |

## Setup

### 1. Create an API key

As the user the agent should act as. In the web app: **Settings → API keys → Create key**. Or:

```bash
curl -c cj -X POST http://localhost:3001/auth/dev-login -H 'content-type: application/json' -d '{"email":"alice@firm.com"}'
curl -b cj -X POST http://localhost:3001/me/api-keys -H 'content-type: application/json' -d '{"name":"claude"}'
# → {"id":"…","key":"pm_…"}   (shown once)
```

### 2. Build

```bash
pnpm --filter @pm/core build && pnpm --filter @pm/mcp build
```

### 3. Claude Code

```bash
claude mcp add pm-tool -e API_URL=http://localhost:3001 -e PM_API_KEY=pm_… -- node /abs/path/pm-tool/packages/mcp/dist/server.js
# or, once the HTTP transport is running (below):
claude mcp add --transport http pm-tool http://localhost:3002/mcp --header "Authorization: Bearer pm_…"
```

### 4. Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pm-tool": {
      "command": "node",
      "args": ["/abs/path/pm-tool/packages/mcp/dist/server.js"],
      "env": { "API_URL": "http://localhost:3001", "PM_API_KEY": "pm_…" }
    }
  }
}
```

During development `pnpm dev:mcp` (alias of `pnpm --filter @pm/mcp dev`) runs `tsx src/server.ts` with the same env vars. The server also loads `.env` from the current directory or the repo root if present.

## stdio vs HTTP

| Transport | Start | For |
|---|---|---|
| `stdio` (default) | `API_URL=… PM_API_KEY=pm_… node packages/mcp/dist/server.js` | Claude Code and Claude Desktop spawn the process; logs go to stderr because stdout is the protocol channel |
| `http` | `MCP_TRANSPORT=http MCP_PORT=3002 API_URL=… node packages/mcp/dist/server.js` | hosted or remote agents; Streamable HTTP at `POST /mcp`, stateless (a fresh server per request). The request's own `Authorization: Bearer pm_…` header is used when present, else `PM_API_KEY`. `GET /health` answers `{ok, name, api}` |

| env | default | meaning |
|---|---|---|
| `API_URL` | `http://localhost:3001` | base URL of `@pm/api` |
| `PM_API_KEY` | none | API key; optional for the http transport when clients send their own bearer token |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT`, `MCP_HOST` | `3002`, `0.0.0.0` | http bind address |

In production put the HTTP transport behind the same reverse proxy as the API and run it where the agents run, not on the API server.

## Example conversations

**"What's on my plate?"** → `my_work` → the agent summarises assigned items by due date, flags anything blocked, and offers `transition_item` to start the first one.

**"Find the curve bootstrapping bug and mark it done"** → `search_items {q: "curve bootstrapping"}` → `get_item {key: "RATES-12"}` → `transition_item {key: "RATES-12", transition: "complete"}`. If the transition is blocked ("RATES-13 is still open"), the tool error lists the guards and the agent can `get_item RATES-13`.

**"Create a bug in RATES for the stale 10y fixing, urgent, assign Alice, due Friday"** → `list_types` (bug has a required `severity` select) → `create_item {project: "RATES", type: "bug", title: "Stale 10y fixing", priority: 1, assignee: "alice@firm.com", due_date: "2026-10-17", fields: {severity: "s1"}}`.

**"Triage RATES"** → the `triage_project` prompt: `query_items` over open items sorted by priority, a table of unassigned, overdue and stale items with proposed changes, applied with `bulk_update_items` only after confirmation.

**"Standup for OPS"** → the `standup` prompt: done since yesterday, in progress grouped by assignee, blocked, due in 3 days, recent activity from `list_activity`.

**"What's blocking the Q4 initiatives?"** → `query_items` for initiatives with `fields.quarter = 2026Q4`, then `get_item` for each (children, rollup, `is_blocked`), then `list_activity` on the blockers to see who last touched them.

Every write the agent performs is a normal mutation: guards apply, the activity log records `actor_kind = 'agent'`, `source = 'mcp'`, `actor_label` = the key's name, and watchers are notified as if a user had done it (except the key's owner, who is the actor).

## Security notes

- **Scopes.** Create agent keys with `scopes: ["read"]` when the agent only reports; add `write` only for agents expected to change things. Keys can carry `expires_at` and are revocable with `DELETE /me/api-keys/:id`.
- **One key per agent, named.** `actor_label` makes the audit trail attributable ("claude-triage" vs "alice-cli").
- **Confidentiality holds.** The MCP server sees only what the key owner can see (the `visible_items` view); confidential items are invisible unless the owner is assignee, reporter, creator or project admin. Do not give agents firm-admin keys.
- **Prompt-injection surface.** Item titles, descriptions and comments are user-controlled text; the server never interprets them, but an agent will read them. Treat tool output as data in agent instructions.
- **No bypass.** The MCP server has no database credentials; it cannot read `activity_events` beyond what `/api/v1/activity` exposes under visibility rules.
- **Rate limits** apply per key like any client ([docs/05-operations.md §3](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#3-security)).

The adoption playbook suggests adding agents last: a `read` key for summaries once a desk's views are stable, `write` for triage only when the desk asks.
