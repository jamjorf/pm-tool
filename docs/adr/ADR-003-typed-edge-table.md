# ADR-003: One typed relation edge table

**Status:** accepted · **Date:** 2026-10

## Context

Items relate in several ways: hierarchy (initiative → tasks), dependencies
(blocks), duplicates, loose references, and links to things in other systems
(a GitHub PR, a Slack thread, an email, a document). Rollups ("how much of
this initiative is done") and dependency checks ("is this blocked") must be
cheap and must stay correct as desks add new kinds of relation.

## Decision

A single `relations` table: `type → relation_types(key)`, `from_item_id`,
`to_item_id` (nullable), and for external entities `external_kind` +
`external_ref` (JSON text) with a generated `external_key` for idempotent
linking.
`relation_types` is a registry with flags `is_hierarchy`, `is_blocking`,
`is_symmetric`; seeded with `parent_of`, `blocks`, `duplicates`,
`relates_to`, `links_to`.

Invariants in the database: a check constraint for the internal/external
shape, no self-edges, unique (type, from, to), a partial unique index giving
every item at most one parent, and a trigger that refuses cycles in any
hierarchy or blocking type. Graph queries are SQL functions:
`item_descendants`, `item_ancestors`, `item_open_blockers`, `item_rollup`;
the `work_items_v` view exposes `parent_id` and `is_blocked`.

## Consequences

* (+) "Everything connected to RATES-12" is one query on one table, including
  external systems.
* (+) New relation kinds are rows; the cycle trigger protects them
  automatically if flagged.
* (+) Rollups are live queries over the subtree, never denormalised counters
  that drift.
* (+) Guards (`no_open_blockers`, `children_in_category`) and effects
  (`transition_parent_if`, `transition_children`) reuse the same functions.
* (−) Recursive CTEs cost O(subtree) per call; fine for trees of hundreds,
  revisit (materialised rollups refreshed from the activity log) if desks
  build trees of tens of thousands.
* (−) Single parent is a hard rule; "an item in two initiatives" must be
  expressed with `relates_to`.
* (−) Direction matters (`A blocks B`); the UI must render the inverse
  label from `relation_types.inverse_name`.

## Alternatives considered

* **`parent_id` column on `work_items` + separate `blockers` table.** Simpler
  for two kinds, but the third kind (external links) and every new kind would
  need another table and another sync/activity path.
* **Graph database.** A second datastore for a few thousand edges; no
  transactional coupling with the activity log.
* **Closure table for the hierarchy.** Faster ancestor queries, but must be
  maintained on every edge change; recursive CTEs are fast enough here.
