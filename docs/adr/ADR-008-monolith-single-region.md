# ADR-008: One process, one Postgres, one region — no microservices

**Status:** accepted · **Date:** 2026-10

## Context

The tool serves one firm: hundreds to low thousands of users, tens of writes
per second at peak, a dataset that fits in memory on a laptop. The risky parts
are the data model, the sync protocol and the audit guarantees, not
throughput. Every additional runtime component is an on-call surface, a
boundary the audit trail must cross, and a place where a regulated firm's
data can leak or lag.

## Decision

* One Node 22 process (`@pm/api`, Fastify 5) serves REST, sync, SSE poke,
  integrations' inbound routes, the webhook dispatcher loop, the notification
  delivery worker and the due-soon scheduler.
* One Postgres 16 holds the model, the audit log, the FTS/trigram indexes, the
  sync bookkeeping and the delivery queues (`webhook_deliveries`,
  `notification_deliveries`).
* One region. The web app is static files behind the same reverse proxy. The
  MCP server runs beside the agent, not beside the API.
* Background work is table-driven loops with `status`/`next_attempt_at`
  columns; no message broker, no cache tier, no job service.
* Shared logic lives in `@pm/core`, a pure package imported by the server, the
  browser and the MCP server, so "no microservices" does not mean "one big
  file".

## Consequences

* (+) Transactions span everything: an item change, its activity rows, its
  notifications and its webhook enqueue commit together or not at all.
* (+) Deployment is a compose file; backup is `pg_dump` + WAL; the audit
  source is one table in one database.
* (+) Local development equals production topology.
* (−) Vertical scaling only, until the documented path is taken (read
  replica → second process with `LISTEN/NOTIFY` poke → row-versioned sync →
  external search). None of these changes the client protocol or the data
  model.
* (−) A slow webhook receiver or SMTP server must not block the event loop:
  the loops are bounded and asynchronous, with timeouts.
* (−) Single region means a regional outage is an outage; acceptable for an
  internal tool with PITR backups and a documented restore drill.

## Alternatives considered

* **Microservices (API, sync service, notifier, webhook service, search).**
  Four more deployables, inter-service auth, eventual consistency between the
  audit log and its consumers. Nothing in the requirements needs independent
  scaling.
* **Serverless functions + managed queues.** Cold starts hurt sync latency;
  long-lived SSE connections are awkward; transactional guarantees across
  functions are lost.
* **Multi-region active-active.** Conflicts with the global version strategy
  and offers nothing to a single-city firm.
