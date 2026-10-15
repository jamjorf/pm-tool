# ADR-006: Views are saved queries over one composable query layer

**Status:** accepted · **Date:** 2026-10

## Context

Lists, boards, timelines and dashboards are usually built as separate screens
with separate data access, which means four filter UIs, four permission paths
and four ways for the client and server to disagree. The tool is local-first,
so the same query must run in the browser over synced rows and on the server
as SQL (for the API, MCP, exports and dashboards over large scopes).

## Decision

A single JSON grammar, `QuerySpec` (`filter` as an and/or/not tree of
`{field, op, value}`, `sort`, `group_by`, `limit`, `offset`,
`include_archived`), with a fixed `FieldRef` vocabulary (columns, dotted
lookups such as `state.category` and `type.key`, `fields.<key>`, `labels`,
`parent_id`, `is_blocked`, `search`), a fixed `FilterOp` set and value macros
(`$me`, `$today`, `$now`, `$start_of_week`, `$end_of_week`,
`$start_of_month`).

Two executors in `@pm/core` with a parity test suite: `compileQuery` →
parameterised SQL over `work_items_v` (plus the permission scope);
`runSpec` → in-memory evaluation over local rows with lookups. `views.spec`
is `ViewSpec = QuerySpec + presentation` (`columns`, `board`, `timeline`,
`dashboard.widgets`), and `kind` only selects the component. A dashboard
widget is `QuerySpec + group_by + measure`.

## Consequences

* (+) One filter builder, one permission path, one semantics. A board over
  `fields.severity` is the same component as a board over state.
* (+) Views are rows: shareable, syncable, versioned in the activity log,
  usable by the API (`/items/query`, `/views/:id/run`) and by agents.
* (+) Switching a view's kind keeps the query; URL state carries unsaved
  edits.
* (+) The client never waits on the network to render a view.
* (−) The grammar is deliberately closed; joins beyond the dotted lookups and
  arbitrary expressions are not expressible. New needs are added as new
  `FieldRef`s or ops with tests on both executors.
* (−) Parity is a maintenance obligation: every op change needs a fixture
  case.
* (−) Client-side aggregation over very large scopes is bounded by what is
  synced; dashboards fall back to the server.

## Alternatives considered

* **Per-screen hand-written queries.** Fastest first screen, divergent
  forever.
* **GraphQL / exposing SQL fragments.** Powerful, but cannot be evaluated
  locally and makes permission scoping and audit of "what did this view show"
  harder.
* **Server-rendered views only.** Simpler parity, but loses instant
  navigation and offline use, the central UX promise.
