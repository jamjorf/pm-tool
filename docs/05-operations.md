# 05 — Operations, security and roadmap

## 1. Stack rationale

| Choice | Why |
|---|---|
| **Postgres 16** (15+ works) | One database holds the model, the audit log, the search index, the sync bookkeeping and the queues. Triggers enforce invariants regardless of client. Recursive CTEs and JSONB make graph queries and typed fields native. The firm's DBAs already run it. |
| **TypeScript monorepo (pnpm)** | One language for the browser, server, MCP server and shared logic; `@pm/core` is imported by all of them so query semantics, workflow guards and permissions cannot drift. |
| **Fastify 5** | Fast, schema-friendly, plugin model fits mounting `@pm/integrations` routes. |
| **React 18 + Replicache** | Local-first with a documented push/pull protocol; optimistic mutations that reuse the server's mutation vocabulary; works offline. |
| **Zod 3** | One schema language for rows, mutation args, `FieldDef`, guards/effects and `ViewSpec`. |
| **Single region, one process, no microservices** | "The hard parts are the data model and the sync, not scale." A firm's PM traffic is tens of writes per second at peak. Every extra service is an on-call surface and a place for the audit trail to leak. See [ADR-008](adr/ADR-008-monolith-single-region.md). |

## 2. Deployment

### 2.1 Topology

One API process (Node 22) and one Postgres, in one region, behind a reverse
proxy that terminates TLS. The web app is static files served by the proxy
(or by the API process). The MCP server runs where the agent runs (developer
laptop, CI runner) and talks to the API over HTTPS.

```
Internet ──TLS──▶ reverse proxy ──▶ /            static web build (packages/web/dist)
                                 ├─▶ /api, /auth, /me, /sync, /integrations, /health   → api:3001
                                 └─▶ /sync/poke  (SSE: disable response buffering, long timeouts)
                     api ───────────▶ postgres:5432
                     api ───────────▶ SMTP · Slack API · GitHub API · your webhook receivers
```

### 2.2 Production compose example

The firm runs containers with Podman. The file below follows the Compose
specification and is started with `podman compose up -d` (Podman 4.1+ with
`podman-compose` as the provider); rootless Podman is fine for the API, and
`podman generate systemd` or Quadlet units turn the same services into
systemd-managed units on the host. Image references are fully qualified so
Podman never has to guess a registry.

```yaml
services:
  postgres:
    image: docker.io/library/postgres:16
    environment:
      POSTGRES_USER: pm
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
      POSTGRES_DB: pmtool
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backups:/backups
    command: ["postgres", "-c", "wal_level=replica", "-c", "archive_mode=on",
              "-c", "archive_command=cp %p /backups/wal/%f", "-c", "max_connections=100"]
    secrets: [pg_password]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pm -d pmtool"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  api:
    build: { context: ., dockerfile: Containerfile }   # pnpm install; pnpm --filter @pm/core build; pnpm -r build
    command: ["node", "packages/api/dist/server.js"]
    env_file: .env.production
    environment:
      DATABASE_URL: postgres://pm:${PG_PASSWORD}@postgres:5432/pmtool
      PORT: "3001"
      HOST: "0.0.0.0"
      AUTH_MODE: magic_link
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

  migrate:
    build: { context: ., dockerfile: Containerfile }
    command: ["pnpm", "db:migrate"]
    environment:
      DATABASE_URL: postgres://pm:${PG_PASSWORD}@postgres:5432/pmtool
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"

  proxy:
    image: docker.io/library/caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./packages/web/dist:/srv/web:ro
      - caddy_data:/data
    depends_on: [api]
    restart: unless-stopped

secrets:
  pg_password: { file: ./secrets/pg_password }
volumes: { pgdata: {}, caddy_data: {} }
```

```caddyfile
pm.example.com {
  encode gzip
  @api path /api/* /auth/* /me* /sync/* /integrations/* /health
  handle @api {
    reverse_proxy api:3001 {
      flush_interval -1          # SSE for /sync/poke
      transport http { read_timeout 1h }
    }
  }
  handle {
    root * /srv/web
    try_files {path} /index.html
    file_server
  }
}
```

### 2.3 Environment variables

From `.env.example`; `DATABASE_URL` is the only required one.

| Variable | Purpose | Production note |
|---|---|---|
| `DATABASE_URL` | Postgres connection | use a dedicated role (see §3.5) |
| `PORT`, `HOST` | API bind | `3001`, `0.0.0.0` in a container |
| `APP_SECRET` | signs session cookies and is the default for signatures | ≥ 32 random bytes; rotating it logs everyone out |
| `APP_URL` | public web URL (links in notifications, Slack, email) | `https://pm.example.com` |
| `API_URL` | public API URL (used by MCP and integration callbacks) | same host as `APP_URL` behind the proxy |
| `AUTH_MODE` | `dev` enables `/auth/dev-login`; otherwise magic link | never `dev` in production |
| `SMTP_URL`, `EMAIL_FROM` | outbound email | unset = log only |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Slack | optional |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` | GitHub | optional |
| `MCP_TRANSPORT`, `PM_API_KEY` | MCP server | per agent host, not on the API server |

### 2.4 Backups

* **Logical, nightly**: `pg_dump -Fc pmtool > pmtool-$(date +%F).dump`; keep
  30 daily + 12 monthly off-box (object storage with versioning/immutability).
* **Continuous, WAL**: `archive_mode=on` with `archive_command` to object
  storage (or `pgBackRest`/`wal-g`) gives point-in-time recovery. Base
  backup weekly.
* **Restore drill** quarterly: restore to a scratch instance, run
  `select count(*) from activity_events`, open the app against it.
* The activity log is the audit source, so the backup retention policy must
  be at least as long as the audit retention policy (§4).

### 2.5 The activity log as the audit source

* `activity_events` is append-only at the database level (triggers raise on
  UPDATE/DELETE/TRUNCATE). Verify after every migration:
  `update activity_events set source = source where false;` must still raise
  `42501` on a real row.
* Nightly export for the compliance archive:
  `psql -c "\copy (select * from activity_events where created_at >= now() - interval '1 day') to '/backups/audit/events-$(date +%F).csv' csv header"`.
* Grant `SELECT` on `activity_events` and `work_items_v` to a read-only
  `audit` role for compliance queries; they need nothing else.

### 2.6 Monitoring

| Signal | Source | Alert when |
|---|---|---|
| `GET /health` | API | non-200 for 1 min |
| Push latency p95, pull size | API logs (Fastify/pino) | push p95 > 500 ms (advisory-lock contention, §5) |
| `select count(*) from webhook_deliveries where status in ('pending','failed') and next_attempt_at < now() - interval '5 minutes'` | SQL | > 0 for 10 min (dispatcher stalled) |
| `… where status = 'dead' and created_at > now() - interval '1 day'` | SQL | > 0 (receiver down) |
| `select count(*) from notification_deliveries where sent_at is null and scheduled_for < now() - interval '15 minutes'` | SQL | > 0 |
| `select count(*) from sync_client_groups where resync_required` | SQL | sustained high counts = churn |
| Postgres: connections, replication lag (if replica), `pg_stat_statements` top queries, table bloat on `work_items` | standard exporters | |
| Disk: `pg_total_relation_size('activity_events')` growth | SQL | plan partitioning when > ~50 GB |

Logs are structured JSON from the API (request id, user id, mutation name,
duration). Do not log mutation args (they contain item content).

### 2.7 Secrets

`APP_SECRET`, `DATABASE_URL`, Slack/GitHub secrets, SMTP credentials and
webhook endpoint secrets. Keep them in the platform's secret store (compose
secrets, Vault, cloud secret manager), never in the image or the repo. Webhook
endpoint secrets are generated by the server on `POST /api/v1/webhooks` and
stored in `webhook_endpoints.secret`; API keys are stored only as sha256
hashes.

## 3. Security

### 3.1 Sessions and authentication

* Magic-link login (`POST /auth/magic-link` → `GET /auth/callback?token=`);
  in `AUTH_MODE=dev` the link is logged and `/auth/dev-login` exists. For SSO,
  put the firm's identity-aware proxy or OIDC in front and map the asserted
  email to `users` (implementation detail; the user table already keys on
  lowercase email).
* Cookie `pm_session`: httpOnly, `Secure`, `SameSite=Lax`, signed with
  `APP_SECRET`; server-side row in `sessions` (`token_hash`, `expires_at`,
  `last_seen_at`) so sessions can be revoked. Expire after 30 days idle
  (implementation detail).
* Deactivating a user (`PATCH /api/v1/users/:id {is_active:false}`) must
  invalidate sessions and API keys at the auth layer; their history remains.

### 3.2 API keys

`pm_<random>`; sha256 stored; `key_prefix` for display; `scopes` (`read`,
`write`); `expires_at`; `revoked_at`; `last_used_at` for hygiene reviews.
Keys inherit the owner's permissions and are logged as `actor_kind='api_key'`
with the key name.

### 3.3 CORS, CSRF, headers

* CORS: allow only `APP_URL` with credentials; API keys do not need CORS.
* CSRF: `SameSite=Lax` cookie + JSON content type + origin check on state
  changing routes (implementation detail).
* Standard headers via the proxy: HSTS, `X-Content-Type-Options`, CSP for the
  SPA (self + `APP_URL`/`API_URL`), no inline scripts.

### 3.4 Rate limits and signatures

* Per credential: e.g. 600 requests/min for sessions and keys, 60/min for
  `/auth/*`, 10/min for `/me/api-keys` (implementation detail; use
  `@fastify/rate-limit`).
* Inbound integrations verify provider signatures (Slack signing secret,
  GitHub `X-Hub-Signature-256`) and are idempotent via `inbound_events`.
* Outbound webhooks are signed with each endpoint's secret
  (`X-PM-Signature`).

### 3.5 Database roles

| Role | Grants |
|---|---|
| `pm_migrate` | owner of the schema; runs migrations |
| `pm_app` (`DATABASE_URL`) | `SELECT/INSERT/UPDATE` on all tables, `INSERT/SELECT` only on `activity_events`, `USAGE` on sequences, `EXECUTE` on functions |
| `pm_audit` | `SELECT` on `activity_events`, `work_items_v`, `users` |

With this split, even a compromised application credential cannot alter
history.

## 4. Data retention and legal hold

* **Default: retain everything.** Items are soft-deleted; the log is
  append-only.
* **Policy-driven purge**, if required by the firm's records policy: archive
  (`archived_at`) rather than delete; for the log, partition by `created_at`
  (monthly) and detach/export partitions older than the retention period under
  change control by `pm_migrate` — never `DELETE`.
* **Legal hold**: a `settings` key (`{"legal_hold": {"projects": [...],
  "until": …}}`, implementation detail) that the purge job checks; held
  projects' partitions are not detached and their items cannot be hard-purged.
* **Subject access / export**: `GET /api/v1/export/items.csv?project=` plus
  the nightly audit CSVs cover "everything about initiative X" and "everything
  user Y did".
* **PII**: user names/emails are in `users`; item content is wherever users
  typed it. Classify the database as a whole at the level of the most
  sensitive project it holds, or split sensitive desks into a separate
  deployment (the schema is standalone; two instances are cheap).

## 5. Scaling path

The design is sized for a firm, not the internet. In order of likelihood:

1. **Read replica** for dashboards, exports and compliance queries (`pm_audit`
   points at the replica). No code change.
2. **Archive old items**: set `archived_at` on completed items older than N
   months; the sync snapshot excludes archived rows unless requested
   (`include_archived`), keeping the client store small.
3. **Second API process**: move poke from the in-memory emitter to Postgres
   `LISTEN/NOTIFY`; the advisory lock already serialises across processes.
4. **Row-versioned sync** when push p95 exceeds ~500 ms from lock contention
   or snapshots exceed tens of MB per user: replace the global version cookie
   with per-client-group client-view records (Replicache's row versioning
   strategy). The client protocol does not change.
5. **Search service** (Meilisearch/Typesense; `pgvector` for semantic) when
   the conditions in [02-design.md §7](02-design.md#7-search) hold; fed from
   the activity log cursor.
6. **Partition `activity_events`** by month when it passes ~50 GB.

What is explicitly *not* on the path: microservices, a message broker, a
cache tier, multi-region writes.

## 6. Roadmap: desk-level and strategy-level tools

The firm's plan is to start generic and add desk-specific tooling once
adoption exists. In this design that means **new item types, workflows and
views — not new applications**. Each example below is rows (types, workflow
states/transitions, labels, views) plus, where noted, a small code addition in
`@pm/core` for a new guard type.

| Tool | Item type (`field_defs`) | Workflow | Guards / effects | Views |
|---|---|---|---|---|
| **Trade idea** | `strategy` (select), `notional` (number), `horizon` (select), `thesis` (long_text), `risk_signoff` (bool), `desk_approved_by` (user), `approved_at` (datetime) | `trade_idea_review`: Draft → Desk review → Risk review → Approved → Live / Rejected (full INSERT example in [01-data-model.md §4.4](01-data-model.md#44-adding-a-desk-specific-workflow-with-inserts-only)) | `require_role admin` on both approvals, `field_equals fields.risk_signoff true`, `no_open_blockers`, `notify project_admins` on submit, `webhook item.completed` on go-live | Board by state with swimlane `fields.strategy`; dashboard: ideas by horizon, notional approved per week |
| **Model change** (quant library / pricing model) | `model` (select), `change_class` (select: parameter / methodology / bugfix), `validator` (user), `second_reviewer` (user), `backtest_url` (url), `prod_date` (date) | `model_change`: Proposed → Implemented → Validated → Approved (4-eyes) → Released | 4-eyes: `require_role admin` on Approve plus a new core guard `require_field_not_actor {field: 'fields.validator'}` so the validator cannot approve their own validation; `require_label backtested`; `transition_parent_if` to roll up into the release initiative | List grouped by `fields.model`; timeline on `prod_date` |
| **Client onboarding** (KYC) | `client_name` (text), `entity_type` (select), `jurisdiction` (select), `kyc_tier` (select), `kyc_docs` (url, multi), `aml_check` (bool), `compliance_owner` (user), `go_live_target` (date) | `onboarding`: Intake → Documents → KYC review → Compliance sign-off → Account opened / Declined | `require_field fields.kyc_docs` before KYC review; `field_equals fields.aml_check true` and `require_role admin` for sign-off (compliance are the project admins of the `ONB` project); `set_field completed_at $now`; `webhook item.completed` to the account-opening system | Board by state; dashboard: onboarding by jurisdiction, days in KYC review (cycle time from the activity log) |
| **Incident / RCA** | `severity`, `detected_at`, `services` (multi_select), `rca_doc` (url) | `incident`: Open → Mitigated → RCA due → Closed | `require_field fields.rca_doc` before Closed; `transition_children complete` for follow-ups | Dashboard: MTTR per month from `state_id` events |
| **Strategy roadmap** | reuse `initiative` with extra fields `strategy` (select), `pnl_impact` (number) | `standard` | `children_in_category` already gates completion | Timeline per strategy with dependencies; rollup by quarter (SQL in 01-data-model.md §5.3) |

Order of introduction: (1) ship generic tasks/bugs/initiatives/requests to a
couple of friendly desks; (2) add one desk workflow with a real approval step
(trade idea or model change) because approvals are where the audit log pays
for itself; (3) add compliance-facing views and the `pm_audit` role; (4) then
the KYC flow, which needs the most fields and the most people from outside
engineering.

## 7. Adoption playbook

1. **Seed with real work.** Import the desks' existing spreadsheets as items
   with the API (`POST /api/v1/items`, `fields` per type). Keys in the
   spreadsheet's order so people recognise them.
2. **One project per desk, firm-visible by default.** Private projects only
   where compliance requires it; `confidential` per item for the rest.
3. **Integrations first week**: Slack unfurls and `/pm` (zero-effort
   visibility), GitHub links for engineering desks, email-in for everyone who
   will not open another tool.
4. **Keep notifications quiet.** Leave the defaults; teach `w` (watch) and
   digests. The fastest way to lose adoption is a noisy inbox.
5. **Give people views, not training.** Create 3–4 shared views per project
   (My desk this week; Blocked; Due soon; Initiatives timeline) and set a
   default. The `?` cheatsheet does the rest.
6. **Let the data model follow usage.** When a desk keeps writing the same
   thing in the description, make it a field. When a label is used as a
   state, make it a state. Both are inserts.
7. **Show the audit value early.** Give compliance the `pm_audit` role and one
   saved query ("all state changes on approvals this month") in the first
   month.
8. **Agents last, with read-only keys.** Once a desk's views are stable, add
   the MCP server with a `read` key for summaries; move to `write` for triage
   only when the desk asks.
