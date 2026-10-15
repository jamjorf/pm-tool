# ADR-001: One generic work item, not a table per type

**Status:** accepted · **Date:** 2026-10 · **Owners:** platform

## Context

The firm needs tasks, bugs, initiatives and requests today, and desk-specific
things tomorrow (trade ideas, model changes, client onboardings, incidents).
Each has its own fields and its own lifecycle. The classic choices are a table
per type (clean columns, N schemas, N APIs, N UIs), a single wide table with
nullable columns for everything, or an EAV store. The tool's core features —
views over mixed types, cross-type relations, one activity log, one sync
protocol, one search index — all want one entity.

## Decision

One table, `work_items`, with:

* typed columns for what every type shares and every view sorts/filters on
  (`title`, `state_id`, `priority`, `assignee_id`, `reporter_id`,
  `start_date`, `due_date`, `estimate`, `confidential`, `sort_order`, …);
* `type_id → item_types`, whose `field_defs` (a JSON array of `FieldDef`)
  declares the type-specific fields;
* `fields jsonb` holding those values, validated by a database trigger
  (`trg_validate_item_fields`: unknown keys, required keys, JSON types) and
  by the zod schema generated from the same `field_defs` in `@pm/core`
  (option membership, user existence, min/max);
* a per-project `number`/`key` (`RATES-12`) assigned by trigger;
* GIN indexes on `fields` (`jsonb_path_ops`) and on the generated `search`
  tsvector.

Adding a type or a field is an `INSERT`/`UPDATE` on `item_types`. Adding a
column is a migration, reserved for attributes every type needs.

## Consequences

* (+) One API, one query layer (`fields.<key>` is a first-class `FieldRef`),
  one activity log (`fields.<key>` rows), one sync table, one search index.
* (+) Desks iterate without engineering: new types are product decisions.
* (+) The JSONB is honest: the trigger rejects garbage regardless of client.
* (−) JSONB fields are not foreign keys; referential checks for `user` fields
  are in application code.
* (−) Aggregations over JSONB numbers need casts (`(fields->>'notional')::numeric`);
  heavy analytical use of a field is the signal to promote it to a column.
* (−) Removing a field requires clearing values first (the trigger rejects
  unknown keys on the next write).

## Alternatives considered

* **Table per type.** Clean, but every cross-cutting feature (views, relations,
  log, sync, search, permissions) multiplies by the number of types; desk
  additions become engineering projects.
* **Wide table with nullable columns per type.** Degenerates quickly; schema
  changes for every new field; no per-type validation.
* **EAV (`item_field_values`).** Maximally flexible, slow to query, painful to
  sync and to diff for the activity log.
* **Document store.** Loses transactional invariants (cycle checks, single
  parent, append-only log) that the regulated context needs.
