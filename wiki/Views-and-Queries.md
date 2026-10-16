# Views and Queries

Lists, boards, timelines, dashboards, `POST /api/v1/items/query`, the MCP `query_items` tool, saved views and the command palette all speak one grammar: `QuerySpec`. The server compiles it to parameterised SQL over `work_items_v`; the client evaluates the same spec in memory over rows from the Replicache store. A parity test suite in `@pm/core` asserts both executors return the same ids for every fixture.

Source: [`packages/core/src/query/spec.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/core/src/query/spec.ts) (grammar), [`compile.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/core/src/query/compile.ts) (SQL), [`evaluate.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/core/src/query/evaluate.ts) (client), [`parity.test.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/core/src/query/parity.test.ts). Narrative: [docs/02-design.md §2](https://github.com/jamjorf/pm-tool/blob/main/docs/02-design.md#2-the-query-layer-one-spec-two-executors).

## Grammar

```ts
QuerySpec = {
  filter?: FilterExpr,
  sort?: SortSpec[],
  group_by?: FieldRef | null,
  limit?: 1..5000,
  offset?: >= 0,
  include_archived?: boolean,
}

FilterExpr = { field: FieldRef, op: FilterOp, value?: unknown }
           | { and: FilterExpr[] } | { or: FilterExpr[] } | { not: FilterExpr }

SortSpec   = { field: FieldRef, dir: 'asc' | 'desc' (default asc), nulls?: 'first' | 'last' }
FieldRef   = /^[a-z_]+(\.[a-z0-9_]+)?$/
```

Soft-deleted rows are always excluded; archived rows (`archived_at is not null`) are excluded unless `include_archived`.

## Fields

`BUILTIN_FIELDS` in `spec.ts` lists every built-in reference with its storage kind and whether it is sortable. The UI's field picker and the SQL compiler both read it.

| FieldRef | Kind | Sortable | Resolves to |
|---|---|---|---|
| `id` | uuid | no | `work_items.id` |
| `key`, `number` | text, number | yes | `RATES-12`, `12` |
| `title` | text | yes | |
| `description` | text | no | |
| `project_id`, `type_id`, `state_id` | uuid | yes | |
| `priority` | number | yes | 0 none, 1 urgent to 4 low |
| `assignee_id`, `reporter_id`, `created_by` | uuid | yes | accept the `$me` macro |
| `start_date`, `due_date` | date | yes | accept date macros |
| `estimate` | number | yes | |
| `confidential` | bool | yes | |
| `sort_order` | number | yes | manual order within a board column |
| `created_at`, `updated_at`, `completed_at`, `canceled_at`, `archived_at` | datetime | yes | |
| `state.category` | enum | yes | via `workflow_states` (`backlog`, `todo`, `in_progress`, `done`, `canceled`) |
| `state.key` | text | yes | via `workflow_states` |
| `type.key` | text | yes | via `item_types` |
| `project.key` | text | yes | via `projects` |
| `labels` | array | no | label ids; ops `has`, `has_any`, `has_all`, `is_empty`, `not_empty` |
| `parent_id` | uuid | yes | derived from `relations` (`parent_of`) |
| `is_blocked` | bool | yes | derived: has open blockers |
| `search` | fts | no | full text; op `match` only |
| `fields.<key>` | per `FieldDef.kind` | yes | JSONB field; the compiler casts `w.fields->>'key'` to `numeric`, `boolean`, `date` or `timestamptz` by kind; multi kinds use `?|` / `?&` |

## Operators

| Op | Applies to | Meaning |
|---|---|---|
| `eq`, `neq` | scalar | equality |
| `in`, `nin` | scalar vs array value | membership |
| `lt`, `lte`, `gt`, `gte` | number, date, datetime, text | ordering |
| `contains`, `starts_with` | text | case-insensitive substring / prefix |
| `is_null`, `not_null` | any | null test (no value) |
| `is_empty`, `not_empty` | arrays, text | empty array, empty string or null |
| `has`, `has_any`, `has_all` | arrays (`labels`, `multi_select` fields) | element membership |
| `match` | `search` | FTS with `websearch_to_tsquery`; trigram fallback on `title` |
| `before`, `after` | date, datetime | strictly before / after; value may be a macro |
| `within_days` | date, datetime | between `$today` and `$today + N` inclusive, N = value |

Edge semantics (nulls under `lt` / `gt`, `nin` against null, empty `in`) are pinned by the parity fixtures rather than prose.

## Macros

Resolved at evaluation time on both sides from `QueryContext { userId, tz, now }`:

| Macro | Value |
|---|---|
| `$me` | current user id |
| `$today` | `YYYY-MM-DD` in `ctx.tz` (default UTC) |
| `$now` | ISO timestamp |
| `$start_of_week`, `$end_of_week` | dates |
| `$start_of_month` | date |

## ViewSpec: one query, four presentations

`views.spec` is `ViewSpec = QuerySpec + presentation`. `kind` only chooses the component; switching a view from list to board keeps the query.

```ts
ViewSpec = QuerySpec & {
  kind?: 'list' | 'board' | 'timeline' | 'dashboard',
  columns?: FieldRef[],                                                   // list
  board?: { column_field (default 'state_id'), swimlane_field?, column_order?, hide_empty? },
  timeline?: { start_field (default 'start_date'), end_field (default 'due_date'), zoom: week|month|quarter, show_dependencies? },
  dashboard?: { widgets: Widget[] },
}
Widget = { id, title, viz: number|bar|pie|line|table|list, query: QuerySpec, group_by?, measure: count|sum_estimate|avg_estimate|sum_field|avg_field, measure_field?, time_bucket?: day|week|month, w: 1..12, h: 1..12 }
```

| kind | Runs | Presentation |
|---|---|---|
| list | `runSpec(spec)` | `columns`; `group_by` becomes collapsible section headers; inline editing |
| board | `runSpec({...spec, group_by: board.column_field})` | groups become columns; `swimlane_field` nests a second grouping; drag between columns is `transitionItem` when `column_field` is `state_id`, otherwise `updateItem` |
| timeline | `runSpec(spec)` | bars from `start_field` to `end_field`; `show_dependencies` draws `blocks` edges from local relations |
| dashboard | per widget: `runSpec(widget.query).groups` plus aggregate; server `compileWidget()` via `POST /api/v1/views/:id/run` | `viz`, `w` / `h` on a 12-column grid |

### List: my open work, most urgent first

```json
{
  "kind": "list",
  "filter": { "and": [
    { "field": "assignee_id", "op": "eq", "value": "$me" },
    { "field": "state.category", "op": "nin", "value": ["done", "canceled"] }
  ]},
  "sort": [ { "field": "priority", "dir": "asc", "nulls": "last" }, { "field": "due_date", "dir": "asc", "nulls": "last" } ],
  "columns": ["key", "title", "state_id", "priority", "due_date", "project.key"],
  "limit": 500
}
```

### Board: RATES bugs by state, swimlanes by severity

```json
{
  "kind": "board",
  "filter": { "and": [
    { "field": "project.key", "op": "eq", "value": "RATES" },
    { "field": "type.key", "op": "eq", "value": "bug" },
    { "field": "state.category", "op": "nin", "value": ["canceled"] }
  ]},
  "sort": [ { "field": "sort_order", "dir": "asc" } ],
  "board": { "column_field": "state_id", "swimlane_field": "fields.severity", "hide_empty": false }
}
```

### Timeline: this quarter's initiatives with dependencies

```json
{
  "kind": "timeline",
  "filter": { "and": [
    { "field": "type.key", "op": "eq", "value": "initiative" },
    { "field": "fields.quarter", "op": "eq", "value": "2026Q4" }
  ]},
  "sort": [ { "field": "start_date", "dir": "asc" } ],
  "timeline": { "start_field": "start_date", "end_field": "due_date", "zoom": "quarter", "show_dependencies": true }
}
```

### Dashboard: desk health

The outer `filter` scopes every widget; each widget ANDs its own filter with it.

```json
{
  "kind": "dashboard",
  "filter": { "field": "project.key", "op": "eq", "value": "RATES" },
  "dashboard": { "widgets": [
    { "id": "open", "title": "Open items", "viz": "number", "measure": "count",
      "query": { "filter": { "field": "state.category", "op": "nin", "value": ["done", "canceled"] } }, "w": 3, "h": 2 },
    { "id": "blocked", "title": "Blocked", "viz": "number", "measure": "count",
      "query": { "filter": { "field": "is_blocked", "op": "eq", "value": true } }, "w": 3, "h": 2 },
    { "id": "by_assignee", "title": "Open by assignee", "viz": "bar", "group_by": "assignee_id", "measure": "count",
      "query": { "filter": { "field": "state.category", "op": "in", "value": ["todo", "in_progress"] } }, "w": 6, "h": 4 },
    { "id": "sev", "title": "Open bugs by severity", "viz": "pie", "group_by": "fields.severity", "measure": "count",
      "query": { "filter": { "and": [ { "field": "type.key", "op": "eq", "value": "bug" },
                                       { "field": "state.category", "op": "nin", "value": ["done", "canceled"] } ] } }, "w": 4, "h": 4 },
    { "id": "burn", "title": "Completed per week", "viz": "line", "group_by": "completed_at", "time_bucket": "week", "measure": "sum_estimate",
      "query": { "filter": { "field": "completed_at", "op": "after", "value": "$start_of_month" } }, "w": 8, "h": 4 },
    { "id": "due", "title": "Due in 7 days", "viz": "list", "measure": "count",
      "query": { "filter": { "field": "due_date", "op": "within_days", "value": 7 }, "sort": [ { "field": "due_date", "dir": "asc" } ], "limit": 20 }, "w": 12, "h": 4 }
  ]}
}
```

## Server and client execution

**Server.** `compileQuery(spec, ctx, opts)` returns `{ text, values, isAggregate }` over `work_items_v w`. `labels` compiles to an `EXISTS` over `work_item_labels`; `search` with `match` compiles to `w.search @@ websearch_to_tsquery('english', $n)` ordered by `ts_rank`, with a `title % $n` (pg_trgm) fallback when FTS finds nothing. The permission scope is appended as an extra WHERE (`visibilityWhere(userId)`), mirroring `can_view_item()`. `group_by` yields an aggregate query used by board counts and `compileWidget()`.

**Client.** `runSpec(spec, items, ctx, lookups)` returns `{ items, groups }`. `lookups` carries the local `states`, `types`, `projects`, `labelIdsByItem`, `parentByItem` and `blockedItems`, so dotted refs resolve without joins. Everything on screen comes from `runSpec` over local rows; only deep search (`GET /api/v1/search`) and dashboards over data you have not synced go to the server.

**Over HTTP.** `POST /api/v1/items/query {spec}` returns `{items, groups?, total}`; `POST /api/v1/views/:id/run` runs a saved view (dashboards return `{widgets:[{id, rows:[{key,label,value}]}]}`). The MCP tool `query_items` wraps the former and `run_view` the latter.

## URL state and Save view

The route `/p/:projectKey/v/:viewId` (and `/v/:viewId` for cross-project views) parses `views.spec`, merges **unsaved overrides from the URL** (`?filter=<base64 json>&sort=…&group=…&columns=…&kind=…`) and runs the result locally. A filtered URL is therefore shareable without creating a view.

Toolbar actions: view name (rename inline), kind switcher, Filter, Sort, Group, Columns (list), board and timeline options, **Save** (writes `updateView` to the current view: own, or shared when you hold `view.edit_shared`), **Save as** (`createView`), the share toggle (`is_shared`), and "Set as default" (`is_default`). `/p/:projectKey/new-view` and `/views/new` start a view from scratch.

## Filter builder

- A row is a field picker (built-ins by label from `BUILTIN_FIELDS`, then `fields.<key>` of the types present in the project with labels from `field_defs`, then `labels`, `parent_id`, `is_blocked`, `search`), an operator picker filtered to what the field kind supports, and a value control that offers macros for user and date fields (Me, Today, Start of week...).
- Conditions edited in the builder are a flat AND. `or` / `not` groups authored elsewhere (API, MCP, the JSON tab) are preserved verbatim.
- Changes apply instantly to the local result and land in the URL; Save writes them back.

## Seeded views

Every seeded project has four shared views: `All open` (list, default, sorted by priority then due date), `Board` (by `state_id`, canceled hidden), `Roadmap` (timeline of initiatives) and `Overview` (dashboard with four widgets). Alice also owns a private `My work` list grouped by project and two shared cross-project lists, `Overdue across the firm` and `Regulatory work` (filter `labels has regulatory`).

## Adding to the grammar

A new `FieldRef` or `FilterOp` is added to `spec.ts`, implemented in both `compile.ts` and `evaluate.ts`, and covered by a new parity fixture. The grammar is deliberately closed: joins beyond the dotted lookups and arbitrary expressions are not expressible ([ADR-006](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-006-views-as-saved-queries.md)).
