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
   (vitest). Integration tests need Postgres: use `DATABASE_URL` (default
   `postgres://postgres:postgres@localhost:5432/pmtool`) and start it with
   `podman compose up -d postgres` if not running. If Podman is unavailable,
   install Postgres locally; if neither is possible, keep going and mark the
   DB-dependent tests as `skip` when `DATABASE_URL` is unreachable — but say
   so in `PLAN.md`.
5. **Commit as you go.** `git init` at the start; one commit per phase with a
   message naming the phase and what passes. Never commit `.env`,
   `node_modules` or `dist`.
6. **No questions, no placeholders.** Do not leave `TODO`s in shipped code.
   If something is genuinely ambiguous, implement the simplest version that
   satisfies the tests and document it.
7. **Finish with the verification checklist (§9)** and make every line pass
   before declaring done (§10).

Tooling assumptions: Node ≥ 22, pnpm 10 (`corepack enable && corepack prepare
pnpm@10.28.0 --activate`), Podman 4.1+ with podman-compose (for Postgres 16), git.

---

## 1. What you are building

A firm-wide project management tool for a financial firm (desks, strategies,
regulated). It starts generic and must let the firm add desk-level and
strategy-level tooling later by adding **data** (item types, workflows,
views), not applications.

### 1.1 The data model (five non-negotiables)

1. **One generic work item** with a `type` and typed columns plus validated
   JSONB fields (`work_items.fields`, validated against
   `item_types.field_defs` by a DB trigger and by `@pm/core`). No table per
   type.
2. **Workflows as an explicit, data-driven state machine per type**:
   `workflows` → `workflow_states` (with a closed `category`) →
   `workflow_transitions` with `guards[]` and `effects[]` as JSON, evaluated
   by a pure engine shared by client and server.
3. **A typed relation edge table** (`relations` + `relation_types`
   registry): parent/child, blocks, duplicates, relates-to, links to external
   entities (GitHub PR, Slack thread, email, URL). Dependencies and rollups
   are graph queries (`item_descendants`, `item_ancestors`,
   `item_open_blockers`, `item_rollup`). Triggers enforce acyclicity and a
   single parent.
4. **An append-only activity log, one event per field change**
   (`activity_events`, UPDATE/DELETE/TRUNCATE physically blocked). It drives
   history, audit, notifications, undo, webhooks and analytics.
5. **Permissions decided up front: per-project roles** (`admin`/`editor`/
   `viewer`) plus firm role (`owner`/`admin`/`member`/`guest`), project
   visibility (`firm`/`private`) and a per-item `confidential` flag.
   Attribute-style rules live in workflow guards. SQL functions
   `effective_project_role()`, `can_view_item()`, `visible_project_ids()`
   are the authority; `@pm/core` mirrors them.

### 1.2 The tool

* **Views are saved queries.** Lists, boards, timelines and dashboards are
  the same `QuerySpec` (filter / sort / group) plus presentation, stored in
  `views.spec`. One composable query layer with two executors: SQL on the
  server (`compileQuery`) and in-memory on the client (`runSpec`), with
  parity tests.
* **UX:** keyboard-first command palette (`⌘K`), instant navigation on
  local data (Replicache, IndexedDB), bulk edit, good search (Postgres FTS +
  trigram until it isn't), low-noise notifications (inbox, collapsing,
  digests, quiet hours).
* **Integrations:** webhooks out (HMAC-signed, retried), a clean REST API
  in (session cookie or API key), Slack (unfurls, autolink, `/pm` slash
  command, interactive buttons, DMs), email (inbound address scheme
  `pm+KEY-12@domain`, SMTP out), GitHub (PR/issue links, `Fixes KEY-12` on
  merge), and an **MCP server** so agents can read and act on tickets.
* **Stack:** Postgres 16, TypeScript monorepo (pnpm, ESM, NodeNext), Fastify
  5 API, React 18 + Vite + Replicache web app, zod 3, vitest. **Single
  region, one API process, no microservices, no queue, no cache.** The hard
  parts are the data model and the sync, not scale.

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
├── compose.yml
├── README.md
├── PLAN.md                      (yours)
├── docs/
│   └── ARCHITECTURE.md          (§3, verbatim)
└── packages/
    ├── db/            @pm/db            migrations/0001_init.sql (§4), src/{migrate,seed,reset}.ts
    ├── core/          @pm/core          src/{index,schema/entities,query/{spec,compile,evaluate},mutations,workflow/{types,engine},permissions/{types,evaluate},fields,events}.ts
    ├── api/           @pm/api           src/{server,app,db,auth,sync,mutations/*,routes/*,workers/*,integrations}.ts
    ├── integrations/  @pm/integrations  src/{index,deps,slack,github,email,render}.ts
    ├── mcp/           @pm/mcp           src/{server,client,tools}.ts
    └── web/           @pm/web           index.html, src/{main,app,replicache,...}.tsx
```

Conventions (binding): ESM (`"type":"module"`), TypeScript `NodeNext`,
imports inside a package use `.js` extensions, rows are **snake_case exactly
as in SQL**, ids are UUIDs generated by the client (`crypto.randomUUID()`),
validation with zod 3, tests with vitest, build order `@pm/core` first then
`pnpm -r build`.

### 2.1 `package.json` (root)

```json
<<<FILE:package.json>>>
```

### 2.2 `pnpm-workspace.yaml`

```yaml
<<<FILE:pnpm-workspace.yaml>>>
```

### 2.3 `tsconfig.base.json`

```json
<<<FILE:tsconfig.base.json>>>
```

### 2.4 `.npmrc`

```
<<<FILE:.npmrc>>>
```

### 2.5 `.gitignore`

```
<<<FILE:.gitignore>>>
```

### 2.6 `.env.example`

```bash
<<<FILE:.env.example>>>
```

### 2.7 `compose.yml` (dev, Podman)

```yaml
<<<FILE:compose.yml>>>
```

### 2.8 `README.md`

````markdown
<<<FILE:README.md>>>
````

### 2.9 Per-package `package.json` files

Use these as given (versions are known-good; you may bump patch versions if
installation fails). Each package also gets a `tsconfig.json` extending
`../../tsconfig.base.json` with `outDir: dist`, `rootDir: src`, `include:
["src"]`, `exclude: ["src/**/*.test.ts"]` (add `"lib": ["ES2023","DOM"]` for
core/web/mcp, `"types": ["node"]` for db/api) and a `vitest.config.ts`:
`export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })`
(web: `environment: 'jsdom'`, include `src/**/*.test.{ts,tsx}`).

`packages/core/package.json`:

```json
<<<FILE:packages/core/package.json>>>
```

`packages/db/package.json`:

```json
<<<FILE:packages/db/package.json>>>
```

`packages/integrations/package.json`:

```json
<<<FILE:packages/integrations/package.json>>>
```

`packages/mcp/package.json`:

```json
<<<FILE:packages/mcp/package.json>>>
```

`packages/web/package.json`:

```json
<<<FILE:packages/web/package.json>>>
```

`packages/api/package.json`:

```json
<<<FILE:packages/api/package.json>>>
```

---

## 3. The architecture contract — `docs/ARCHITECTURE.md` (verbatim)

Create this file exactly. It is the contract every package is built against:
query layer, mutation pipeline, sync protocol, HTTP API v1 route list,
webhooks, notification rules, web app behaviour, integrations interface.

````markdown
<<<FILE:docs/ARCHITECTURE.md>>>
````

---

## 4. The database migration — `packages/db/migrations/0001_init.sql` (verbatim, complete)

Create this file exactly. It is self-contained and applies to any Postgres
15+ with `psql -f`. It defines every table, trigger, function, enum, index,
the seeded `standard` and `simple` workflows, the `task`/`bug`/`initiative`/
`request` item types, and the `work_items_v` view.

```sql
<<<FILE:packages/db/migrations/0001_init.sql>>>
```

---

## 5. Core contract files — `packages/core/src/…` (verbatim)

These five files are the shared contract. Create them exactly; then implement
the stubs listed in §5.6 against them.

### 5.1 `packages/core/src/schema/entities.ts`

```ts
<<<FILE:packages/core/src/schema/entities.ts>>>
```

### 5.2 `packages/core/src/query/spec.ts`

```ts
<<<FILE:packages/core/src/query/spec.ts>>>
```

### 5.3 `packages/core/src/mutations.ts`

```ts
<<<FILE:packages/core/src/mutations.ts>>>
```

### 5.4 `packages/core/src/workflow/types.ts`

```ts
<<<FILE:packages/core/src/workflow/types.ts>>>
```

### 5.5 `packages/core/src/permissions/types.ts`

```ts
<<<FILE:packages/core/src/permissions/types.ts>>>
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
  /** Field defs by item type key, to type JSONB fields (fields.<key>) correctly */
  fieldDefs?: Record<string, FieldDef[]>;
  /** Extra WHERE fragments already parameterized, e.g. permission scope. */
  extraWhere?: { text: string; values: unknown[] }[];
  select?: string; // default "w.*"
}
/** Compile a QuerySpec to parameterized SQL over work_items_v. */
export function compileQuery(spec: QuerySpec, ctx: QueryContext, opts?: CompileOptions): CompiledQuery;
/** Compile a dashboard widget into an aggregate query (group_by + measure). */
export function compileWidget(widget: Widget, ctx: QueryContext, opts?: CompileOptions): CompiledQuery;
/** Build the permission-scope WHERE fragment for a user (mirrors can_view_item). */
export function visibilityWhere(userId: string, paramOffset: number): { text: string; values: unknown[] };
```

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
/** Fields of work_items that are tracked one-event-per-field in the activity log (JSONB fields are tracked per key as "fields.<key>"). */
export const TRACKED_ITEM_FIELDS: (keyof WorkItem)[] = [
  'title', 'description', 'type_id', 'state_id', 'priority', 'assignee_id', 'reporter_id', 'start_date', 'due_date',
  'estimate', 'confidential', 'archived_at', 'project_id', 'sort_order',
];
export type FieldChange = { field: string; old: unknown; new: unknown };
/** Diff two item snapshots into one change per field (JSONB fields expanded to "fields.<key>"). */
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
<<<FILE:packages/integrations/src/deps.ts>>>
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

Files: `migrations/0001_init.sql` (§4, verbatim), `src/migrate.ts`,
`src/seed.ts`, `src/reset.ts`, `src/index.ts` (exports `migrate(databaseUrl)`,
`seed(databaseUrl)`), `src/*.test.ts`.

* `migrate.ts`: creates `schema_migrations(filename text primary key, applied_at
  timestamptz)` if missing, applies every `migrations/*.sql` not yet recorded
  in filename order, each inside one transaction, using the `postgres` driver
  (`sql.unsafe`/`sql.file`). Idempotent. Exits non-zero on error.
* `reset.ts`: `drop schema public cascade; create schema public;` then migrate
  and seed. Refuses when `NODE_ENV=production`.
* `seed.ts`: implements §8 using plain SQL inserts (it may import nothing from
  other packages). Idempotent: skips when `users` already has `alice@firm.com`.

**Tests (`src/db.test.ts`, require `DATABASE_URL`; create a temporary database
`pmtool_test_<random>` and drop it after):**

1. Migration applies on an empty database without error; running `migrate`
   twice is a no-op.
2. `insert into work_items` without `number` yields `number = 1`, `key =
   'RATES-1'`; the second item gets `RATES-2`; `projects.item_seq` is 2.
3. `trg_validate_item_fields`: unknown key rejected (`23514`); missing
   required `severity` on a `bug` rejected; wrong type (`severity: 1`)
   rejected; a valid bug inserts.
4. `trg_validate_item_state`: a `task` with a `simple`-workflow state is
   rejected.
5. Relations: self-edge rejected; duplicate (type, from, to) rejected; second
   parent rejected (unique index); `blocks` cycle A→B→C→A rejected with the
   cycle message; `parent_of` cycle rejected; `relates_to` cycle allowed;
   external edge requires `external_kind` + `external_ref` and forbids
   `to_item_id`; `external_key` is generated as `github_pr:<url>`.
6. `item_descendants` / `item_ancestors` depths; `item_open_blockers` ignores
   done/canceled blockers and deleted items; `item_rollup` counts and
   estimate sums.
7. `activity_events`: UPDATE, DELETE and TRUNCATE each raise `42501`.
8. `effective_project_role` matrix: explicit member row wins over firm role;
   firm owner/admin → admin everywhere; member on firm project → editor;
   member on private project → null; guest without row → null; deleted
   membership ignored. `can_view_item`: confidential visible to admin,
   assignee, reporter, creator; not to another editor. `visible_project_ids`.
9. `trg_set_version`: `version` strictly increases across inserts/updates on
   two different tables; `updated_at` changes on update.
10. `work_items_v` exposes `type_key`, `state_category`, `project_key`,
    `assignee_name`, `label_names`, `parent_id`, `is_blocked`.
11. Seed: after `seed()`, counts match §8 and every seeded view's `spec`
    parses with `ViewSpec` (import from `@pm/core` **in the test only**).

### Phase 2 — `@pm/core`

Files per §5. Pure: no Node-only imports, no I/O (the parity test is the only
file that touches Postgres and it lives in `src/query/parity.test.ts`).

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
  SQL text contains the expected fragment and `values` are positional
  (`$1..$n`), no string interpolation of values; `fields.<key>` casts by
  kind; `labels has` → `EXISTS`; `search match` → `websearch_to_tsquery`;
  macros resolved; `sort` with `nulls`; `group_by` → `isAggregate`;
  `extraWhere` appended; `limit/offset`; `include_archived`; `compileWidget`
  for each `Measure`/`time_bucket`.
* `query/evaluate.test.ts`: every op against in-memory rows, dotted refs via
  lookups, macros with injected `now` and `tz`, sort stability and nulls,
  grouping labels (state name, assignee id, field option label).
* `query/parity.test.ts` (**SQL ↔ local parity**, skips when `DATABASE_URL`
  is unreachable): load a fixture of ≥ 30 items across 2 projects, 3 types,
  labels, parent/blocks relations and varied dates/fields into a temporary
  database (apply §4 first); define ≥ 40 specs covering every op, dotted
  refs, macros, `and/or/not` nesting, sorts with nulls and `group_by`;
  for each spec assert `compileQuery` executed against Postgres and
  `runSpec` over the same rows return **identical ordered id lists** and
  identical group keys.
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
`src/db.ts` (`postgres` client, `withTxn(fn)` that runs `select
pg_advisory_xact_lock(42)` first), `src/auth.ts` (cookie + bearer →
`Actor`), `src/mutations/apply.ts` (`applyMutation(tx, actor, mutation,
meta)` implementing the 8 steps of §3 "Mutations"), `src/mutations/<name>.ts`
one per mutation, `src/activity.ts` (diff → rows), `src/notify.ts`
(rules, collapsing, deliveries), `src/webhooks.ts` (enqueue + dispatcher
loop), `src/sync/{push,pull,poke}.ts`, `src/routes/*.ts`, `src/search.ts`,
`src/integrations.ts` (implements `IntegrationDeps`), `src/workers/
{webhooks,notifications,due_soon}.ts`.

Binding behaviours:

* Error shape and codes exactly as §3; zod errors → 400 `validation` with
  `details.issues`; `PermissionError` → 403 `forbidden`; guard failures →
  409 `guard_failed` with `details.failures`; Postgres `23514` → 400
  `validation`; `23505` → 409 `conflict`; unknown key/uuid → 404 `not_found`.
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
* `transitionItem`: `GuardContext` from SQL (`item_open_blockers`,
  children categories, labels, `effective_project_role`), then
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
* Sync: push/pull/poke exactly as §3 "Sync protocol". KV keys via
  `rowKey()`. Visibility per table as listed. `resync_required` set on
  membership change, project visibility change, item `confidential` change,
  `moveItem`.
* Search: `websearch_to_tsquery('english', q)` + `ts_rank` + `ts_headline`
  snippet; trigram fallback `title % q` ordered by `similarity`; visibility
  applied.
* `GET /api/v1/items`: query params build a `QuerySpec`; `cursor` is opaque
  base64 of `(sort value, id)`; `assignee=me` → `$me`.
* `GET /api/v1/export/items.csv`: streaming CSV of `work_items_v` columns plus
  flattened `fields.*` keys, visibility-filtered.
* Due-soon scheduler: every 10 minutes, `due_soon` notifications for items
  with `due_date = today + 1` not already notified (dedupe via existing
  unread row).
* CORS: `APP_URL` only, credentials true. Rate limit: 600/min per credential,
  60/min on `/auth/*`.

**Tests (`test/*.test.ts`, vitest, real Postgres in a temporary database,
`buildApp()` + `app.inject`):**

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
7. Activity: one row per changed field for a 3-field patch; JSONB keys as
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
16. Search: FTS hit with rank and snippet; typo in title hits via trigram
    fallback; project filter; visibility.
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
`docs/04-integrations.md`, `docs/05-operations.md`, `docs/adr/ADR-001..008.md`
(generic item; workflows as data; edge table; append-only log; per-project
roles; views as saved queries; global-version sync; monolith). Keep them
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
`event_kinds {*}`, `is_active = false`, secret `whsec_seed_do_not_use`.

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

# 2. database
cp .env.example .env
podman compose up -d postgres
pnpm db:migrate         # applies 0001_init.sql; second run prints "nothing to apply"
pnpm db:seed            # idempotent
psql "$DATABASE_URL" -c "select count(*) from work_items"                      # ≥ 40
psql "$DATABASE_URL" -c "update activity_events set source='x' where id=1"    # ERROR 42501 append-only

# 3. tests
pnpm test               # all packages green (parity + API tests need DATABASE_URL)

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
* [ ] `pnpm db:migrate && pnpm db:seed` succeed against a fresh Postgres 16
      and are idempotent.
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
