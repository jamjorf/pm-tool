# Documentation index

A firm-wide project management tool built on five ideas: one generic work
item with typed JSONB, workflows as data, a typed relation graph, an
append-only activity log, and views as saved queries — on Postgres, a
TypeScript monorepo, React with local-first sync, one server process, and an
MCP server for agents.

| Document | Read it for |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **The contract.** Package layout, query layer, mutation pipeline, sync protocol, HTTP API v1, webhooks, notification rules, web app, integrations interface. Frozen; code is built against it. |
| [01-data-model.md](01-data-model.md) | **Standalone data model.** Every table, trigger and function; the five design bullets one by one; guard/effect vocabulary; graph queries; audit queries; the permissions decision; how to iterate; a `psql` quick start. Readable without the rest of the repo. |
| [02-design.md](02-design.md) | **Tool design.** Architecture diagram, QuerySpec grammar and the two executors, ViewSpec examples for list/board/timeline/dashboard, every mutation and what it writes, workflow engine runtime, permission enforcement points, sync design and limits, search, notifications, webhooks, API principles, MCP, and an end-to-end sequence for dragging a card. |
| [03-ux.md](03-ux.md) | **UX spec.** Information architecture, screens, command palette modes, keyboard map, instant-navigation guarantees, bulk edit, search, inbox, item detail, filter builder, admin editors, empty states, accessibility. |
| [04-integrations.md](04-integrations.md) | **Using it from outside.** API with curl, webhooks with HMAC verification in Node and Python, Slack app manifest and `/pm` commands, GitHub conventions, inbound email scheme and provider mapping, MCP server setup and tool catalogue, security notes. |
| [05-operations.md](05-operations.md) | **Running it.** Stack rationale, single-region deployment with a production compose file, env vars, backups, audit source, monitoring, security, retention and legal hold, scaling path, roadmap toward desk-level tools, adoption playbook. |
| [adr/](adr/) | **Decision records**, one page each: [001 generic work item](adr/ADR-001-generic-work-item.md) · [002 workflows as data](adr/ADR-002-workflows-as-data.md) · [003 typed edge table](adr/ADR-003-typed-edge-table.md) · [004 append-only log](adr/ADR-004-append-only-activity-log.md) · [005 per-project roles](adr/ADR-005-permissions-per-project-roles.md) · [006 views as saved queries](adr/ADR-006-views-as-saved-queries.md) · [007 global-version sync](adr/ADR-007-sync-global-version.md) · [008 monolith, single region](adr/ADR-008-monolith-single-region.md) |
| [BUILD-PROMPT.md](BUILD-PROMPT.md) | **The one-shot build prompt.** A self-contained document to paste into Claude Code (or another coding agent) in an empty directory to reproduce the whole system: requirements, the full migration SQL, the core contract files, the architecture contract, a package-by-package plan with acceptance tests, seed spec, verification checklist and definition of done. |

Source of truth order when documents disagree: the SQL migration
(`packages/db/migrations/0001_init.sql`) and the core contract files
(`packages/core/src/{schema/entities,query/spec,mutations,workflow/types,permissions/types}.ts`,
`packages/integrations/src/deps.ts`) first, then `ARCHITECTURE.md`, then the
numbered documents.

Suggested reading order for a CTO: 01 → ADRs → 02 → 05. For an engineer
joining: ARCHITECTURE.md → 01 → 02 → 03 → 04. For an agent asked to build it:
BUILD-PROMPT.md only.
