# ADR-002: Workflows are data (explicit state machines per type)

**Status:** accepted · **Date:** 2026-10

## Context

Every desk has approval steps, and a regulated firm must be able to show that
a step was enforced, by whom, under which conditions. Hard-coding states as
an enum and "if status == X" logic in application code makes every desk
workflow a code change and makes the rules invisible to compliance.

## Decision

Three tables define state machines: `workflows`, `workflow_states` (with a
closed `category` enum: backlog / todo / in_progress / done / canceled, a
unique initial state) and `workflow_transitions` (`from_state_id` null = any,
`to_state_id`, `guards jsonb[]`, `effects jsonb[]`). Each `item_type` points at
one workflow. The database trigger `trg_validate_item_state` guarantees an
item's state belongs to its type's workflow.

Guards and effects are a closed, typed vocabulary (zod discriminated unions
in `@pm/core`): guards `require_field`, `field_equals`, `field_in`,
`no_open_blockers`, `children_in_category`, `require_role`,
`require_assignee_is_actor`, `require_label`; effects `set_field` (with
`$now`/`$today`/`$actor` macros), `notify`, `webhook`, `add_label`,
`remove_label`, `transition_parent_if`, `transition_children`. A pure
`workflowEngine` evaluates them identically on the client (to grey out
buttons) and on the server (authoritatively, inside the write transaction).
State changes happen only through `transitionItem`; `updateItem` cannot set
`state_id`.

## Consequences

* (+) A new desk workflow is a handful of `INSERT`s; it appears in the UI,
  the API and the guard evaluation immediately.
* (+) Every transition is logged (`action = 'transition'`, `field = 'state_id'`)
  with the actor and source; guard definitions are rows, so "what was the rule
  at the time" is answerable from the log of `workflow_transitions` changes.
* (+) `category` keeps generic features (boards, rollups, "not done" filters)
  working across arbitrary desk states.
* (+) Attribute-style authorisation ("only risk can approve") lives here,
  which keeps the access-control model simple (ADR-005).
* (−) The guard/effect vocabulary is closed; a new kind of rule is a `@pm/core`
  change (no migration).
* (−) Effects that cascade (`transition_parent_if`, `transition_children`)
  need care to stay bounded; depth is capped by the hierarchy functions.
* (−) Admin tooling must validate definitions (`validateDefinition`: one
  initial state, known states, unique keys, reachability).

## Alternatives considered

* **Status enum + code.** Fast to start, impossible to delegate to desks,
  opaque to audit.
* **Generic rule engine / scripting (JS or CEL in rows).** Maximum power, but
  rules become unreviewable code with database access; also untestable
  parity between client and server.
* **External workflow engine (Temporal, Camunda).** Another service, another
  audit boundary; overkill for approval chains of 3–6 states.
