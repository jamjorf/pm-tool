# @pm/mcp — pm-tool MCP server

Exposes pm-tool (projects, work items, workflows, views, activity) to agents over the
[Model Context Protocol](https://modelcontextprotocol.io). It is a thin layer over the
REST API v1 served by `@pm/api`: every tool maps to one or two HTTP calls made with an
API key, so permissions are exactly those of the key's user.

```
packages/mcp/src
  server.ts        entrypoint: picks the transport (stdio | http)
  createServer.ts  builds the McpServer (tools + resources + prompts) for one PmClient
  client.ts        PmClient: fetch wrapper (API_URL + Bearer PM_API_KEY), PmApiError
  tools.ts         tool definitions (zod input schemas, text + structuredContent results)
  resources.ts     pm://items/{key}, pm://projects/{key}
  prompts.ts       triage_project, standup
  format.ts        markdown / text renderers
```

## 1. Create an API key

Either in the web app: **Settings → API keys → New key**, or with the API:

```bash
# log in first (dev mode) to get the pm_session cookie
curl -c cj -X POST http://localhost:3001/auth/dev-login -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -b cj -X POST http://localhost:3001/me/api-keys -H 'content-type: application/json' -d '{"name":"claude"}'
# → {"id":"…","key":"pm_…"}   (the key is shown once)
```

## 2. Run

```bash
pnpm --filter @pm/core build && pnpm --filter @pm/mcp build

# stdio (default) — what Claude Desktop / Claude Code spawn
API_URL=http://localhost:3001 PM_API_KEY=pm_… node packages/mcp/dist/server.js

# Streamable HTTP on :3002/mcp (stateless). The request's own
# `Authorization: Bearer pm_…` header is used when present, else PM_API_KEY.
MCP_TRANSPORT=http MCP_PORT=3002 API_URL=http://localhost:3001 node packages/mcp/dist/server.js
curl -s http://localhost:3002/health
```

| env | default | meaning |
|---|---|---|
| `API_URL` | `http://localhost:3001` | base URL of `@pm/api` |
| `PM_API_KEY` | — | API key (`pm_…`); optional for http transport when clients send their own bearer token |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` / `MCP_HOST` | `3002` / `0.0.0.0` | http transport bind address |

Logs go to stderr (stdout is the stdio protocol channel).

### Claude Code

```bash
claude mcp add pm-tool -e API_URL=http://localhost:3001 -e PM_API_KEY=pm_… -- node /abs/path/pm-tool/packages/mcp/dist/server.js
# or the http transport once it is running:
claude mcp add --transport http pm-tool http://localhost:3002/mcp --header "Authorization: Bearer pm_…"
```

### Claude Desktop (`claude_desktop_config.json`)

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

During development `pnpm --filter @pm/mcp dev` runs `tsx src/server.ts` (same env vars).

## Tools

| tool | what it does |
|---|---|
| `list_projects`, `get_project` | projects; project details with members, counts by state category, views |
| `search_items {q, project?, limit?}` | full-text search (`GET /api/v1/search`) |
| `query_items {spec, project?}` | structured QuerySpec (`POST /api/v1/items/query`); the description documents the grammar, fields, ops and the `$me` / `$today` / `$start_of_week`… macros with examples |
| `get_item {key}` | item + labels + relations + parent/children + rollup + available transitions (with guard failures) |
| `create_item {project, type?, title, description?, priority?, assignee?, due_date?, start_date?, estimate?, labels?, parent?, fields?, confidential?}` | `assignee` accepts an email, user id or exact name; `type` is a type key (defaults to the project default); labels/parent are applied after creation |
| `update_item {key, patch, assignee?}`, `bulk_update_items {keys, patch, assignee?}` | `patch` is the core `ItemPatch` |
| `transition_item {key, transition, comment?}` | runs a workflow transition; a 409 comes back as a tool error listing each failed guard |
| `list_transitions {key}` | transitions with guard evaluation |
| `add_comment {key, body, parent_id?}`, `list_comments {key}` | comments (mention users as `@[Name](user:<uuid>)`) |
| `link_items {from, to, type}` | `parent_of` / `blocks` / `duplicates` / `relates_to` |
| `add_external_link {key, kind, url, title?, ref?}`, `unlink {relation_id}` | external `links_to` relations |
| `list_activity {key?, project?, actor?, since?, limit?}` | activity log (`since` is an event id cursor) |
| `my_work` | assigned / created / watching / due soon / mentions for the key's user |
| `list_views {project?}`, `run_view {view_id}`, `create_view {project?, name, kind, spec, is_shared?}` | saved queries |
| `list_types`, `list_workflows`, `list_users` | vocabulary: type keys + custom fields, states + transition keys + guards, user ids |

Every tool returns a human-readable text block **and** `structuredContent` (JSON).
API errors are returned as tool errors (`isError: true`) with the API's `code`, never as crashes.

Resources: `pm://items/{key}` (markdown item), `pm://projects/{key}` (project summary; listable).
Prompts: `triage_project(project)`, `standup(project)`.

## Example conversations

**"What's on my plate?"** → `my_work` → the agent summarises assigned items by due date and
flags anything blocked, then offers `transition_item` to start the first one.

**"Find the curve bootstrapping bug and mark it done"** →
`search_items {q:"curve bootstrapping"}` → `get_item {key:"RATES-12"}` →
`transition_item {key:"RATES-12", transition:"complete"}`. If the transition is blocked
("RATES-13 is still open"), the error lists the guards and the agent can `get_item RATES-13`.

**"Create a bug in RATES for the stale 10y fixing, urgent, assign Alice, due Friday"** →
`list_types` (bug has a required `severity` select) →
`create_item {project:"RATES", type:"bug", title:"Stale 10y fixing", priority:1, assignee:"alice@firm.com", due_date:"2026-10-17", fields:{severity:"high"}}`.

**"Triage RATES"** → the `triage_project` prompt: `query_items` over open items sorted by
priority, a table of unassigned / overdue / stale items with proposed changes, applied
with `bulk_update_items` only after confirmation.

**"Standup for OPS"** → the `standup` prompt: done since yesterday, in progress grouped
by assignee, blocked, due in 3 days, recent activity.
