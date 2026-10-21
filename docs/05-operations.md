# 05 — Operations, security and roadmap

## 1. Stack rationale

| Choice | Why |
|---|---|
| **SQLite** (3.38+, via Node's built-in `node:sqlite`) | One file holds the model, the audit log, the FTS5 search index, the sync bookkeeping and the queues. Triggers enforce invariants regardless of client. Recursive CTEs and the JSON1 functions make graph queries and typed fields native. No server process, no native module, no container, no `sudo`: the deployment is a Node binary and a file. A firm's PM traffic (tens of writes per second at peak, a dataset of a few GB at most) is well inside what one writer handles. See [ADR-009](adr/ADR-009-sqlite-over-postgres.md) for the trade-off and the path back to Postgres. |
| **TypeScript monorepo (pnpm)** | One language for the browser, server, MCP server and shared logic; `@pm/core` is imported by all of them so query semantics, workflow guards and permissions cannot drift. |
| **Fastify 5** | Fast, schema-friendly, plugin model fits mounting `@pm/integrations` routes. |
| **React 18 + Replicache** | Local-first with a documented push/pull protocol; optimistic mutations that reuse the server's mutation vocabulary; works offline. |
| **Zod 3** | One schema language for rows, mutation args, `FieldDef`, guards/effects and `ViewSpec`. |
| **Single region, one process, no microservices** | "The hard parts are the data model and the sync, not scale." Every extra service is an on-call surface and a place for the audit trail to leak. See [ADR-008](adr/ADR-008-monolith-single-region.md). |

## 2. Deployment

### 2.1 Topology

One API process (Node 22.13+) and one SQLite database file, on one host, behind
a reverse proxy that terminates TLS. The web app is static files served by the
proxy (or by the API process). The MCP server runs where the agent runs
(developer laptop, CI runner) and talks to the API over HTTPS. Nothing here
needs root: Node and pnpm install into the service user's home, the database
is a file the service user owns, and the unit below is a user-level systemd
unit.

```
Internet ──TLS──▶ reverse proxy ──▶ /            static web build (packages/web/dist)
                                 ├─▶ /api, /auth, /me, /sync, /integrations, /health   → 127.0.0.1:3001
                                 └─▶ /sync/poke  (SSE: disable response buffering, long timeouts)
                     api ───────────▶ ./data/pmtool.db (+ pmtool.db-wal, pmtool.db-shm)   node:sqlite, WAL
                     api ───────────▶ SMTP · Slack API · GitHub API · your webhook receivers
```

Exactly one process opens the database for writing. The API process also runs
the background loops (webhook dispatcher every 5 s, notification deliveries,
due-soon scheduler); they claim rows in short write transactions and do their
network I/O outside any transaction, so a slow receiver never holds the write
lock.

### 2.2 Directory layout and a systemd unit

```
/srv/pm-tool/                      a clone or an extracted release, owned by the `pm` user
├── .env                           secrets and settings (chmod 600)
├── data/
│   ├── pmtool.db                  the database (DATABASE_URL points here)
│   ├── pmtool.db-wal              write-ahead log; present while the API runs (see §2.4)
│   └── pmtool.db-shm              WAL index; present while the API runs
├── backups/                       output of the nightly `.backup` (§2.5), synced off-box
├── packages/api/dist/server.js    the API entry point
└── packages/web/dist/             the static web build, served by the proxy
```

Build once, then run the API with a user-level systemd unit. No `sudo` is
needed for any of it; `loginctl enable-linger pm` keeps user units running
after the `pm` user logs out.

```bash
# as the `pm` user, in /srv/pm-tool
corepack enable                     # pnpm from package.json "packageManager"
pnpm install --frozen-lockfile
pnpm --filter @pm/core build
pnpm -r --filter './packages/*' build
pnpm db:migrate                     # idempotent; creates ./data/pmtool.db on first run
```

```ini
# ~/.config/systemd/user/pm-tool.service
[Unit]
Description=pm-tool API (Fastify + SQLite)
After=network-online.target

[Service]
WorkingDirectory=/srv/pm-tool
EnvironmentFile=/srv/pm-tool/.env
Environment=NODE_ENV=production
# migrate first, then serve; both read DATABASE_URL from .env
ExecStartPre=/usr/bin/env pnpm db:migrate
ExecStart=/usr/bin/env node packages/api/dist/server.js
Restart=on-failure
RestartSec=2
# give the process time to finish in-flight writes and checkpoint the WAL
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now pm-tool
systemctl --user status pm-tool
journalctl --user -u pm-tool -f
loginctl enable-linger "$USER"      # keep it running when you log out
```

A deploy is: stop the unit, replace the tree (or `git pull` + build), start
the unit. `ExecStartPre` runs any new migration before the API opens the file.
`Restart=on-failure` is the whole "orchestration". Set `HOST=127.0.0.1` in
`.env` so the API only listens for the proxy.

The reverse proxy is unchanged from any other single-process deployment; with
Caddy:

```caddyfile
pm.example.com {
  encode gzip
  @api path /api/* /auth/* /me* /sync/* /integrations/* /health
  handle @api {
    reverse_proxy 127.0.0.1:3001 {
      flush_interval -1          # SSE for /sync/poke
      transport http { read_timeout 1h }
    }
  }
  handle {
    root * /srv/pm-tool/packages/web/dist
    try_files {path} /index.html
    file_server
  }
}
```

### 2.3 Environment variables

From `.env.example`. `DATABASE_URL` is the only one the database layer reads;
it has a default, so even it may be omitted.

| Variable | Purpose | Production note |
|---|---|---|
| `DATABASE_URL` | Path of the SQLite file: relative to the repo root (`./data/pmtool.db`, the default), absolute (`/srv/pm-tool/data/pmtool.db`), with a `sqlite:` or `file:` prefix, or `:memory:` (tests) | put it on local disk, not NFS/SMB (file locking); the directory is created on first open |
| `PM_ROOT` | Base directory for a relative `DATABASE_URL` when the process is not started inside the repo | optional |
| `PORT`, `HOST` | API bind | `3001`, `127.0.0.1` behind the proxy |
| `APP_SECRET` | signs session cookies and is the default for signatures | ≥ 32 random bytes; rotating it logs everyone out |
| `APP_URL` | public web URL (links in notifications, Slack, email) | `https://pm.example.com` |
| `API_URL` | public API URL (used by MCP and integration callbacks) | same host as `APP_URL` behind the proxy |
| `AUTH_MODE` | `dev` enables `/auth/dev-login`; otherwise magic link | never `dev` in production |
| `SMTP_URL`, `EMAIL_FROM` | outbound email | unset = log only |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Slack | optional |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` | GitHub | optional |
| `MCP_TRANSPORT`, `PM_API_KEY` | MCP server | per agent host, not on the API server |

### 2.4 WAL mode and the sidecar files

`openDb()` sets `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`,
`PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 5000` on every
connection. WAL (write-ahead logging) is what lets the sync pull read a
consistent snapshot while a push is writing: readers never block the writer
and the writer never blocks readers.

* `pmtool.db-wal` holds committed pages not yet copied into the main file.
  SQLite checkpoints it automatically at about 4 MB (1,000 pages) and on the
  last connection's close, so it is normally small and disappears when the API
  stops cleanly. A large, persistent `-wal` means a long-running reader is
  pinning it (a stuck export) or the process is not being shut down cleanly.
* `pmtool.db-shm` is the shared-memory index for the WAL; it is recreated on
  open and carries no data of its own.
* `synchronous = NORMAL` under WAL is durable against application crashes;
  the last transactions before an operating-system crash or power loss may be
  rolled back. If that is unacceptable, set `synchronous = FULL` (one fsync
  per commit).
* All three files must live on the same local filesystem and belong to the
  same user. Network filesystems break SQLite's locking; do not put the
  database on one.

### 2.5 Backups

Never copy a live WAL database with `cp`, `rsync` or a snapshot tool that
reads the three files separately: you get the main file without the pages
still in the WAL, or a torn copy. Use SQLite's own backup, which runs through
the library and is consistent even while the API is writing:

* **Nightly, from cron (no downtime)**:

  ```cron
  # m h dom mon dow  command   (crontab -e as the `pm` user)
  15 2 * * *  sqlite3 /srv/pm-tool/data/pmtool.db ".backup /srv/pm-tool/backups/pmtool-$(date +\%F).db" && gzip -f /srv/pm-tool/backups/pmtool-$(date +\%F).db
  ```

  Keep 30 daily and 12 monthly copies off-box (object storage with
  versioning/immutability). `.backup` produces a plain single-file database
  (no WAL); `sqlite3 pmtool-2026-10-21.db "pragma integrity_check"` verifies
  it. `VACUUM INTO '/path/copy.db'` is an equivalent one-statement alternative.
* **Continuous replication** for point-in-time recovery: run
  [Litestream](https://litestream.io) as a sidecar process (also no root). It
  tails the WAL and streams it to object storage; `litestream restore -o
  pmtool.db s3://bucket/pmtool` reproduces the database as of any retained
  point. Litestream must be the only other process touching the file and the
  WAL must not be checkpointed by anything else; it handles checkpoints itself.
* **Restore**: stop the API, move the current `pmtool.db` (and its `-wal`/`-shm`
  files, if present) aside, put the backup in place as `pmtool.db`, start the
  API. The migration runner records nothing new (the backup contains
  `schema_migrations`), WAL mode is re-enabled on open.
* **Restore drill** quarterly: restore to a scratch directory, run
  `sqlite3 scratch.db "select count(*) from activity_events"`, start the API
  against it with `DATABASE_URL=/path/scratch.db PORT=3002`.
* The activity log is the audit source, so the backup retention policy must
  be at least as long as the audit retention policy (§4).

### 2.6 The activity log as the audit source

* `activity_events` is append-only at the database level (triggers raise on
  UPDATE and DELETE). Verify after every migration:
  `sqlite3 data/pmtool.db "update activity_events set source = source where id = (select min(id) from activity_events)"`
  must fail with `activity_events is append-only (UPDATE denied)`.
* Nightly export for the compliance archive (plain CSV, no application code):

  ```bash
  sqlite3 -csv -header /srv/pm-tool/data/pmtool.db \
    "select * from activity_events where created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')" \
    > /srv/pm-tool/backups/audit/events-$(date +%F).csv
  ```

* SQLite has no database roles. Separation of duties is done at the file
  level: the `pm` service account is the only identity that can write
  `data/`; compliance reads from a read-only copy produced by `.backup`
  (or opens the live file with `sqlite3 -readonly`), never from a credential
  that could write. Nightly backups in immutable storage are the proof that
  the log was not rewritten after the fact.

### 2.7 Monitoring

| Signal | Source | Alert when |
|---|---|---|
| `GET /health` | API | non-200 for 1 min |
| Push latency p95, pull size | API logs (Fastify/pino) | push p95 > 500 ms (writer contention, §5) |
| `SQLITE_BUSY` / "database is locked" errors | API logs (`sqliteErrorKind(e) === 'busy'`) | any sustained rate: a second process is writing the file, or a transaction holds the lock across I/O |
| `select count(*) from webhook_deliveries where status in ('pending','failed') and next_attempt_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')` | SQL | > 0 for 10 min (dispatcher stalled) |
| `… where status = 'dead' and created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')` | SQL | > 0 (receiver down) |
| `select count(*) from notification_deliveries where sent_at is null and scheduled_for < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')` | SQL | > 0 |
| `select count(*) from sync_client_groups where resync_required = 1` | SQL | sustained high counts = churn |
| Size of `pmtool.db` and `pmtool.db-wal`; free disk | filesystem | `-wal` > ~100 MB for more than a few minutes (a reader is pinning it); disk < 20% free |
| `pragma integrity_check` on the nightly backup copy | cron | anything but `ok` |
| `select count(*) from activity_events` growth | SQL | plan the archive step in §4 past ~50 GB total file size |

Logs are structured JSON from the API (request id, user id, mutation name,
duration). Do not log mutation args (they contain item content).

### 2.8 Secrets

`APP_SECRET`, Slack/GitHub secrets, SMTP credentials and webhook endpoint
secrets. Keep them in `.env` with mode `600` owned by the service user, or in
the platform's secret store (systemd `LoadCredential=`, Vault, a cloud secret
manager), never in the repo. There is no database password: whoever can read
`data/pmtool.db` can read everything, so the file's permissions (`700` on
`data/`) are the credential. Webhook endpoint secrets are generated by the
server on `POST /api/v1/webhooks` and stored in `webhook_endpoints.secret`;
API keys are stored only as sha256 hashes.

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

### 3.5 Database access

SQLite has no roles, grants or row-level security; access control is the
operating system's.

| Identity | Access | How |
|---|---|---|
| `pm` (the API's service user) | read/write `data/` | owns the directory (`700`); the only process that opens the file for writing |
| Deploys / migrations | run as `pm` | `pnpm db:migrate` from the unit's `ExecStartPre`; migrations are files in the repo under change control |
| Compliance / analysts | read-only copies | `sqlite3 data/pmtool.db ".backup /srv/audit/pmtool-ro.db"` on a schedule, or `sqlite3 -readonly` on the live file as a user in a read-only group; they need nothing else |

With this split a compromised web credential still cannot alter history (the
triggers refuse), and nobody but the service account can touch the file. What
SQLite cannot give you is a *database* credential that may insert into
`activity_events` but not drop the table; if the firm requires that
separation inside the database, that is the signal to move to Postgres (§5).

## 4. Data retention and legal hold

* **Default: retain everything.** Items are soft-deleted; the log is
  append-only.
* **Policy-driven purge**, if required by the firm's records policy: archive
  (`archived_at`) rather than delete; for the log, move whole date ranges into
  a separate archive database under change control, never `DELETE` from the
  live table:

  ```sql
  attach database '/srv/pm-tool/archive/events-2024.db' as a;
  create table if not exists a.activity_events as select * from activity_events where 0;
  insert into a.activity_events select * from activity_events where created_at < '2025-01-01';
  -- then, in a migration run by the deploy identity: recreate activity_events from the retained range
  ```

  After a purge run `VACUUM` (or `VACUUM INTO` a fresh file and swap it in)
  to return the space; SQLite does not shrink files on its own.
* **Legal hold**: a `settings` key (`{"legal_hold": {"projects": [...],
  "until": …}}`, implementation detail) that the purge job checks; held
  projects' rows are excluded from the archive step and their items cannot be
  hard-purged.
* **Subject access / export**: `GET /api/v1/export/items.csv?project=` plus
  the nightly audit CSVs cover "everything about initiative X" and "everything
  user Y did".
* **PII**: user names/emails are in `users`; item content is wherever users
  typed it. Classify the database file as a whole at the level of the most
  sensitive project it holds, or split sensitive desks into a separate
  deployment (the schema is standalone; a second instance is a second file
  and a second unit).

## 5. Scaling path and when to move to Postgres

The design is sized for a firm, not the internet. SQLite's characteristics set
the boundaries:

* **One writer at a time**, for microseconds to milliseconds per transaction.
  Readers are never blocked under WAL. Tens of writes per second leave the
  lock idle most of the time; sustained hundreds per second do not.
* **One host.** Several processes on the same machine can share the file
  (SQLite locks across processes), but the API is written as one process:
  poke is an in-memory emitter, the worker loops assume one instance, and the
  backup story is one file.
* **Reads scale with the host**, not horizontally. The file's working set
  sits in the page cache; a few GB is comfortable.

In order of likelihood:

1. **Archive old items**: set `archived_at` on completed items older than N
   months; the sync snapshot excludes archived rows unless requested
   (`include_archived`), keeping the client store small. No code change.
2. **Bigger host**: more RAM for the page cache, NVMe for the WAL. The whole
   dataset should fit in memory anyway.
3. **Read-only copies** for dashboards, exports and compliance: a periodic
   `.backup` (or a Litestream replica) opened read-only by a second process
   or by analysts. No code change.
4. **Row-versioned sync** when snapshots exceed tens of MB per user or
   membership churn causes constant resyncs: replace the global version cookie
   with per-client-group client-view records (Replicache's row versioning
   strategy). The client protocol does not change.
5. **Search service** (Meilisearch/Typesense) when the conditions in
   [02-design.md §7](02-design.md#7-search) hold; fed from the activity log
   cursor.
6. **Move to Postgres** when any of these is true: push p95 stays above
   ~500 ms from writer contention; a second API process is needed on another
   host (multi-process or multi-region); the firm requires database-level
   separation of duties (a credential that can insert into the log but not
   drop it) or row-level security for direct SQL access by analysts; or the
   file passes tens of GB and backups by copy become slow. The move is
   mechanical by design:
   * the schema uses only portable constructs (text ids, ISO-8601 text
     timestamps, CHECK enums, JSON text, views); the Postgres translation is
     `text` → `uuid`/`timestamptz`/`jsonb` casts, triggers → `plpgsql`,
     `work_items_fts` → a `tsvector` column, `sync_state` → a sequence plus an
     advisory lock (or row versioning);
   * every query goes through the `@pm/db` `sql` tag with positional
     placeholders and JSON/boolean hydration by column name, so the call sites
     keep their shape and the driver swap is inside one package;
   * `visible_items` and `effective_roles` are plain views that Postgres
     accepts as written and that can become RLS policy expressions.
   The original Postgres schema is in the repository history (ADR-009).

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
| **Strategy roadmap** | reuse `initiative` with extra fields `strategy` (select), `pnl_impact` (number) | `standard` | `children_in_category` already gates completion | Timeline per strategy with dependencies; rollup by quarter (SQL in [01-data-model.md §5.3](01-data-model.md#53-graph-views)) |

Order of introduction: (1) ship generic tasks/bugs/initiatives/requests to a
couple of friendly desks; (2) add one desk workflow with a real approval step
(trade idea or model change) because approvals are where the audit log pays
for itself; (3) add compliance-facing views and the read-only audit copy
(§2.6); (4) then the KYC flow, which needs the most fields and the most people
from outside engineering.

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
7. **Show the audit value early.** Give compliance the read-only audit copy
   and one saved query ("all state changes on approvals this month") in the
   first month.
8. **Agents last, with read-only keys.** Once a desk's views are stable, add
   the MCP server with a `read` key for summaries; move to `write` for triage
   only when the desk asks.
