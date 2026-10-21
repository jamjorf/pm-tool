# ADR-005: Permissions are per-project roles (not attribute-based rules)

**Status:** accepted · **Date:** 2026-10

## Context

The permissions decision had to be made before the first line of API or sync
code, because sync pull scoping, every read query and every write check depend
on it. The two candidates were per-project role-based access (RBAC) and
attribute-based rules (ABAC: policies over user and item attributes). The firm
is organised in desks and functions; compliance must be able to explain any
access decision after the fact.

## Decision

**RBAC with three modifiers.**

* `users.firm_role`: owner / admin / member / guest.
* `project_members.role`: admin / editor / viewer (explicit membership wins).
* `projects.visibility`: firm (members are editors without a row) / private
  (membership required).
* `work_items.confidential`: visible to project admins and to the item's
  assignee, reporter and creator only.

Two SQL views decide everything on the server (REST, sync pull, export,
search): `effective_roles(user_id, project_id, role)` (the role lattice) and
`visible_items(user_id, item_id)` (role plus the confidential rule); every
item read appends `exists (select 1 from visible_items vi where vi.user_id = ?
and vi.item_id = w.id)`. `permissions.can()` in `@pm/core` mirrors the lattice
for the UI with a per-action minimum role table.

**Attribute-style conditions are placed in workflow guards**
(`require_role`, `require_label`, `field_equals`, `require_assignee_is_actor`),
because the real-world attribute requirements are about *who may move an item
through a step*, not about who may see it.

## Consequences

* (+) Explainable: "why can Alice see this?" is a firm role plus a membership
  row; both are data and both are logged.
* (+) Cheap set-based visibility predicate, which the sync protocol needs to
  compute `put`/`del` per row and to decide when a full resync is required.
* (+) Mirrors the organisation: desk = project, desk head = admin, compliance
  = viewer, external counsel = guest on one private project.
* (−) Granularity stops at project + confidential flag; field-level secrecy
  is not expressible — use a private project or a confidential item.
* (−) Visibility changes (membership removal, project made private, item
  moved) require a full client resync (`resync_required`).
* (−) If a genuinely attribute-driven requirement appears (e.g. "desk X may
  see items whose `fields.desk = X` in any project"), it must be added to the
  `visible_items` view — a single view, but a change to the contract.

## Alternatives considered

* **ABAC / policy engine (OPA, Cedar, Casbin).** Expressive, but decisions are
  evaluations of policy text at a point in time — hard to audit
  retrospectively, expensive to apply to sync diffs (an attribute edit can
  change visibility for everyone), and a second language to review.
* **Per-item ACLs.** Flexible, unexplainable at scale, and sharing semantics
  become the product.
* **Firm-wide flat access.** Simplest; rejected because compliance and
  external parties need scoping from day one.
* **Database row-level security as the primary mechanism.** Not available in
  SQLite (no roles), and in any case the application needs the same decisions
  in TypeScript for optimistic UI. The `visible_items` view is written so it
  can become an RLS policy expression if the data moves to Postgres
  (ADR-009).
