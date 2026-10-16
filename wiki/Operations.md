# Operations

One Node 22 process and one Postgres, in one region, behind a reverse proxy. The web app is static files. The MCP server runs where the agents run. The full document, with a production compose file, Caddyfile, database roles, retention and the roadmap toward desk-level tools, is [docs/05-operations.md](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md); the reasoning is [ADR-008](https://github.com/jamjorf/pm-tool/blob/main/docs/adr/ADR-008-monolith-single-region.md).

## Topology

```
Internet ──TLS──▶ reverse proxy ──▶ /            static web build (packages/web/dist)
                                 ├─▶ /api, /auth, /me, /sync, /integrations, /health   → api:3001
                                 └─▶ /sync/poke  (SSE: disable response buffering, long timeouts)
                     api ───────────▶ postgres:5432
                     api ───────────▶ SMTP · Slack API · GitHub API · your webhook receivers
```

The API process also runs the background loops: webhook dispatcher every 5 s, notification deliveries every 30 s, due-soon scheduler hourly. There is no queue, cache tier or second service.

Build and start:

```bash
pnpm install --frozen-lockfile
pnpm --filter @pm/core build
pnpm -r --filter './packages/*' build
pnpm db:migrate                      # idempotent; takes an advisory lock so concurrent runners serialise
node packages/api/dist/server.js     # serves :3001
# packages/web/dist is served by the proxy
```

The production compose example (Postgres 16 with WAL archiving, `api`, a one-shot `migrate` service, Caddy with `flush_interval -1` for SSE) is in [docs/05-operations.md §2.2](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#22-production-compose-example).

## Environment variables

From [`.env.example`](https://github.com/jamjorf/pm-tool/blob/main/.env.example). `DATABASE_URL` is the only required one.

| Variable | Default | Purpose | Production note |
|---|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/pmtool` | Postgres connection for api, db, tests | use a dedicated application role |
| `PORT`, `HOST` | `3001`, `0.0.0.0` | API bind | |
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

- **Logical, nightly**: `pg_dump -Fc pmtool > pmtool-$(date +%F).dump`; keep 30 daily and 12 monthly off-box in versioned, immutable object storage.
- **Continuous, WAL**: `archive_mode=on` with an `archive_command` to object storage (or pgBackRest / wal-g) for point-in-time recovery; weekly base backup.
- **Restore drill quarterly**: restore to a scratch instance, run `select count(*) from activity_events`, open the app against it.
- The activity log is the audit source, so backup retention must be at least as long as audit retention.

## The activity log as the audit source

- `activity_events` is append-only at the database level: triggers raise `42501` on UPDATE, DELETE and TRUNCATE. Verify after every migration that `update activity_events set source = source where false;` still raises on a real row.
- Nightly export for the compliance archive:

```bash
psql "$DATABASE_URL" -c "\copy (select * from activity_events where created_at >= now() - interval '1 day') to '/backups/audit/events-$(date +%F).csv' csv header"
```

- Database roles: `pm_migrate` owns the schema and runs migrations; `pm_app` (what `DATABASE_URL` uses) gets `SELECT/INSERT/UPDATE` on tables but only `INSERT/SELECT` on `activity_events`; `pm_audit` gets `SELECT` on `activity_events`, `work_items_v` and `users`. With this split a compromised application credential cannot alter history.
- Every row names who (`actor_id`, `actor_kind`, `actor_label`), through what (`source`, `mutation_name`), what (`field`, `old_value`, `new_value`) and when. Example audit queries (full item history, every state change by one person in a quarter, point-in-time reconstruction) are in [docs/01-data-model.md §6.4](https://github.com/jamjorf/pm-tool/blob/main/docs/01-data-model.md#64-example-audit-queries).

## Monitoring

| Signal | Source | Alert when |
|---|---|---|
| `GET /health` | API | non-200 for 1 minute |
| Push latency p95, pull size | API logs (pino JSON: request id, user id, mutation name, duration) | push p95 above 500 ms (advisory-lock contention) |
| `select count(*) from webhook_deliveries where status in ('pending','failed') and next_attempt_at < now() - interval '5 minutes'` | SQL | above 0 for 10 minutes (dispatcher stalled) |
| `select count(*) from webhook_deliveries where status = 'dead' and created_at > now() - interval '1 day'` | SQL | above 0 (a receiver is down) |
| `select count(*) from notification_deliveries where sent_at is null and scheduled_for < now() - interval '15 minutes'` | SQL | above 0 |
| `select count(*) from sync_client_groups where resync_required` | SQL | sustained high counts mean membership churn |
| Postgres connections, replication lag, `pg_stat_statements`, bloat on `work_items` | standard exporters | |
| `pg_total_relation_size('activity_events')` | SQL | plan monthly partitioning past about 50 GB |

Do not log mutation args; they contain item content.

## Security checklist

- Magic-link login (`POST /auth/magic-link` → `GET /auth/callback?token=`); for SSO put an identity-aware proxy or OIDC in front and map the asserted email to `users`.
- Cookie `pm_session`: httpOnly, `Secure`, `SameSite=Lax`, signed with `APP_SECRET`, backed by a `sessions` row so it can be revoked.
- API keys: `pm_<random>`, sha256 stored, `key_prefix` for display, `scopes` (`read`, `write`), `expires_at`, `revoked_at`, `last_used_at`.
- Deactivating a user (`PATCH /api/v1/users/:id {"is_active":false}`) invalidates sessions and keys; history remains.
- CORS allows only `APP_URL` with credentials; proxy adds HSTS, `X-Content-Type-Options`, a CSP for the SPA.
- Inbound integrations verify provider signatures and are idempotent via `inbound_events`; outbound webhooks are signed per endpoint.
- Secrets (`APP_SECRET`, `DATABASE_URL`, Slack, GitHub, SMTP, webhook endpoint secrets) live in the platform's secret store, never in the image or the repo.

## Retention and legal hold

- Default: retain everything. Items are soft-deleted; the log is append-only.
- Policy-driven purge, if the firm's records policy requires it: archive (`archived_at`) rather than delete; for the log, partition by `created_at` monthly and detach or export partitions under change control by `pm_migrate`, never `DELETE`.
- Legal hold: a `settings` key (`{"legal_hold": {"projects": [...], "until": …}}`) that the purge job checks; held projects are not detached.
- Subject access and export: `GET /api/v1/export/items.csv?project=` plus the nightly audit CSVs.
- PII: names and emails are in `users`; item content is wherever users typed it. Classify the database at the level of the most sensitive project, or split sensitive desks into a separate deployment (the schema is standalone; two instances are cheap).

## Scaling path

In order of likelihood, none of which changes the client protocol or the data model:

1. **Read replica** for dashboards, exports and compliance queries (`pm_audit` points at it). No code change.
2. **Archive old items** (`archived_at`) so the sync snapshot excludes them unless `include_archived`.
3. **Second API process**: move poke from the in-memory emitter to Postgres `LISTEN/NOTIFY`; the advisory lock already serialises across processes.
4. **Row-versioned sync** when push p95 exceeds about 500 ms or snapshots exceed tens of MB per user ([[Sync]]).
5. **Search service** (Meilisearch / Typesense, `pgvector` for semantic) fed from the activity log cursor, when the conditions in [docs/02-design.md §7](https://github.com/jamjorf/pm-tool/blob/main/docs/02-design.md#7-search) hold.
6. **Partition `activity_events`** by month past about 50 GB.

Explicitly not on the path: microservices, a message broker, a cache tier, multi-region writes.

## Roadmap and adoption

Desk-level tools (trade idea, model change, client onboarding, incident / RCA, strategy roadmap) are new item types, workflows and views, not new applications; the table of fields, workflows, guards and views for each is in [docs/05-operations.md §6](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#6-roadmap-desk-level-and-strategy-level-tools). The adoption playbook (seed with real work, one project per desk, integrations in week one, quiet notifications, views not training, agents last with read-only keys) is in [§7](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#7-adoption-playbook).
