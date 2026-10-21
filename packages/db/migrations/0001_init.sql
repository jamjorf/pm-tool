-- ============================================================================
-- pm-tool :: core data model (SQLite)
-- ----------------------------------------------------------------------------
-- Self-contained: apply to any SQLite 3.38+ database (3.45+ recommended) with
--   sqlite3 pmtool.db < 0001_init.sql
-- and use standalone, without the rest of the monorepo. No extensions, no
-- native modules, no server process. The application opens the file with
-- Node's built-in `node:sqlite`.
--
-- Conventions
--   * ids are UUID strings (text); defaults generate a v4 UUID in SQL.
--   * timestamps are ISO-8601 UTC text ("2026-10-21T04:55:21.249Z");
--     dates are "YYYY-MM-DD" text. Both sort and compare correctly as text.
--   * booleans are integer 0/1 with a CHECK; enums are text with a CHECK.
--   * JSON columns are text validated with json_valid()/json_type().
--   * arrays (scopes, event_kinds, allowed_type_ids, ...) are JSON arrays.
--
-- Design pillars (see docs/01-data-model.md)
--   1. One generic `work_items` entity with a `type_id` + validated JSON `fields`.
--   2. Workflows are DATA: states + transitions + guards + effects per workflow.
--   3. Relations are one typed edge table (parent/child, blocks, duplicates,
--      external links). Rollups and dependency checks are graph queries.
--   4. Activity log is append-only, one row per field change; UPDATE/DELETE
--      are blocked by triggers.
--   5. Permissions: per-project roles + firm role + project visibility,
--      exposed as views (effective_roles, visible_items).
--   6. Views are saved queries (`views.spec`), not screens.
--   7. Every synced table carries `version` (global version stamped by
--      triggers from `sync_state`) and uses soft-delete tombstones.
--
-- Runtime pragmas (set by the application on every connection):
--   PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 0. Sync plumbing (global version strategy)
-- ----------------------------------------------------------------------------
-- One monotonically increasing counter. Triggers below stamp every inserted or
-- updated row of a synced table with the next value. SQLite serialises writers
-- (BEGIN IMMEDIATE), so version order == commit order without any extra lock.
create table sync_state (
  id       integer primary key check (id = 1),
  version  integer not null default 0
);
insert into sync_state(id, version) values (1, 0);

-- ----------------------------------------------------------------------------
-- 1. Principals
-- ----------------------------------------------------------------------------
create table users (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  email         text not null,
  name          text not null,
  avatar_url    text,
  firm_role     text not null default 'member' check (firm_role in ('owner','admin','member','guest')),
  is_active     integer not null default 1 check (is_active in (0,1)),
  is_service    integer not null default 0 check (is_service in (0,1)),   -- bots / integrations / agents
  settings      text not null default '{}' check (json_valid(settings) and json_type(settings) = 'object'),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create unique index users_email_uq on users (lower(email)) where deleted_at is null;

create table sessions (
  id            text primary key default (lower(hex(randomblob(16)))),
  user_id       text not null references users(id) on delete cascade,
  token_hash    text not null unique,
  expires_at    text not null,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  text
);
create index sessions_user_idx on sessions(user_id);

create table api_keys (
  id            text primary key default (lower(hex(randomblob(16)))),
  user_id       text not null references users(id) on delete cascade,
  name          text not null,
  key_prefix    text not null,          -- first 8 chars, for display
  key_hash      text not null unique,   -- sha256 of full key
  scopes        text not null default '["read","write"]' check (json_valid(scopes) and json_type(scopes) = 'array'),
  expires_at    text,
  last_used_at  text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    text
);
create index api_keys_user_idx on api_keys(user_id);

create table teams (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique,   -- e.g. "RATES", "OPS"
  name          text not null,
  description   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

create table team_members (
  team_id       text not null references teams(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  is_lead       integer not null default 0 check (is_lead in (0,1)),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (team_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 2. Workflows (state machines as data)
-- ----------------------------------------------------------------------------
create table workflows (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique,
  name          text not null,
  description   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- Category lets generic UI/queries treat states uniformly across workflows
-- (e.g. "show me everything not done" regardless of type).
create table workflow_states (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  workflow_id   text not null references workflows(id) on delete cascade,
  key           text not null,
  name          text not null,
  category      text not null check (category in ('backlog','todo','in_progress','done','canceled')),
  color         text,
  sort          integer not null default 0,
  is_initial    integer not null default 0 check (is_initial in (0,1)),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  unique (workflow_id, key)
);
create unique index workflow_states_one_initial on workflow_states(workflow_id) where is_initial = 1 and deleted_at is null;

-- A transition with from_state_id = NULL is allowed from ANY state.
-- guards:  JSON array of guard specs evaluated by the @pm/core workflow engine, e.g.
--   [{"type":"require_field","field":"assignee_id"},
--    {"type":"no_open_blockers"},
--    {"type":"children_in_category","categories":["done","canceled"]},
--    {"type":"require_role","roles":["admin","editor"]},
--    {"type":"field_equals","field":"fields.approved","value":true}]
-- effects: JSON array of side effects applied after the transition, e.g.
--   [{"type":"set_field","field":"completed_at","value":"$now"},
--    {"type":"set_field","field":"assignee_id","value":null},
--    {"type":"notify","audience":["watchers"],"template":"state_changed"},
--    {"type":"webhook","event":"item.transitioned"},
--    {"type":"transition_parent_if","all_children_category":["done","canceled"],"to":"done"}]
create table workflow_transitions (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  workflow_id   text not null references workflows(id) on delete cascade,
  key           text not null,
  name          text not null,
  from_state_id text references workflow_states(id) on delete cascade,
  to_state_id   text not null references workflow_states(id) on delete cascade,
  guards        text not null default '[]' check (json_valid(guards) and json_type(guards) = 'array'),
  effects       text not null default '[]' check (json_valid(effects) and json_type(effects) = 'array'),
  sort          integer not null default 0,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  unique (workflow_id, key)
);
create index workflow_transitions_from_idx on workflow_transitions(workflow_id, from_state_id);

-- ----------------------------------------------------------------------------
-- 3. Item types (one generic entity, typed fields via registry + JSON)
-- ----------------------------------------------------------------------------
-- field_defs: JSON array describing the type-specific fields stored in
-- work_items.fields. Validated by triggers (DB) and by the zod schema generated
-- from the same defs in @pm/core (app).
--   [{"key":"severity","label":"Severity","kind":"select",
--     "options":[{"value":"s1","label":"S1"},...],"required":true},
--    {"key":"desk","label":"Desk","kind":"text"},
--    {"key":"notional","label":"Notional (USD)","kind":"number"},
--    {"key":"go_live","label":"Go-live","kind":"date"},
--    {"key":"approver","label":"Approver","kind":"user"},
--    {"key":"links","label":"Links","kind":"url","multi":true}]
-- kind ∈ text | long_text | number | bool | date | datetime | select |
--        multi_select | user | url
create table item_types (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique,          -- "task", "bug", "initiative", "trade_idea"
  name          text not null,
  plural_name   text,
  icon          text,
  color         text,
  description   text,
  workflow_id   text not null references workflows(id),
  field_defs    text not null default '[]' check (json_valid(field_defs) and json_type(field_defs) = 'array'),
  is_container  integer not null default 0 check (is_container in (0,1)),  -- can have children (epic/initiative)
  sort          integer not null default 0,
  is_active     integer not null default 1 check (is_active in (0,1)),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- ----------------------------------------------------------------------------
-- 4. Projects + membership (permissions backbone)
-- ----------------------------------------------------------------------------
create table projects (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  key           text not null unique check (key glob '[A-Z]*' and key not glob '*[^A-Z0-9]*' and length(key) between 2 and 10),  -- "RATES" → item keys RATES-12
  name          text not null,
  description   text,
  status        text not null default 'active' check (status in ('planned','active','paused','completed','archived')),
  visibility    text not null default 'firm' check (visibility in ('firm','private')),
  lead_id       text references users(id),
  team_id       text references teams(id),
  item_seq      integer not null default 0,   -- per-project item numbering
  default_type_id text references item_types(id),
  allowed_type_ids text check (allowed_type_ids is null or (json_valid(allowed_type_ids) and json_type(allowed_type_ids) = 'array')), -- null = all active types
  settings      text not null default '{}' check (json_valid(settings) and json_type(settings) = 'object'),
  start_date    text,
  target_date   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   text,
  deleted_at    text
);

create table project_members (
  project_id    text not null references projects(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  role          text not null default 'editor' check (role in ('admin','editor','viewer')),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (project_id, user_id)
);
create index project_members_user_idx on project_members(user_id);

-- ----------------------------------------------------------------------------
-- 5. Work items (the one generic entity)
-- ----------------------------------------------------------------------------
-- `number` and `key` are filled by the assign_item_number trigger right after
-- insert when omitted (SQLite triggers cannot rewrite NEW before the row
-- exists), which is why they are nullable at the column level.
create table work_items (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  project_id    text not null references projects(id),
  type_id       text not null references item_types(id),
  number        integer,                                 -- per project; filled by trigger when omitted
  key           text,                                    -- "RATES-12" (denormalized for search/links)
  title         text not null check (length(title) between 1 and 500),
  description   text not null default '',               -- markdown
  state_id      text not null references workflow_states(id),
  priority      integer not null default 0 check (priority between 0 and 4), -- 0 none,1 urgent..4 low
  assignee_id   text references users(id),
  reporter_id   text references users(id),
  start_date    text,
  due_date      text,
  estimate      real,                                    -- points/hours; unit per project settings
  fields        text not null default '{}' check (json_valid(fields) and json_type(fields) = 'object'),
  confidential  integer not null default 0 check (confidential in (0,1)),  -- visible to project admins + assignee + reporter + creator only
  sort_order    real not null default 0,                 -- manual ordering within a board column
  version       integer not null default 0,
  created_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  text,
  canceled_at   text,
  archived_at   text,
  deleted_at    text,
  unique (project_id, number)
);
create unique index work_items_key_uq on work_items(key);
create index work_items_project_state_idx on work_items(project_id, state_id) where deleted_at is null;
create index work_items_assignee_idx on work_items(assignee_id) where deleted_at is null;
create index work_items_type_idx on work_items(type_id) where deleted_at is null;
create index work_items_due_idx on work_items(due_date) where deleted_at is null and due_date is not null;
create index work_items_version_idx on work_items(version);

-- Full-text search: an FTS5 index over key/title/description, kept in sync by
-- triggers. Query with:  select id from work_items_fts where work_items_fts match ?
-- Rank with bm25(work_items_fts, 10.0, 5.0, 1.0) (key, title weigh more).
create virtual table work_items_fts using fts5(
  id unindexed, key, title, description,
  tokenize = 'porter unicode61'
);

create trigger work_items_fts_ai after insert on work_items begin
  insert into work_items_fts(id, key, title, description) values (new.id, coalesce(new.key,''), new.title, new.description);
end;
create trigger work_items_fts_au after update of key, title, description on work_items begin
  delete from work_items_fts where id = old.id;
  insert into work_items_fts(id, key, title, description) values (new.id, coalesce(new.key,''), new.title, new.description);
end;
create trigger work_items_fts_ad after delete on work_items begin
  delete from work_items_fts where id = old.id;
end;

-- Assign per-project number + key on insert (when omitted)
create trigger assign_item_number after insert on work_items
when new.number is null or new.number = 0 or new.key is null
begin
  update projects set item_seq = item_seq + 1 where id = new.project_id and (new.number is null or new.number = 0);
  update work_items
     set number = case when new.number is null or new.number = 0 then (select item_seq from projects where id = new.project_id) else new.number end,
         key    = (select key from projects where id = new.project_id) || '-' ||
                  case when new.number is null or new.number = 0 then (select item_seq from projects where id = new.project_id) else new.number end
   where rowid = new.rowid;
end;

-- Validate `fields` against item_types.field_defs (unknown keys, required, kinds).
-- Deep validation (option membership, user existence) happens in @pm/core.
create trigger work_items_validate_fields_ins before insert on work_items begin
  select raise(abort, 'unknown item type') where not exists (select 1 from item_types where id = new.type_id);
  select raise(abort, 'field "' || k.key || '" is not defined for this item type')
    from json_each(new.fields) k
   where not exists (select 1 from json_each((select field_defs from item_types where id = new.type_id)) d where json_extract(d.value, '$.key') = k.key);
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" is required')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.required') = 1 and json_extract(new.fields, '$.' || json_extract(d.value, '$.key')) is null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be an array')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where (json_extract(d.value, '$.multi') = 1 or json_extract(d.value, '$.kind') = 'multi_select')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('array', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a string')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') in ('text','long_text','select','user','url','date','datetime')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('text', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a number')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'number'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('integer', 'real', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a boolean')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'bool'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('true', 'false', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
end;
create trigger work_items_validate_fields_upd before update of fields, type_id on work_items begin
  select raise(abort, 'unknown item type') where not exists (select 1 from item_types where id = new.type_id);
  select raise(abort, 'field "' || k.key || '" is not defined for this item type')
    from json_each(new.fields) k
   where not exists (select 1 from json_each((select field_defs from item_types where id = new.type_id)) d where json_extract(d.value, '$.key') = k.key);
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" is required')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.required') = 1 and json_extract(new.fields, '$.' || json_extract(d.value, '$.key')) is null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be an array')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where (json_extract(d.value, '$.multi') = 1 or json_extract(d.value, '$.kind') = 'multi_select')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('array', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a string')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') in ('text','long_text','select','user','url','date','datetime')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('text', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a number')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'number'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('integer', 'real', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
  select raise(abort, 'field "' || json_extract(d.value, '$.key') || '" must be a boolean')
    from json_each((select field_defs from item_types where id = new.type_id)) d
   where json_extract(d.value, '$.multi') is not 1 and json_extract(d.value, '$.kind') = 'bool'
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) not in ('true', 'false', 'null')
     and json_type(new.fields, '$.' || json_extract(d.value, '$.key')) is not null;
end;

-- Enforce that state belongs to the item type's workflow
create trigger work_items_validate_state_ins before insert on work_items begin
  select raise(abort, 'state does not belong to the workflow of this item type')
   where not exists (select 1 from workflow_states s join item_types t on t.workflow_id = s.workflow_id where s.id = new.state_id and t.id = new.type_id);
end;
create trigger work_items_validate_state_upd before update of state_id, type_id on work_items begin
  select raise(abort, 'state does not belong to the workflow of this item type')
   where not exists (select 1 from workflow_states s join item_types t on t.workflow_id = s.workflow_id where s.id = new.state_id and t.id = new.type_id);
end;

create table labels (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  project_id    text references projects(id) on delete cascade, -- null = firm-wide label
  name          text not null,
  color         text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create unique index labels_name_uq on labels(coalesce(project_id, ''), lower(name)) where deleted_at is null;

create table work_item_labels (
  item_id       text not null references work_items(id) on delete cascade,
  label_id      text not null references labels(id) on delete cascade,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (item_id, label_id)
);

create table comments (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  item_id       text not null references work_items(id) on delete cascade,
  author_id     text references users(id),
  body          text not null,                       -- markdown; @mentions as @[name](user:uuid)
  parent_id     text references comments(id),        -- threaded replies
  source        text not null default 'app',         -- app | email | slack | github | mcp | api
  external_ref  text check (external_ref is null or json_valid(external_ref)),  -- e.g. slack ts, email message-id
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at     text,
  deleted_at    text
);
create index comments_item_idx on comments(item_id, created_at);

create table attachments (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  item_id       text not null references work_items(id) on delete cascade,
  name          text not null,
  url           text not null,
  mime_type     text,
  size_bytes    integer,
  created_by    text references users(id),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- ----------------------------------------------------------------------------
-- 6. Relations: one typed edge table
-- ----------------------------------------------------------------------------
-- relation_types is a registry so new edge kinds are data, not migrations.
--   is_hierarchy: forms the parent/child tree (single parent, acyclic)
--   is_blocking : participates in "is blocked" computations
--   is_symmetric: A r B implies B r A (duplicates, relates_to)
create table relation_types (
  key           text primary key,
  name          text not null,          -- forward label  ("blocks")
  inverse_name  text not null,          -- inverse label  ("is blocked by")
  is_hierarchy  integer not null default 0 check (is_hierarchy in (0,1)),
  is_blocking   integer not null default 0 check (is_blocking in (0,1)),
  is_symmetric  integer not null default 0 check (is_symmetric in (0,1)),
  sort          integer not null default 0
);
insert into relation_types (key, name, inverse_name, is_hierarchy, is_blocking, is_symmetric, sort) values
  ('parent_of',  'parent of',  'child of',         1, 0, 0, 0),
  ('blocks',     'blocks',     'is blocked by',    0, 1, 0, 1),
  ('duplicates', 'duplicates', 'is duplicated by', 0, 0, 1, 2),
  ('relates_to', 'relates to', 'relates to',       0, 0, 1, 3),
  ('links_to',   'links to',   'linked from',      0, 0, 0, 4); -- external entities

-- Edge: from_item -(type)-> to_item | external entity.
-- External entities (GitHub PR, Slack thread, email, document, a row in
-- another system) live in the same table with to_item_id = null and
-- external_kind/external_ref set, so "everything connected to this item" is
-- one query.
create table relations (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  type          text not null references relation_types(key),
  from_item_id  text not null references work_items(id) on delete cascade,
  to_item_id    text references work_items(id) on delete cascade,
  external_kind text,                                   -- github_pr | github_issue | slack_thread | email | url | doc | ...
  external_ref  text check (external_ref is null or json_valid(external_ref)),  -- {"url":..., "repo":..., "number":..., "title":...}
  external_key  text generated always as (
                  case when external_kind is not null
                       then external_kind || ':' || coalesce(json_extract(external_ref, '$.id'), json_extract(external_ref, '$.url'), '')
                  end) stored,
  meta          text not null default '{}' check (json_valid(meta) and json_type(meta) = 'object'),
  created_by    text references users(id),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  check ((to_item_id is not null and external_kind is null and external_ref is null)
      or (to_item_id is null and external_kind is not null and external_ref is not null)),
  check (to_item_id is null or to_item_id <> from_item_id)
);
create unique index relations_item_edge_uq on relations(type, from_item_id, to_item_id) where to_item_id is not null and deleted_at is null;
create unique index relations_external_edge_uq on relations(type, from_item_id, external_key) where external_key is not null and deleted_at is null;
create index relations_from_idx on relations(from_item_id) where deleted_at is null;
create index relations_to_idx on relations(to_item_id) where deleted_at is null;
create index relations_external_idx on relations(external_kind, json_extract(external_ref, '$.url')) where deleted_at is null;
-- single parent in the hierarchy
create unique index relations_single_parent_uq on relations(to_item_id) where type = 'parent_of' and deleted_at is null;

-- Reject reverse duplicates of symmetric edges; prevent cycles in hierarchy and blocking graphs.
create trigger relations_no_cycle_ins before insert on relations
when new.to_item_id is not null and new.deleted_at is null
begin
  select raise(abort, 'symmetric relation already exists in the other direction')
   where (select is_symmetric from relation_types where key = new.type) = 1
     and exists (select 1 from relations r where r.type = new.type and r.from_item_id = new.to_item_id and r.to_item_id = new.from_item_id and r.deleted_at is null);
  select raise(abort, 'relation would create a cycle')
   where (select is_hierarchy = 1 or is_blocking = 1 from relation_types where key = new.type)
     and exists (
       with recursive walk(item_id, depth) as (
         select new.to_item_id, 0
         union all
         select r.to_item_id, w.depth + 1 from relations r join walk w on r.from_item_id = w.item_id
          where r.type = new.type and r.deleted_at is null and w.depth < 1000
       )
       select 1 from walk where item_id = new.from_item_id);
end;
create trigger relations_no_cycle_upd before update of from_item_id, to_item_id, type, deleted_at on relations
when new.to_item_id is not null and new.deleted_at is null
begin
  select raise(abort, 'symmetric relation already exists in the other direction')
   where (select is_symmetric from relation_types where key = new.type) = 1
     and exists (select 1 from relations r where r.type = new.type and r.from_item_id = new.to_item_id and r.to_item_id = new.from_item_id and r.deleted_at is null and r.id <> new.id);
  select raise(abort, 'relation would create a cycle')
   where (select is_hierarchy = 1 or is_blocking = 1 from relation_types where key = new.type)
     and exists (
       with recursive walk(item_id, depth) as (
         select new.to_item_id, 0
         union all
         select r.to_item_id, w.depth + 1 from relations r join walk w on r.from_item_id = w.item_id
          where r.type = new.type and r.deleted_at is null and r.id <> new.id and w.depth < 1000
       )
       select 1 from walk where item_id = new.from_item_id);
end;

-- Graph helpers (views; SQLite has no SQL functions) -------------------------
-- Direct parent of each item
create view item_parents as
  select r.to_item_id as item_id, r.from_item_id as parent_id
    from relations r where r.type = 'parent_of' and r.deleted_at is null;

-- Every (ancestor, descendant) pair with depth, through parent_of
create view item_ancestry as
  with recursive a(ancestor_id, item_id, depth) as (
    select r.from_item_id, r.to_item_id, 1 from relations r where r.type = 'parent_of' and r.deleted_at is null
    union all
    select a.ancestor_id, r.to_item_id, a.depth + 1
      from relations r join a on r.from_item_id = a.item_id
     where r.type = 'parent_of' and r.deleted_at is null and a.depth < 100
  )
  select ancestor_id, item_id, depth from a;

-- Open blockers: (blocked item, blocker) where the blocker is not done/canceled
create view open_blockers as
  select r.to_item_id as item_id, r.from_item_id as blocker_id
    from relations r
    join work_items b on b.id = r.from_item_id and b.deleted_at is null
    join workflow_states s on s.id = b.state_id
   where r.type = 'blocks' and r.deleted_at is null and s.category not in ('done', 'canceled');

-- Rollup over each subtree: counts by category + estimate sums
--   select * from item_rollups where root_id = ?
create view item_rollups as
  select a.ancestor_id as root_id,
         count(*) as total,
         sum(case when s.category = 'done' then 1 else 0 end) as done,
         sum(case when s.category = 'in_progress' then 1 else 0 end) as in_progress,
         sum(case when s.category in ('todo','backlog') then 1 else 0 end) as todo,
         sum(case when s.category = 'canceled' then 1 else 0 end) as canceled,
         coalesce(sum(w.estimate), 0) as estimate_total,
         coalesce(sum(case when s.category = 'done' then w.estimate end), 0) as estimate_done
    from item_ancestry a
    join work_items w on w.id = a.item_id and w.deleted_at is null
    join workflow_states s on s.id = w.state_id
   group by a.ancestor_id;

-- ----------------------------------------------------------------------------
-- 7. Activity log: append-only, one event per field change
-- ----------------------------------------------------------------------------
create table activity_events (
  id            integer primary key autoincrement,  -- monotonic cursor
  txn_id        text not null,                     -- groups events from one mutation (undo unit)
  entity_type   text not null,                     -- work_item | comment | relation | project | view | label | ...
  entity_id     text not null,
  item_id       text,                              -- denormalized: the work item this touches (for timelines)
  project_id    text,                              -- denormalized: for scoping/permissions
  actor_kind    text not null default 'user' check (actor_kind in ('user','api_key','integration','system','agent')),
  actor_id      text,                              -- users.id (also for api_key/agent: the owning user)
  actor_label   text,                              -- "github", "slack", api key name, agent name
  action        text not null,                     -- create | update | delete | restore | transition | relation_add | relation_remove | comment | ...
  field         text,                              -- "title", "state_id", "fields.severity", null for create/delete
  old_value     text check (old_value is null or json_valid(old_value)),   -- JSON
  new_value     text check (new_value is null or json_valid(new_value)),   -- JSON
  mutation_name text,                              -- client mutator / API op that produced it
  source        text not null default 'app',       -- app | api | mcp | slack | email | github | system
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index activity_item_idx on activity_events(item_id, id) where item_id is not null;
create index activity_project_idx on activity_events(project_id, id);
create index activity_entity_idx on activity_events(entity_type, entity_id, id);
create index activity_actor_idx on activity_events(actor_id, id);
create index activity_txn_idx on activity_events(txn_id);
create index activity_created_idx on activity_events(created_at);

-- Physically block mutation of history.
create trigger activity_events_no_update before update on activity_events begin
  select raise(abort, 'activity_events is append-only (UPDATE denied)');
end;
create trigger activity_events_no_delete before delete on activity_events begin
  select raise(abort, 'activity_events is append-only (DELETE denied)');
end;

-- ----------------------------------------------------------------------------
-- 8. Views as saved queries
-- ----------------------------------------------------------------------------
-- spec is a QuerySpec (see @pm/core/query): the SAME spec drives lists, boards,
-- timelines and dashboards, compiled to SQL on the server and evaluated as a
-- predicate on the client against local data.
--   {
--     "filter": {"and":[{"field":"project_id","op":"eq","value":"..."},
--                       {"field":"state.category","op":"nin","value":["done","canceled"]},
--                       {"field":"fields.severity","op":"in","value":["s1","s2"]}]},
--     "sort":   [{"field":"priority","dir":"asc"},{"field":"due_date","dir":"asc"}],
--     "group_by": "state_id",
--     "columns": ["key","title","assignee_id","priority","due_date","fields.severity"],
--     "board":   {"column_field":"state_id","swimlane_field":null},
--     "timeline":{"start_field":"start_date","end_field":"due_date"},
--     "dashboard":{"widgets":[{"title":"Open by assignee","viz":"bar","group_by":"assignee_id","measure":"count"}]}
--   }
create table views (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  project_id    text references projects(id) on delete cascade,  -- null = cross-project
  owner_id      text references users(id),                        -- null = system/shared default
  name          text not null,
  kind          text not null default 'list' check (kind in ('list','board','timeline','dashboard')),
  spec          text not null default '{}' check (json_valid(spec) and json_type(spec) = 'object'),
  is_shared     integer not null default 0 check (is_shared in (0,1)),   -- visible to all project members
  is_default    integer not null default 0 check (is_default in (0,1)),
  icon          text,
  sort          integer not null default 0,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create index views_project_idx on views(project_id) where deleted_at is null;
create index views_owner_idx on views(owner_id) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- 9. Watchers + notifications (low-noise by construction)
-- ----------------------------------------------------------------------------
create table item_watchers (
  item_id       text not null references work_items(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  reason        text not null check (reason in ('assignee','reporter','mention','commenter','manual')),
  muted         integer not null default 0 check (muted in (0,1)),
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (item_id, user_id)
);

-- One row per (user, channel). `rules` selects which event kinds are worth a
-- ping: default = mentions + assignments + replies + state changes on items you
-- are assigned to. Everything else only appears in the activity feed.
create table notification_preferences (
  user_id       text not null references users(id) on delete cascade,
  channel       text not null check (channel in ('in_app','email','slack')),
  cadence       text not null default 'immediate' check (cadence in ('immediate','hourly','daily','off')),
  rules         text not null default '{"mention":true,"assigned":true,"reply":true,"state_change_assigned":true,"state_change_watching":false,"comment_watching":false,"due_soon":true}' check (json_valid(rules) and json_type(rules) = 'object'),
  quiet_hours   text check (quiet_hours is null or json_valid(quiet_hours)),   -- {"start":"19:00","end":"07:00","tz":"America/New_York"}
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  primary key (user_id, channel)
);

create table notifications (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id       text not null references users(id) on delete cascade,
  item_id       text references work_items(id) on delete cascade,
  event_id      integer references activity_events(id),
  kind          text not null,                -- mention | assigned | reply | state_change | due_soon | mutation_rejected | ...
  title         text not null,
  body          text,
  actor_id      text references users(id),
  read_at       text,
  archived_at   text,
  version       integer not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);
create index notifications_user_unread_idx on notifications(user_id, created_at desc) where read_at is null and deleted_at is null;

-- Outbound deliveries (email/slack) are collapsed per (user, window)
create table notification_deliveries (
  id            integer primary key autoincrement,
  user_id       text not null references users(id) on delete cascade,
  channel       text not null check (channel in ('in_app','email','slack')),
  notification_ids text not null check (json_valid(notification_ids) and json_type(notification_ids) = 'array'),
  scheduled_for text not null,
  sent_at       text,
  error         text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index notification_deliveries_pending_idx on notification_deliveries(scheduled_for) where sent_at is null;

-- ----------------------------------------------------------------------------
-- 10. Integrations: webhooks out, inbound links
-- ----------------------------------------------------------------------------
create table webhook_endpoints (
  id            text primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  name          text not null,
  url           text not null,
  secret        text not null,                   -- HMAC-SHA256 of body in X-PM-Signature
  event_kinds   text not null default '["*"]' check (json_valid(event_kinds) and json_type(event_kinds) = 'array'),  -- e.g. ["item.created","comment.created"]
  project_id    text references projects(id) on delete cascade,  -- null = all projects
  is_active     integer not null default 1 check (is_active in (0,1)),
  created_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

create table webhook_deliveries (
  id            integer primary key autoincrement,
  endpoint_id   text not null references webhook_endpoints(id) on delete cascade,
  event_id      integer not null references activity_events(id),
  event_kind    text not null,
  payload       text not null check (json_valid(payload)),
  status        text not null default 'pending' check (status in ('pending','delivered','failed','dead')),
  attempts      integer not null default 0,
  next_attempt_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempt_at text,
  response_status integer,
  response_body text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index webhook_deliveries_pending_idx on webhook_deliveries(next_attempt_at) where status in ('pending','failed');

-- Integration configs: one row per kind, config validated by the integration
--   slack : {"team_id":..., "channel_map": {"RATES":"C0123"}, "notify_on": [...]}
--   github: {"repos": ["org/repo"], "autolink": true}
--   email : {"inbound_domain": "pm.example.com"}
create table integration_configs (
  kind          text primary key,                 -- slack | github | email
  config        text not null default '{}' check (json_valid(config) and json_type(config) = 'object'),
  is_active     integer not null default 0 check (is_active in (0,1)),
  updated_by    text references users(id),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Idempotency for inbound events (Slack retries, GitHub redeliveries, email dupes)
create table inbound_events (
  source        text not null,
  external_id   text not null,
  received_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (source, external_id)
);

-- ----------------------------------------------------------------------------
-- 11. Sync bookkeeping (Replicache-style push/pull)
-- ----------------------------------------------------------------------------
create table sync_client_groups (
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  resync_required integer not null default 0 check (resync_required in (0,1)),  -- set when the user's visibility changes
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table sync_clients (
  id              text primary key,
  client_group_id text not null references sync_client_groups(id) on delete cascade,
  last_mutation_id integer not null default 0,
  version         integer not null default 0,      -- global version at which last_mutation_id changed
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index sync_clients_group_idx on sync_clients(client_group_id);

-- ----------------------------------------------------------------------------
-- 12. Permissions as views (used by API + sync pull)
-- ----------------------------------------------------------------------------
-- Effective project role for every (active user, live project) pair that has
-- access: explicit membership wins; else firm owner/admin → admin; else firm
-- member on a firm-visible project → editor; guests only via membership.
create view effective_roles as
  select user_id, project_id, role from (
    select u.id as user_id, p.id as project_id,
           coalesce(pm.role,
                    case when u.firm_role in ('owner','admin') then 'admin'
                         when u.firm_role = 'member' and p.visibility = 'firm' then 'editor'
                    end) as role
      from users u
      cross join projects p
      left join project_members pm on pm.user_id = u.id and pm.project_id = p.id and pm.deleted_at is null
     where u.deleted_at is null and u.is_active = 1 and p.deleted_at is null
  ) where role is not null;

-- Items each user may see: project access + the confidential rule.
--   exists (select 1 from visible_items vi where vi.user_id = ? and vi.item_id = w.id)
create view visible_items as
  select er.user_id, w.id as item_id
    from work_items w
    join effective_roles er on er.project_id = w.project_id
   where w.deleted_at is null
     and (w.confidential = 0
          or w.assignee_id = er.user_id or w.reporter_id = er.user_id or w.created_by = er.user_id
          or er.role = 'admin');

-- ----------------------------------------------------------------------------
-- 13. Firm-level settings
-- ----------------------------------------------------------------------------
create table settings (
  key           text primary key,
  value         text not null check (json_valid(value)),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
insert into settings(key, value) values
  ('firm', '{"name":"The Firm","item_key_prefix_style":"project"}'),
  ('sync', '{"strategy":"global_version"}');

-- ----------------------------------------------------------------------------
-- 14. Sync version + updated_at triggers for every synced table
-- ----------------------------------------------------------------------------
-- Insert: stamp version with the next global value.
-- Update: when the statement did not itself change `version` (i.e. an
-- application write, not our own stamp), bump the counter, stamp the row and
-- refresh updated_at. recursive_triggers is off by default, so the stamping
-- UPDATE cannot re-fire the same trigger.
create trigger users_version_ins after insert on users begin
  update sync_state set version = version + 1 where id = 1;
  update users set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger users_version_upd after update on users when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update users set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger teams_version_ins after insert on teams begin
  update sync_state set version = version + 1 where id = 1;
  update teams set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger teams_version_upd after update on teams when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update teams set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger workflows_version_ins after insert on workflows begin
  update sync_state set version = version + 1 where id = 1;
  update workflows set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger workflows_version_upd after update on workflows when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update workflows set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger workflow_states_version_ins after insert on workflow_states begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_states set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger workflow_states_version_upd after update on workflow_states when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_states set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger workflow_transitions_version_ins after insert on workflow_transitions begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_transitions set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger workflow_transitions_version_upd after update on workflow_transitions when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update workflow_transitions set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger item_types_version_ins after insert on item_types begin
  update sync_state set version = version + 1 where id = 1;
  update item_types set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger item_types_version_upd after update on item_types when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update item_types set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger projects_version_ins after insert on projects begin
  update sync_state set version = version + 1 where id = 1;
  update projects set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger projects_version_upd after update on projects when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update projects set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger project_members_version_ins after insert on project_members begin
  update sync_state set version = version + 1 where id = 1;
  update project_members set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger project_members_version_upd after update on project_members when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update project_members set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger work_items_version_ins after insert on work_items begin
  update sync_state set version = version + 1 where id = 1;
  update work_items set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger work_items_version_upd after update on work_items when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update work_items set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger labels_version_ins after insert on labels begin
  update sync_state set version = version + 1 where id = 1;
  update labels set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger labels_version_upd after update on labels when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update labels set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger work_item_labels_version_ins after insert on work_item_labels begin
  update sync_state set version = version + 1 where id = 1;
  update work_item_labels set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger work_item_labels_version_upd after update on work_item_labels when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update work_item_labels set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger comments_version_ins after insert on comments begin
  update sync_state set version = version + 1 where id = 1;
  update comments set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger comments_version_upd after update on comments when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update comments set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger attachments_version_ins after insert on attachments begin
  update sync_state set version = version + 1 where id = 1;
  update attachments set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger attachments_version_upd after update on attachments when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update attachments set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger relations_version_ins after insert on relations begin
  update sync_state set version = version + 1 where id = 1;
  update relations set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger relations_version_upd after update on relations when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update relations set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger views_version_ins after insert on views begin
  update sync_state set version = version + 1 where id = 1;
  update views set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger views_version_upd after update on views when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update views set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger item_watchers_version_ins after insert on item_watchers begin
  update sync_state set version = version + 1 where id = 1;
  update item_watchers set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger item_watchers_version_upd after update on item_watchers when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update item_watchers set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger notification_preferences_version_ins after insert on notification_preferences begin
  update sync_state set version = version + 1 where id = 1;
  update notification_preferences set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger notification_preferences_version_upd after update on notification_preferences when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update notification_preferences set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

create trigger notifications_version_ins after insert on notifications begin
  update sync_state set version = version + 1 where id = 1;
  update notifications set version = (select version from sync_state where id = 1) where rowid = new.rowid;
end;
create trigger notifications_version_upd after update on notifications when new.version = old.version begin
  update sync_state set version = version + 1 where id = 1;
  update notifications set version = (select version from sync_state where id = 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where rowid = new.rowid;
end;

-- ----------------------------------------------------------------------------
-- 15. Default workflows + item types (fixed ids so the schema is usable at once)
-- ----------------------------------------------------------------------------
insert into workflows(id, key, name, description) values
  ('00000000-0000-4000-8000-000000000a01', 'standard', 'Standard', 'Backlog → Todo → In Progress → In Review → Done'),
  ('00000000-0000-4000-8000-000000000a02', 'simple',   'Simple',   'Todo → Doing → Done');

insert into workflow_states(id, workflow_id, key, name, category, color, sort, is_initial) values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000a01', 'backlog',     'Backlog',     'backlog',     '#9ca3af', 0, 0),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-000000000a01', 'todo',        'Todo',        'todo',        '#60a5fa', 1, 1),
  ('00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-000000000a01', 'in_progress', 'In Progress', 'in_progress', '#f59e0b', 2, 0),
  ('00000000-0000-4000-8000-000000000b04', '00000000-0000-4000-8000-000000000a01', 'in_review',   'In Review',   'in_progress', '#a78bfa', 3, 0),
  ('00000000-0000-4000-8000-000000000b05', '00000000-0000-4000-8000-000000000a01', 'done',        'Done',        'done',        '#10b981', 4, 0),
  ('00000000-0000-4000-8000-000000000b06', '00000000-0000-4000-8000-000000000a01', 'canceled',    'Canceled',    'canceled',    '#6b7280', 5, 0),
  ('00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000a02', 'todo',        'Todo',        'todo',        '#60a5fa', 0, 1),
  ('00000000-0000-4000-8000-000000000b12', '00000000-0000-4000-8000-000000000a02', 'doing',       'Doing',       'in_progress', '#f59e0b', 1, 0),
  ('00000000-0000-4000-8000-000000000b13', '00000000-0000-4000-8000-000000000a02', 'done',        'Done',        'done',        '#10b981', 2, 0),
  ('00000000-0000-4000-8000-000000000b14', '00000000-0000-4000-8000-000000000a02', 'canceled',    'Canceled',    'canceled',    '#6b7280', 3, 0);

insert into workflow_transitions(id, workflow_id, key, name, from_state_id, to_state_id, guards, effects, sort) values
  ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000a01', 'triage',   'Triage',          '00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000b02', '[]', '[]', 0),
  ('00000000-0000-4000-8000-000000000c02', '00000000-0000-4000-8000-000000000a01', 'start',    'Start',           null,                                   '00000000-0000-4000-8000-000000000b03',
     '[{"type":"require_field","field":"assignee_id"},{"type":"no_open_blockers"}]',
     '[{"type":"set_field","field":"start_date","value":"$today","only_if_null":true}]', 1),
  ('00000000-0000-4000-8000-000000000c03', '00000000-0000-4000-8000-000000000a01', 'review',   'Send to review',  '00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-000000000b04', '[]', '[{"type":"notify","audience":["watchers"],"template":"review_requested"}]', 2),
  ('00000000-0000-4000-8000-000000000c04', '00000000-0000-4000-8000-000000000a01', 'reopen',   'Reopen',          '00000000-0000-4000-8000-000000000b04', '00000000-0000-4000-8000-000000000b03', '[]', '[]', 3),
  ('00000000-0000-4000-8000-000000000c05', '00000000-0000-4000-8000-000000000a01', 'complete', 'Complete',        null,                                   '00000000-0000-4000-8000-000000000b05',
     '[{"type":"children_in_category","categories":["done","canceled"]}]',
     '[{"type":"set_field","field":"completed_at","value":"$now"},{"type":"webhook","event":"item.completed"}]', 4),
  ('00000000-0000-4000-8000-000000000c06', '00000000-0000-4000-8000-000000000a01', 'cancel',   'Cancel',          null,                                   '00000000-0000-4000-8000-000000000b06',
     '[{"type":"require_role","roles":["admin","editor"]}]',
     '[{"type":"set_field","field":"canceled_at","value":"$now"}]', 5),
  ('00000000-0000-4000-8000-000000000c07', '00000000-0000-4000-8000-000000000a01', 'restore',  'Restore',         '00000000-0000-4000-8000-000000000b06', '00000000-0000-4000-8000-000000000b02', '[]', '[{"type":"set_field","field":"canceled_at","value":null}]', 6),
  ('00000000-0000-4000-8000-000000000c08', '00000000-0000-4000-8000-000000000a01', 'backlog',  'Back to backlog', null,                                   '00000000-0000-4000-8000-000000000b01', '[]', '[{"type":"set_field","field":"completed_at","value":null}]', 7),
  ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000a02', 'start',    'Start',           null, '00000000-0000-4000-8000-000000000b12', '[]', '[]', 0),
  ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000a02', 'complete', 'Complete',        null, '00000000-0000-4000-8000-000000000b13', '[]', '[{"type":"set_field","field":"completed_at","value":"$now"}]', 1),
  ('00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000a02', 'cancel',   'Cancel',          null, '00000000-0000-4000-8000-000000000b14', '[]', '[{"type":"set_field","field":"canceled_at","value":"$now"}]', 2),
  ('00000000-0000-4000-8000-000000000c14', '00000000-0000-4000-8000-000000000a02', 'reopen',   'Reopen',          null, '00000000-0000-4000-8000-000000000b11', '[]', '[{"type":"set_field","field":"completed_at","value":null},{"type":"set_field","field":"canceled_at","value":null}]', 3);

insert into item_types(id, key, name, plural_name, icon, color, workflow_id, is_container, sort, field_defs) values
  ('00000000-0000-4000-8000-000000000d01', 'task', 'Task', 'Tasks', 'check-square', '#60a5fa', '00000000-0000-4000-8000-000000000a01', 0, 0, '[]'),
  ('00000000-0000-4000-8000-000000000d02', 'bug',  'Bug',  'Bugs',  'bug', '#ef4444', '00000000-0000-4000-8000-000000000a01', 0, 1,
    '[{"key":"severity","label":"Severity","kind":"select","required":true,
       "options":[{"value":"s1","label":"S1 – Critical"},{"value":"s2","label":"S2 – High"},{"value":"s3","label":"S3 – Medium"},{"value":"s4","label":"S4 – Low"}]},
      {"key":"environment","label":"Environment","kind":"select",
       "options":[{"value":"prod","label":"Production"},{"value":"uat","label":"UAT"},{"value":"dev","label":"Dev"}]},
      {"key":"steps","label":"Steps to reproduce","kind":"long_text"}]'),
  ('00000000-0000-4000-8000-000000000d03', 'initiative', 'Initiative', 'Initiatives', 'flag', '#a78bfa', '00000000-0000-4000-8000-000000000a01', 1, 2,
    '[{"key":"owner_desk","label":"Owning desk","kind":"text"},
      {"key":"business_case","label":"Business case","kind":"long_text"},
      {"key":"budget","label":"Budget (USD)","kind":"number"},
      {"key":"quarter","label":"Target quarter","kind":"select",
       "options":[{"value":"2026Q4","label":"2026 Q4"},{"value":"2027Q1","label":"2027 Q1"},{"value":"2027Q2","label":"2027 Q2"}]}]'),
  ('00000000-0000-4000-8000-000000000d04', 'request', 'Request', 'Requests', 'inbox', '#f59e0b', '00000000-0000-4000-8000-000000000a02', 0, 3,
    '[{"key":"requester_desk","label":"Requesting desk","kind":"text"},
      {"key":"urgency","label":"Urgency","kind":"select",
       "options":[{"value":"today","label":"Today"},{"value":"this_week","label":"This week"},{"value":"whenever","label":"Whenever"}]},
      {"key":"approved","label":"Approved","kind":"bool"}]');

-- ----------------------------------------------------------------------------
-- 16. Convenience view: items with resolved display columns
-- ----------------------------------------------------------------------------
-- label_names is a JSON array; is_blocked is 0/1.
create view work_items_v as
select w.*,
       t.key  as type_key, t.name as type_name,
       s.key  as state_key, s.name as state_name, s.category as state_category,
       p.key  as project_key, p.name as project_name,
       a.name as assignee_name,
       (select json_group_array(name) from (select l.name from work_item_labels wl join labels l on l.id = wl.label_id where wl.item_id = w.id and wl.deleted_at is null and l.deleted_at is null order by l.name)) as label_names,
       (select r.from_item_id from relations r where r.to_item_id = w.id and r.type = 'parent_of' and r.deleted_at is null) as parent_id,
       exists(select 1 from open_blockers ob where ob.item_id = w.id) as is_blocked
from work_items w
join item_types t on t.id = w.type_id
join workflow_states s on s.id = w.state_id
join projects p on p.id = w.project_id
left join users a on a.id = w.assignee_id;
