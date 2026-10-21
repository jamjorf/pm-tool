# Operations

One Node 22 process and one SQLite file, on one host, behind a reverse proxy. There is no database server: the API opens `data/pmtool.db` through Node's built-in `node:sqlite`. The web app is static files. The MCP server runs where the agents run. Nothing needs `sudo`: Node and pnpm live in the service user's home and the API runs as a user-level systemd unit. The full document, with the unit file, Caddyfile, WAL details, backup and restore procedures, retention and the roadmap toward desk-level tools, is [docs/05-operations.md](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md); the reasoning is [ADR-008](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-008-monolith-single-region.md) and [ADR-009](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-009-sqlite-over-postgres.md).

## Topology

```
Internet ──TLS──▶ reverse proxy ──▶ /            static web build (packages/web/dist)
                                 ├─▶ /api, /auth, /me, /sync, /integrations, /health   → 127.0.0.1:3001
                                 └─▶ /sync/poke  (SSE: disable response buffering, long timeouts)
                     api ───────────▶ ./data/pmtool.db (+ -wal, -shm)   node:sqlite, WAL mode
                     api ───────────▶ SMTP · Slack API · GitHub API · your webhook receivers
```

The API process also runs the background loops: webhook dispatcher every 5 s, notification deliveries every 30 s, due-soon scheduler hourly. They claim rows in short write transactions and do their network I/O outside any transaction. There is no queue, cache tier or second service, and exactly one process writes the database.

Build and start:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @pm/core build
pnpm -r --filter './packages/*' build
pnpm db:migrate                      # idempotent; creates ./data/pmtool.db on first run
node packages/api/dist/server.js     # serves :3001
# packages/web/dist is served by the proxy
```

For production put the last two steps in a user-level systemd unit (`~/.config/systemd/user/pm-tool.service` with `ExecStartPre=pnpm db:migrate`, `ExecStart=node packages/api/dist/server.js`, `Restart=on-failure`), enable it with `systemctl --user enable --now pm-tool` and run `loginctl enable-linger` so it survives logout. The full unit and a Caddyfile with `flush_interval -1` for SSE are in [docs/05-operations.md §2.2](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#22-directory-layout-and-a-systemd-unit).

## The database file

| File | What it is |
|---|---|
| `data/pmtool.db` | the database; `DATABASE_URL` points here (default `./data/pmtool.db`, relative to the repo root) |
| `data/pmtool.db-wal` | the write-ahead log: committed pages not yet merged into the main file; checkpointed automatically at about 4 MB and on clean shutdown |
| `data/pmtool.db-shm` | the WAL's shared-memory index; recreated on open, holds no data |

`openDb()` sets `journal_mode = WAL` (readers never block the writer and the sync pull reads a consistent snapshot while pushes commit), `synchronous = NORMAL` (durable against process crashes; an OS crash may lose the last few transactions, use `FULL` if that matters), `foreign_keys = ON` and `busy_timeout = 5000`. Keep all three files on the same local filesystem, owned by the service user; never on a network share.

## Environment variables

From [`.env.example`](https://github.com/jamjorf/pm-tool/blob/main/.env.example). Everything has a default; even `DATABASE_URL` may be omitted.

| Variable | Default | Purpose | Production note |
|---|---|---|---|
| `DATABASE_URL` | `./data/pmtool.db` | path of the SQLite file: relative to the repo root, absolute, `sqlite:`/`file:` prefixed, or `:memory:` (tests) | local disk only; the directory is created on first open |
| `PM_ROOT` | unset | base for a relative `DATABASE_URL` when the process does not start inside the repo | optional |
| `PORT`, `HOST` | `3001`, `0.0.0.0` | API bind | `HOST=127.0.0.1` behind the proxy |
| `APP_SECRET` | placeholder | signs session cookies; default for signatures | at least 32 random bytes; rotating it logs everyone out |
| `APP_URL` | `http://localhost:5173` | public web URL (links in notifications, Slack, email; CORS origin) | `https://pm.example.com` |
| `API_URL` | `http://localhost:3001` | public API URL (MCP, integration callbacks) | same host as `APP_URL` behind the proxy |
| `AUTH_MODE` | `dev` | `dev` enables `POST /auth/dev-login` and returns magic links in the response; anything else is magic link only | never `dev` in production |
| `SMTP_URL`, `EMAIL_FROM` | empty, `pm-tool@example.com` | outbound email | unset means emails are logged |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | empty | Slack | optional |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` | empty | GitHub | optional |
| `MCP_TRANSPORT`, `PM_API_KEY` | `stdio`, empty | MCP server | set on the agent host, not on the API server |

The MCP server additionally reads `MCP_PORT` and `MCP_HOST` for the HTTP transport ([[MCP Server]]).

## Backups

Never copy a live WAL database with `cp` or `rsync`; you get the main file without the pages still in the WAL. Use SQLite's backup API, which is consistent while the API is writing:

- **Nightly, from cron (no downtime)**: `sqlite3 /srv/pm-tool/data/pmtool.db ".backup /srv/pm-tool/backups/pmtool-$(date +%F).db"` then gzip; keep 30 daily and 12 monthly copies off-box in versioned, immutable object storage. `VACUUM INTO 'copy.db'` is equivalent. Verify with `sqlite3 copy.db "pragma integrity_check"`.
- **Continuous**: run [Litestream](https://litestream.io) beside the API (also without root) to stream the WAL to object storage for point-in-time restore (`litestream restore`).
- **Restore**: stop the API, move `pmtool.db` (and any `-wal`/`-shm`) aside, place the backup as `pmtool.db`, start the API. The backup already contains `schema_migrations`; WAL mode is re-enabled on open.
- **Restore drill quarterly**: restore to a scratch path, `sqlite3 scratch.db "select count(*) from activity_events"`, start the API against it with `DATABASE_URL=/path/scratch.db PORT=3002`.
- The activity log is the audit source, so backup retention must be at least as long as audit retention.

## The activity log as the audit source

- `activity_events` is append-only at the database level: triggers raise `activity_events is append-only (UPDATE denied)` / `(DELETE denied)`. Verify after every migration that `sqlite3 data/pmtool.db "update activity_events set source = source where id = (select min(id) from activity_events)"` still fails.
- Nightly export for the compliance archive:

```bash
sqlite3 -csv -header data/pmtool.db \
  "select * from activity_events where created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')" \
  > /backups/audit/events-$(date +%F).csv
```

- SQLite has no database roles. Separation of duties is at the file level: the service user owns `data/` (`700`) and is the only writer; compliance reads a read-only copy made with `.backup` (or opens the live file with `sqlite3 -readonly` from a read-only group). Immutable off-box backups are the proof that the log was not rewritten. A database-level credential that can insert into the log but not drop it is one of the reasons to move to Postgres later.
- Every row names who (`actor_id`, `actor_kind`, `actor_label`), through what (`source`, `mutation_name`), what (`field`, `old_value`, `new_value`) and when. Example audit queries (full item history, every state change by one person in a quarter, point-in-time reconstruction) are in [docs/01-data-model.md §6.4](https://github.com/jamjorf/pm-tool/blob/main/docs/01-data-model.md#64-example-audit-queries).

## Monitoring

| Signal | Source | Alert when |
|---|---|---|
| `GET /health` | API | non-200 for 1 minute |
| Push latency p95, pull size | API logs (pino JSON: request id, user id, mutation name, duration) | push p95 above 500 ms (writer contention) |
| `SQLITE_BUSY` / `database is locked` | API logs | any sustained rate: another process is writing the file, or a transaction spans I/O |
| `select count(*) from webhook_deliveries where status in ('pending','failed') and next_attempt_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')` | SQL | above 0 for 10 minutes (dispatcher stalled) |
| `select count(*) from webhook_deliveries where status = 'dead' and created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')` | SQL | above 0 (a receiver is down) |
| `select count(*) from notification_deliveries where sent_at is null and scheduled_for < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')` | SQL | above 0 |
| `select count(*) from sync_client_groups where resync_required = 1` | SQL | sustained high counts mean membership churn |
| size of `pmtool.db` and `pmtool.db-wal`, free disk | filesystem | `-wal` above about 100 MB for minutes (a reader is pinning it); disk below 20% free |
| `pragma integrity_check` on the nightly backup | cron | anything but `ok` |
| `select count(*) from activity_events` growth | SQL | plan the archive step past about 50 GB of file |

Do not log mutation args; they contain item content.

## Security checklist

- Magic-link login (`POST /auth/magic-link` → `GET /auth/callback?token=`); for SSO put an identity-aware proxy or OIDC in front and map the asserted email to `users`.
- Cookie `pm_session`: httpOnly, `Secure`, `SameSite=Lax`, signed with `APP_SECRET`, backed by a `sessions` row so it can be revoked.
- API keys: `pm_<random>`, sha256 stored, `key_prefix` for display, `scopes` (`read`, `write`), `expires_at`, `revoked_at`, `last_used_at`.
- Deactivating a user (`PATCH /api/v1/users/:id {"is_active":false}`) invalidates sessions and keys; history remains.
- CORS allows only `APP_URL` with credentials; proxy adds HSTS, `X-Content-Type-Options`, a CSP for the SPA.
- Inbound integrations verify provider signatures and are idempotent via `inbound_events`; outbound webhooks are signed per endpoint.
- Secrets (`APP_SECRET`, Slack, GitHub, SMTP, webhook endpoint secrets) live in `.env` (mode 600) or the platform's secret store, never in the repo. There is no database password: the permissions on `data/` are the credential.

## Retention and legal hold

- Default: retain everything. Items are soft-deleted; the log is append-only.
- Policy-driven purge, if the firm's records policy requires it: archive (`archived_at`) rather than delete; for the log, copy whole date ranges into a separate archive database (`attach database 'archive.db' as a; insert into a.activity_events select … where created_at < …`) under change control, then rebuild the live table from the retained range in a migration; never `DELETE` from the live table. `VACUUM` afterwards to return the space.
- Legal hold: a `settings` key (`{"legal_hold": {"projects": [...], "until": …}}`) that the purge job checks; held projects' rows are excluded from the archive step.
- Subject access and export: `GET /api/v1/export/items.csv?project=` plus the nightly audit CSVs.
- PII: names and emails are in `users`; item content is wherever users typed it. Classify the file at the level of the most sensitive project, or split sensitive desks into a separate deployment (the schema is standalone; a second instance is a second file and a second unit).

## Scaling path and when to move to Postgres

SQLite means one writer at a time (readers never block under WAL), one host, and reads that scale with the host's memory. In order of likelihood, none of which changes the client protocol or the data model:

1. **Archive old items** (`archived_at`) so the sync snapshot excludes them unless `include_archived`.
2. **Bigger host**: RAM for the page cache, NVMe for the WAL.
3. **Read-only copies** (periodic `.backup` or a Litestream replica) for dashboards, exports and compliance. No code change.
4. **Row-versioned sync** when snapshots exceed tens of MB per user or membership churn causes constant resyncs ([[Sync]]).
5. **Search service** (Meilisearch / Typesense) fed from the activity log cursor, when the conditions in [docs/02-design.md §7](https://github.com/jamjorf/pm-tool/blob/main/docs/02-design.md#7-search) hold.
6. **Move to Postgres** when push p95 stays above about 500 ms from writer contention, when a second API process on another host is needed, when the firm requires database-level separation of duties or row-level security, or when the file passes tens of GB. The schema uses only portable constructs and every query goes through the `@pm/db` `sql` tag, so the move is mechanical; the steps are in [docs/05-operations.md §5](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#5-scaling-path-and-when-to-move-to-postgres) and [ADR-009](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-009-sqlite-over-postgres.md).

Explicitly not on the path: microservices, a message broker, a cache tier, multi-region writes.

## Roadmap and adoption

Desk-level tools (trade idea, model change, client onboarding, incident / RCA, strategy roadmap) are new item types, workflows and views, not new applications; the table of fields, workflows, guards and views for each is in [docs/05-operations.md §6](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#6-roadmap-desk-level-and-strategy-level-tools). The adoption playbook (seed with real work, one project per desk, integrations in week one, quiet notifications, views not training, agents last with read-only keys) is in [§7](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#7-adoption-playbook).
