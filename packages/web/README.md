# @pm/web

Vite + React 18 front end of pm-tool. **Local-first**: every read comes from a
Replicache store in IndexedDB, every write is an optimistic mutator that is
replayed by the server. Navigation never waits on the network.

```bash
pnpm --filter @pm/core build        # once; the web app consumes @pm/core from dist
pnpm --filter @pm/web dev           # http://localhost:5173 (proxies /api, /auth, /sync, /me, /health, /integrations → :3001)
pnpm --filter @pm/web typecheck
pnpm --filter @pm/web test          # vitest + jsdom
pnpm --filter @pm/web build         # dist/
```

## How it syncs

* `src/sync/replicache.ts` creates one Replicache instance per user:
  `name: pm-<userId>`, `pushURL: /sync/push`, `pullURL: /sync/pull`,
  `pullInterval: 60s`, `schemaVersion: '1'`. It subscribes to the SSE stream
  `GET /sync/poke` and calls `rep.pull()` on every `poke` event (reconnects with
  exponential backoff, 1s → 30s). A 401 on push/pull drops the session.
* `src/sync/mutators.ts` implements **one mutator per key of `MutationArgs`**
  (`@pm/core`). Each mutator validates its args with the shared zod schema and
  applies the same write the server would, against KV keys
  `rowKey(table, row)` (`work_items/<id>`, `work_item_labels/<item>/<label>`,
  `relations/<id>`, `item_watchers/<item>/<user>`, …).
  * `createItem` writes a full `work_items` row with `number: 0` and the
    placeholder key `<PROJECT>-?`, the workflow's initial state, field defaults,
    label rows, an optional `parent_of` relation and a reporter watcher. The next
    pull replaces it with the server's row (real number/key).
  * `transitionItem` loads the type's workflow from the local store, builds a
    best-effort `GuardContext` (open blockers from local relations + states,
    children categories, label names, effective role via
    `permissions.effectiveRole`) and runs `workflowEngine.evaluate`. If guards
    pass it applies the engine's `patch` (plus local `add_label`/`remove_label`
    effects); otherwise it throws `GuardError` — the UI already greys out such
    transitions and shows the failures in a tooltip.
  * Server-only mutations (`upsertWorkflow`, `upsertItemType`, project
    membership, …) still write optimistically where simple; the pull is the
    source of truth.
* If the server rejects a mutation it still marks it applied and writes a
  `mutation_rejected` notification; `RejectedMutationToaster` turns unread ones
  into a toast and marks them read. Replicache rolls the optimistic change back
  on the next pull.
* `src/store/provider.tsx` holds one subscription per synced table and derives
  memoized maps (`itemsById`, `itemByKey`, `labelIdsByItem`, `parentByItem`,
  `blockedItems`, `EvalLookups`…). `src/store/hooks.ts` exposes typed selectors
  (`useAllItems`, `useItem(idOrKey)`, `useProject`, `useWorkflows`,
  `useTransitions(item)`, `useLookups`…).
* Only a few things go over HTTP (`src/api.ts`): login, `/me`, FTS search,
  the activity log, admin endpoints (workflows/types/webhooks/integrations/users),
  API keys and CSV export.

## How views work

A view is a saved query: `views.spec` is a `ViewSpec` (= `QuerySpec` +
presentation). `/p/:projectKey/v/:viewId` parses the spec, merges **unsaved
overrides from the URL** (`?filter=<base64 json>&sort=…&group=…&columns=…&kind=…`),
runs it locally with `runSpec()` from `@pm/core` and renders the component for
its kind:

| kind | component | notes |
|---|---|---|
| `list` | `ListView` | virtualized table, inline editing, collapsible groups, selection (`x`, shift+click, ⌘A) → bulk bar |
| `board` | `BoardView` | columns from `board.column_field` (default `state_id`; mixed workflows → `state.category`), swimlanes, drag = transition (guards evaluated locally, failures toast + snap back) or `reorderItem` |
| `timeline` | `TimelineView` | gantt on `timeline.start_field/end_field`, zoom week/month/quarter, today line, drag to move/resize, `blocks` arrows, unscheduled list |
| `dashboard` | `DashboardView` | widgets = `QuerySpec` + `group_by` + `measure`, SVG number/bar/pie/line/table/list; click a slice → list filtered to it |

The toolbar (filter builder, sort, group, columns, layout) only edits the
`ViewSpec`; **Save** writes it back with `updateView`, **Save as** creates a new
view, the share toggle flips `is_shared`. Filter conditions are a flat AND;
`or`/`not` groups authored elsewhere are preserved verbatim.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette (navigate, actions, bulk actions on selection) |
| `/` | Search |
| `?` | Shortcut cheatsheet |
| `c` | New item (quick create) |
| `t` | Toggle theme |
| `Esc` | Close palette / dialog / peek, clear selection |
| `g` then `h` / `i` / `p` / `n` | Go to My work / Inbox / Projects / Notifications |
| `j` / `k` | Next / previous row |
| `Enter` | Open focused item (peek panel) |
| `x` | Toggle row selection |
| `⌘A` | Select all visible rows |
| `shift+click` | Select a range |
| `e` | Edit title of the open item |
| `a` / `p` / `s` / `l` | Assign / priority / state (transition) / label for the selected or open items |

Inside the palette, typing an item key (`RATES-12`) jumps to it; with rows
selected the palette shows "Assign to…", "Set priority…", "Transition →…" (only
transitions allowed for *all* selected items), "Add label…", "Move to project…",
"Set due date…", "Delete" and applies them with `bulkUpdateItems` /
`bulkTransitionItems`.

## Layout

```
src/
  api.ts                 fetch wrapper for non-synced endpoints
  session.tsx            /me, Replicache lifecycle, Actor
  state.tsx              selection / focus / overlays / peek
  sync/                  replicache.ts (client + poke), mutators.ts, context.tsx (useSubscribe)
  store/                 provider.tsx (tables → maps), hooks.ts (selectors), guards.ts (non-hook guard eval)
  lib/                   shortcuts, urlState, theme, toast, util
  components/ui/         Button, Input, Select, Popover/Picker, Dialog, Tooltip, Kbd, Avatar, Badge
  components/shell/      Sidebar, TopBar, PeekPanel, HelpDialog, global shortcuts, rejected-mutation toaster
  components/items/      ItemDetail, properties (pickers/chips), FieldsForm, Comments, Activity, Relations, QuickCreate, useActions
  components/views/      filter.ts, FilterBuilder, ViewToolbar, ListView, BoardView, TimelineView, DashboardView, BulkBar
  components/palette/    actions.ts (pure), CommandPalette (cmdk)
  pages/                 Login, MyWork, ViewPage, ItemPage, Inbox, Search, Settings, projects, admin/*
```
