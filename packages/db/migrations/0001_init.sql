-- ============================================================================
-- pm-tool :: core data model
-- ----------------------------------------------------------------------------
-- This migration is intentionally self-contained: it can be applied to any
-- Postgres 15+ database with `psql -f` and used standalone, without the rest
-- of the monorepo.
--
-- Design pillars (see docs/01-data-model.md):
--   1. One generic `work_item` entity with a `type` + validated JSONB `fields`.
--   2. Workflows are DATA: states + transitions + guards + effects per workflow.
--   3. Relations are one typed edge table (parent/child, blocks, duplicates,
--      external links). Rollups and dependency checks are graph queries.
--   4. Activity log is append-only, one row per field change. UPDATE/DELETE on
--      it is physically blocked by a trigger.
--   5. Permissions: per-project roles (RBAC) + firm role + project visibility,
--      evaluated by one function. ABAC hooks live in workflow guards, not ACLs.
--   6. Views are saved queries (`views.spec`), not screens.
--   7. Every synced table carries `version` (global version for sync pulls)
--      and uses soft-delete tombstones so clients can converge.
-- ============================================================================

set client_min_messages = warning;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ----------------------------------------------------------------------------
-- 0. Sync plumbing (global version strategy)
-- ----------------------------------------------------------------------------
-- Every row in a synced table gets `version = nextval('sync_version_seq')` on
-- insert/update via trigger. Clients pull `where version > :cookie`.
-- Writers that participate in sync take `pg_advisory_xact_lock(42)` so that
-- version order == commit order (see docs/05-architecture.md#sync).
create sequence if not exists sync_version_seq as bigint start 1;

create or replace function trg_set_version() returns trigger
language plpgsql as $$
begin
  new.version := nextval('sync_version_seq');
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Helper: install the version trigger on a table
create or replace function install_sync_trigger(tbl regclass) returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists set_version on %s', tbl);
  execute format('create trigger set_version before insert or update on %s for each row execute function trg_set_version()', tbl);
end $$;

-- ----------------------------------------------------------------------------
-- 1. Principals
-- ----------------------------------------------------------------------------
create type firm_role as enum ('owner', 'admin', 'member', 'guest');

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null,
  avatar_url    text,
  firm_role     firm_role not null default 'member',
  is_active     boolean not null default true,
  is_service    boolean not null default false,   -- bots / integrations / agents
  settings      jsonb not null default '{}'::jsonb,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index users_email_uq on users (lower(email)) where deleted_at is null;
select install_sync_trigger('users');

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create index sessions_user_idx on sessions(user_id);

create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  key_prefix    text not null,          -- first 8 chars, for display
  key_hash      text not null unique,   -- sha256 of full key
  scopes        text[] not null default '{read,write}',
  expires_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index api_keys_user_idx on api_keys(user_id);

create table teams (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,   -- e.g. "RATES", "OPS"
  name          text not null,
  description   text,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
select install_sync_trigger('teams');

create table team_members (
  team_id       uuid not null references teams(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  is_lead       boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 2. Workflows (state machines as data)
-- ----------------------------------------------------------------------------
create table workflows (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name          text not null,
  description   text,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
select install_sync_trigger('workflows');

-- Category lets generic UI/queries treat states uniformly across workflows
-- (e.g. "show me everything not done" regardless of type).
create type state_category as enum ('backlog', 'todo', 'in_progress', 'done', 'canceled');

create table workflow_states (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references workflows(id) on delete cascade,
  key           text not null,
  name          text not null,
  category      state_category not null,
  color         text,
  sort          integer not null default 0,
  is_initial    boolean not null default false,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (workflow_id, key)
);
create unique index workflow_states_one_initial on workflow_states(workflow_id) where is_initial and deleted_at is null;
select install_sync_trigger('workflow_states');

-- A transition with from_state_id = NULL is allowed from ANY state.
-- guards:  JSON array of guard specs evaluated by @pm/core workflow engine, e.g.
--   [{"type":"require_field","field":"assignee_id"},
--    {"type":"no_open_blockers"},
--    {"type":"children_in_category","category":"done"},
--    {"type":"require_role","roles":["admin","editor"]},
--    {"type":"field_equals","field":"fields.approved","value":true}]
-- effects: JSON array of side effects applied after the transition, e.g.
--   [{"type":"set_field","field":"completed_at","value":"$now"},
--    {"type":"set_field","field":"assignee_id","value":null},
--    {"type":"notify","audience":["watchers"],"template":"state_changed"},
--    {"type":"webhook","event":"item.transitioned"},
--    {"type":"transition_parent_if","all_children_category":"done","to":"done"}]
create table workflow_transitions (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references workflows(id) on delete cascade,
  key           text not null,
  name          text not null,
  from_state_id uuid references workflow_states(id) on delete cascade,
  to_state_id   uuid not null references workflow_states(id) on delete cascade,
  guards        jsonb not null default '[]'::jsonb check (jsonb_typeof(guards) = 'array'),
  effects       jsonb not null default '[]'::jsonb check (jsonb_typeof(effects) = 'array'),
  sort          integer not null default 0,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (workflow_id, key)
);
create index workflow_transitions_from_idx on workflow_transitions(workflow_id, from_state_id);
select install_sync_trigger('workflow_transitions');

-- ----------------------------------------------------------------------------
-- 3. Item types (one generic entity, typed fields via registry + JSONB)
-- ----------------------------------------------------------------------------
-- field_defs: JSON array describing the type-specific fields stored in
-- work_items.fields. Validated by trg_validate_item_fields (DB) and by the
-- zod schema generated from the same defs in @pm/core (app).
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
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,          -- "task", "bug", "initiative", "trade_idea"
  name          text not null,
  plural_name   text,
  icon          text,
  color         text,
  description   text,
  workflow_id   uuid not null references workflows(id),
  field_defs    jsonb not null default '[]'::jsonb check (jsonb_typeof(field_defs) = 'array'),
  is_container  boolean not null default false,  -- can have children (epic/initiative)
  sort          integer not null default 0,
  is_active     boolean not null default true,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
select install_sync_trigger('item_types');

-- ----------------------------------------------------------------------------
-- 4. Projects + membership (permissions backbone)
-- ----------------------------------------------------------------------------
create type project_visibility as enum ('firm', 'private');
create type project_role as enum ('admin', 'editor', 'viewer');
create type project_status as enum ('planned', 'active', 'paused', 'completed', 'archived');

create table projects (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,     -- "RATES", "ONB" → item keys RATES-12
  name          text not null,
  description   text,
  status        project_status not null default 'active',
  visibility    project_visibility not null default 'firm',
  lead_id       uuid references users(id),
  team_id       uuid references teams(id),
  item_seq      integer not null default 0,   -- per-project item numbering
  default_type_id uuid references item_types(id),
  allowed_type_ids uuid[],                     -- null = all active types
  settings      jsonb not null default '{}'::jsonb,
  start_date    date,
  target_date   date,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  deleted_at    timestamptz,
  check (key ~ '^[A-Z][A-Z0-9]{1,9}$')
);
select install_sync_trigger('projects');

create table project_members (
  project_id    uuid not null references projects(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  role          project_role not null default 'editor',
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (project_id, user_id)
);
create index project_members_user_idx on project_members(user_id);
select install_sync_trigger('project_members');

-- ----------------------------------------------------------------------------
-- 5. Work items (the one generic entity)
-- ----------------------------------------------------------------------------
create table work_items (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id),
  type_id       uuid not null references item_types(id),
  number        integer not null,                       -- per project; filled by trigger when omitted
  key           text not null unique,                   -- "RATES-12" (denormalized for search/links)
  title         text not null check (length(title) between 1 and 500),
  description   text not null default '',               -- markdown
  state_id      uuid not null references workflow_states(id),
  priority      smallint not null default 0 check (priority between 0 and 4), -- 0 none,1 urgent..4 low
  assignee_id   uuid references users(id),
  reporter_id   uuid references users(id),
  start_date    date,
  due_date      date,
  estimate      numeric(10,2),                           -- points/hours; unit per project settings
  fields        jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  confidential  boolean not null default false,         -- visible to project admins + assignee + reporter only
  sort_order    double precision not null default 0,    -- manual ordering within a board column
  search        tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(key, '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(description, '')), 'C')
                ) stored,
  version       bigint not null default 0,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  canceled_at   timestamptz,
  archived_at   timestamptz,
  deleted_at    timestamptz,
  unique (project_id, number)
);
create index work_items_project_state_idx on work_items(project_id, state_id) where deleted_at is null;
create index work_items_assignee_idx on work_items(assignee_id) where deleted_at is null;
create index work_items_type_idx on work_items(type_id) where deleted_at is null;
create index work_items_due_idx on work_items(due_date) where deleted_at is null and due_date is not null;
create index work_items_search_idx on work_items using gin(search);
create index work_items_fields_idx on work_items using gin(fields jsonb_path_ops);
create index work_items_title_trgm_idx on work_items using gin(title gin_trgm_ops);
create index work_items_version_idx on work_items(version);
select install_sync_trigger('work_items');

-- Assign per-project number + key on insert
create or replace function trg_assign_item_number() returns trigger
language plpgsql as $$
declare pkey text;
begin
  if new.number is null or new.number = 0 then
    update projects set item_seq = item_seq + 1 where id = new.project_id
      returning item_seq, key into new.number, pkey;
  else
    select key into pkey from projects where id = new.project_id;
  end if;
  new.key := pkey || '-' || new.number;
  return new;
end $$;
-- BEFORE ROW triggers run before NOT NULL/UNIQUE checks, so the trigger may fill `number`.
create trigger assign_item_number before insert on work_items
  for each row execute function trg_assign_item_number();

-- Validate `fields` JSONB against item_types.field_defs (shape + required).
-- Deep validation (option membership, user existence) happens in @pm/core.
create or replace function trg_validate_item_fields() returns trigger
language plpgsql as $$
declare
  def jsonb;
  k text;
  kind text;
  v jsonb;
  defs jsonb;
begin
  select field_defs into defs from item_types where id = new.type_id;
  if defs is null then
    raise exception 'unknown item type %', new.type_id;
  end if;
  -- unknown keys are rejected: keeps JSONB honest
  for k in select jsonb_object_keys(new.fields) loop
    if not exists (select 1 from jsonb_array_elements(defs) d where d->>'key' = k) then
      raise exception 'field "%" is not defined for this item type', k using errcode = '23514';
    end if;
  end loop;
  for def in select * from jsonb_array_elements(defs) loop
    k := def->>'key';
    kind := def->>'kind';
    v := new.fields -> k;
    if coalesce((def->>'required')::boolean, false) and (v is null or v = 'null'::jsonb) then
      raise exception 'field "%" is required', k using errcode = '23514';
    end if;
    if v is null or v = 'null'::jsonb then continue; end if;
    if coalesce((def->>'multi')::boolean, false) or kind = 'multi_select' then
      if jsonb_typeof(v) <> 'array' then
        raise exception 'field "%" must be an array', k using errcode = '23514';
      end if;
      continue;
    end if;
    if kind in ('text','long_text','select','user','url','date','datetime') and jsonb_typeof(v) <> 'string' then
      raise exception 'field "%" must be a string', k using errcode = '23514';
    elsif kind = 'number' and jsonb_typeof(v) <> 'number' then
      raise exception 'field "%" must be a number', k using errcode = '23514';
    elsif kind = 'bool' and jsonb_typeof(v) <> 'boolean' then
      raise exception 'field "%" must be a boolean', k using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
create trigger validate_item_fields before insert or update of fields, type_id on work_items
  for each row execute function trg_validate_item_fields();

-- Enforce that state belongs to the item type's workflow
create or replace function trg_validate_item_state() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from workflow_states s join item_types t on t.workflow_id = s.workflow_id
    where s.id = new.state_id and t.id = new.type_id
  ) then
    raise exception 'state % does not belong to workflow of type %', new.state_id, new.type_id using errcode = '23514';
  end if;
  return new;
end $$;
create trigger validate_item_state before insert or update of state_id, type_id on work_items
  for each row execute function trg_validate_item_state();

create table labels (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references projects(id) on delete cascade, -- null = firm-wide label
  name          text not null,
  color         text,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index labels_name_uq on labels(coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where deleted_at is null;
select install_sync_trigger('labels');

create table work_item_labels (
  item_id       uuid not null references work_items(id) on delete cascade,
  label_id      uuid not null references labels(id) on delete cascade,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (item_id, label_id)
);
select install_sync_trigger('work_item_labels');

create table comments (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references work_items(id) on delete cascade,
  author_id     uuid references users(id),
  body          text not null,                       -- markdown; @mentions as @[name](user:uuid)
  parent_id     uuid references comments(id),        -- threaded replies
  source        text not null default 'app',         -- app | email | slack | github | mcp | api
  external_ref  jsonb,                               -- e.g. slack ts, email message-id
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  edited_at     timestamptz,
  deleted_at    timestamptz
);
create index comments_item_idx on comments(item_id, created_at);
select install_sync_trigger('comments');

create table attachments (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references work_items(id) on delete cascade,
  name          text not null,
  url           text not null,
  mime_type     text,
  size_bytes    bigint,
  created_by    uuid references users(id),
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
select install_sync_trigger('attachments');

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
  is_hierarchy  boolean not null default false,
  is_blocking   boolean not null default false,
  is_symmetric  boolean not null default false,
  sort          integer not null default 0
);
insert into relation_types (key, name, inverse_name, is_hierarchy, is_blocking, is_symmetric, sort) values
  ('parent_of',  'parent of',  'child of',       true,  false, false, 0),
  ('blocks',     'blocks',     'is blocked by',  false, true,  false, 1),
  ('duplicates', 'duplicates', 'is duplicated by', false, false, true, 2),
  ('relates_to', 'relates to', 'relates to',     false, false, true,  3),
  ('links_to',   'links to',   'linked from',    false, false, false, 4); -- external entities

-- Edge: from_item -(type)-> to_item | external entity.
-- External entities (GitHub PR, Slack thread, email, document, Linear issue,
-- a row in another system) live in the same table with to_item_id = null and
-- external_kind/external_ref set, so "everything connected to this item" is
-- one query.
create table relations (
  id            uuid primary key default gen_random_uuid(),
  type          text not null references relation_types(key),
  from_item_id  uuid not null references work_items(id) on delete cascade,
  to_item_id    uuid references work_items(id) on delete cascade,
  external_kind text,                                   -- github_pr | github_issue | slack_thread | email | url | doc | ...
  external_ref  jsonb,                                  -- {"url":..., "repo":..., "number":..., "title":...}
  external_key  text generated always as (
                  case when external_kind is not null then external_kind || ':' || coalesce(external_ref->>'id', external_ref->>'url', '') end
                ) stored,
  meta          jsonb not null default '{}'::jsonb,
  created_by    uuid references users(id),
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check ((to_item_id is not null and external_kind is null and external_ref is null)
      or (to_item_id is null and external_kind is not null and external_ref is not null)),
  check (to_item_id is null or to_item_id <> from_item_id)
);
create unique index relations_item_edge_uq on relations(type, from_item_id, to_item_id) where to_item_id is not null and deleted_at is null;
create unique index relations_external_edge_uq on relations(type, from_item_id, external_key) where external_key is not null and deleted_at is null;
create index relations_from_idx on relations(from_item_id) where deleted_at is null;
create index relations_to_idx on relations(to_item_id) where deleted_at is null;
create index relations_external_idx on relations(external_kind, (external_ref->>'url')) where deleted_at is null;
-- single parent in the hierarchy
create unique index relations_single_parent_uq on relations(to_item_id) where type = 'parent_of' and deleted_at is null;
select install_sync_trigger('relations');

-- Prevent cycles in hierarchy and blocking graphs.
create or replace function trg_relations_no_cycle() returns trigger
language plpgsql as $$
declare rt relation_types%rowtype; found boolean;
begin
  if new.to_item_id is null or new.deleted_at is not null then return new; end if;
  select * into rt from relation_types where key = new.type;
  if not (rt.is_hierarchy or rt.is_blocking) then return new; end if;
  -- is there already a path to_item -> ... -> from_item of the same type?
  with recursive walk(item_id, depth) as (
    select new.to_item_id, 0
    union all
    select r.to_item_id, w.depth + 1
    from relations r join walk w on r.from_item_id = w.item_id
    where r.type = new.type and r.deleted_at is null and w.depth < 1000
  )
  select exists(select 1 from walk where item_id = new.from_item_id) into found;
  if found then
    raise exception 'relation % from % to % would create a cycle', new.type, new.from_item_id, new.to_item_id using errcode = '23514';
  end if;
  return new;
end $$;
create trigger relations_no_cycle before insert or update on relations
  for each row execute function trg_relations_no_cycle();

-- Graph helpers (used by API + rollups) ------------------------------------
-- All descendants of an item through parent_of
create or replace function item_descendants(root uuid) returns table(item_id uuid, depth int)
language sql stable as $$
  with recursive d(item_id, depth) as (
    select r.to_item_id, 1 from relations r where r.from_item_id = root and r.type = 'parent_of' and r.deleted_at is null
    union all
    select r.to_item_id, d.depth + 1 from relations r join d on r.from_item_id = d.item_id
    where r.type = 'parent_of' and r.deleted_at is null and d.depth < 100
  ) select * from d
$$;

-- Ancestors chain (parent, grandparent, ...)
create or replace function item_ancestors(leaf uuid) returns table(item_id uuid, depth int)
language sql stable as $$
  with recursive a(item_id, depth) as (
    select r.from_item_id, 1 from relations r where r.to_item_id = leaf and r.type = 'parent_of' and r.deleted_at is null
    union all
    select r.from_item_id, a.depth + 1 from relations r join a on r.to_item_id = a.item_id
    where r.type = 'parent_of' and r.deleted_at is null and a.depth < 100
  ) select * from a
$$;

-- Open blockers: items that block `item` (directly) and are not done/canceled
create or replace function item_open_blockers(item uuid) returns setof uuid
language sql stable as $$
  select r.from_item_id
  from relations r
  join work_items b on b.id = r.from_item_id and b.deleted_at is null
  join workflow_states s on s.id = b.state_id
  where r.to_item_id = item and r.type = 'blocks' and r.deleted_at is null
    and s.category not in ('done', 'canceled')
$$;

-- Rollup over a subtree: counts by category + estimate sums
create or replace function item_rollup(root uuid)
returns table(total int, done int, in_progress int, todo int, canceled int, estimate_total numeric, estimate_done numeric)
language sql stable as $$
  select count(*)::int,
         count(*) filter (where s.category = 'done')::int,
         count(*) filter (where s.category = 'in_progress')::int,
         count(*) filter (where s.category in ('todo','backlog'))::int,
         count(*) filter (where s.category = 'canceled')::int,
         coalesce(sum(w.estimate), 0),
         coalesce(sum(w.estimate) filter (where s.category = 'done'), 0)
  from item_descendants(root) d
  join work_items w on w.id = d.item_id and w.deleted_at is null
  join workflow_states s on s.id = w.state_id
$$;

-- ----------------------------------------------------------------------------
-- 7. Activity log: append-only, one event per field change
-- ----------------------------------------------------------------------------
create type actor_kind as enum ('user', 'api_key', 'integration', 'system', 'agent');

create table activity_events (
  id            bigint generated always as identity primary key,  -- monotonic cursor
  txn_id        uuid not null,                     -- groups events from one mutation (undo unit)
  entity_type   text not null,                     -- work_item | comment | relation | project | view | label | ...
  entity_id     uuid not null,
  item_id       uuid,                              -- denormalized: the work item this touches (for timelines)
  project_id    uuid,                              -- denormalized: for scoping/permissions
  actor_kind    actor_kind not null default 'user',
  actor_id      uuid,                              -- users.id (also for api_key/agent: the owning user)
  actor_label   text,                              -- "github", "slack", api key name, agent name
  action        text not null,                     -- create | update | delete | restore | transition | relation_add | relation_remove | comment | ...
  field         text,                              -- "title", "state_id", "fields.severity", null for create/delete
  old_value     jsonb,
  new_value     jsonb,
  mutation_name text,                              -- client mutator / API op that produced it
  source        text not null default 'app',       -- app | api | mcp | slack | email | github | system
  created_at    timestamptz not null default now()
);
create index activity_item_idx on activity_events(item_id, id) where item_id is not null;
create index activity_project_idx on activity_events(project_id, id);
create index activity_entity_idx on activity_events(entity_type, entity_id, id);
create index activity_actor_idx on activity_events(actor_id, id);
create index activity_txn_idx on activity_events(txn_id);
create index activity_created_idx on activity_events(created_at);

-- Physically block mutation of history.
create or replace function trg_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'activity_events is append-only (% denied)', tg_op using errcode = '42501';
end $$;
create trigger activity_events_append_only before update or delete on activity_events
  for each row execute function trg_append_only();
-- Also block TRUNCATE
create trigger activity_events_no_truncate before truncate on activity_events
  for each statement execute function trg_append_only();

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
create type view_kind as enum ('list', 'board', 'timeline', 'dashboard');

create table views (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references projects(id) on delete cascade,  -- null = cross-project
  owner_id      uuid references users(id),                        -- null = system/shared default
  name          text not null,
  kind          view_kind not null default 'list',
  spec          jsonb not null default '{}'::jsonb check (jsonb_typeof(spec) = 'object'),
  is_shared     boolean not null default false,                   -- visible to all project members
  is_default    boolean not null default false,
  icon          text,
  sort          integer not null default 0,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index views_project_idx on views(project_id) where deleted_at is null;
create index views_owner_idx on views(owner_id) where deleted_at is null;
select install_sync_trigger('views');

-- ----------------------------------------------------------------------------
-- 9. Watchers + notifications (low-noise by construction)
-- ----------------------------------------------------------------------------
create type watch_reason as enum ('assignee', 'reporter', 'mention', 'commenter', 'manual');

create table item_watchers (
  item_id       uuid not null references work_items(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  reason        watch_reason not null,
  muted         boolean not null default false,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (item_id, user_id)
);
select install_sync_trigger('item_watchers');

create type notify_channel as enum ('in_app', 'email', 'slack');
create type notify_cadence as enum ('immediate', 'hourly', 'daily', 'off');

-- One row per (user, channel). `rules` selects which event kinds are worth a
-- ping: default = mentions + assignments + replies + state changes on items you
-- are assigned to. Everything else only appears in the activity feed.
create table notification_preferences (
  user_id       uuid not null references users(id) on delete cascade,
  channel       notify_channel not null,
  cadence       notify_cadence not null default 'immediate',
  rules         jsonb not null default '{"mention":true,"assigned":true,"reply":true,"state_change_assigned":true,"state_change_watching":false,"comment_watching":false,"due_soon":true}'::jsonb,
  quiet_hours   jsonb,                       -- {"start":"19:00","end":"07:00","tz":"America/New_York"}
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (user_id, channel)
);
select install_sync_trigger('notification_preferences');

create table notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  item_id       uuid references work_items(id) on delete cascade,
  event_id      bigint references activity_events(id),
  kind          text not null,                -- mention | assigned | reply | state_change | due_soon | ...
  title         text not null,
  body          text,
  actor_id      uuid references users(id),
  read_at       timestamptz,
  archived_at   timestamptz,
  version       bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index notifications_user_unread_idx on notifications(user_id, created_at desc) where read_at is null and deleted_at is null;
select install_sync_trigger('notifications');

-- Outbound deliveries (email/slack) are collapsed per (user, item, window)
create table notification_deliveries (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references users(id) on delete cascade,
  channel       notify_channel not null,
  notification_ids uuid[] not null,
  scheduled_for timestamptz not null,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index notification_deliveries_pending_idx on notification_deliveries(scheduled_for) where sent_at is null;

-- ----------------------------------------------------------------------------
-- 10. Integrations: webhooks out, inbound links
-- ----------------------------------------------------------------------------
create table webhook_endpoints (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  url           text not null,
  secret        text not null,                   -- HMAC-SHA256 of body in X-PM-Signature
  event_kinds   text[] not null default '{*}',   -- e.g. {item.created,item.updated,item.transitioned,comment.created}
  project_id    uuid references projects(id) on delete cascade,  -- null = all projects
  is_active     boolean not null default true,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table webhook_deliveries (
  id            bigint generated always as identity primary key,
  endpoint_id   uuid not null references webhook_endpoints(id) on delete cascade,
  event_id      bigint not null references activity_events(id),
  event_kind    text not null,
  payload       jsonb not null,
  status        text not null default 'pending',     -- pending | delivered | failed | dead
  attempts      integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  response_status integer,
  response_body text,
  created_at    timestamptz not null default now()
);
create index webhook_deliveries_pending_idx on webhook_deliveries(next_attempt_at) where status in ('pending','failed');

-- Integration configs: one row per kind, config validated by the integration
--   slack : {"team_id":..., "channel_map": {"RATES":"C0123"}, "notify_on": [...]}
--   github: {"repos": ["org/repo"], "autolink": true}
--   email : {"inbound_domain": "pm.example.com"}
create table integration_configs (
  kind          text primary key,                 -- slack | github | email
  config        jsonb not null default '{}'::jsonb,
  is_active     boolean not null default false,
  updated_by    uuid references users(id),
  updated_at    timestamptz not null default now()
);

-- Idempotency for inbound events (Slack retries, GitHub redeliveries, email dupes)
create table inbound_events (
  source        text not null,
  external_id   text not null,
  received_at   timestamptz not null default now(),
  primary key (source, external_id)
);

-- ----------------------------------------------------------------------------
-- 11. Sync bookkeeping (Replicache-style push/pull)
-- ----------------------------------------------------------------------------
create table sync_client_groups (
  id            text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  resync_required boolean not null default false,  -- set when the user's visibility changes
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create table sync_clients (
  id              text primary key,
  client_group_id text not null references sync_client_groups(id) on delete cascade,
  last_mutation_id integer not null default 0,
  version         bigint not null default 0,      -- version at which last_mutation_id changed
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);
create index sync_clients_group_idx on sync_clients(client_group_id);

-- ----------------------------------------------------------------------------
-- 12. Permissions: one function, used by API + sync pull + RLS-ready
-- ----------------------------------------------------------------------------
-- Effective project role for a user (null = no access).
create or replace function effective_project_role(p_user uuid, p_project uuid) returns project_role
language sql stable as $$
  select coalesce(
    (select pm.role from project_members pm where pm.user_id = p_user and pm.project_id = p_project and pm.deleted_at is null),
    (select case
              when u.firm_role in ('owner','admin') then 'admin'::project_role
              when u.firm_role = 'member' and p.visibility = 'firm' then 'editor'::project_role
              else null end
     from users u, projects p where u.id = p_user and p.id = p_project and u.deleted_at is null and p.deleted_at is null)
  )
$$;

-- Can the user see this item? (membership/visibility + confidential flag)
create or replace function can_view_item(p_user uuid, p_item uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from work_items w
    where w.id = p_item and w.deleted_at is null
      and effective_project_role(p_user, w.project_id) is not null
      and (not w.confidential
           or w.assignee_id = p_user or w.reporter_id = p_user or w.created_by = p_user
           or effective_project_role(p_user, w.project_id) = 'admin')
  )
$$;

-- Projects visible to a user (drives sync pull scope)
create or replace function visible_project_ids(p_user uuid) returns setof uuid
language sql stable as $$
  select p.id from projects p
  where p.deleted_at is null and effective_project_role(p_user, p.id) is not null
$$;

-- ----------------------------------------------------------------------------
-- 13. Firm-level settings
-- ----------------------------------------------------------------------------
create table settings (
  key           text primary key,
  value         jsonb not null,
  updated_at    timestamptz not null default now()
);
insert into settings(key, value) values
  ('firm', '{"name":"The Firm","item_key_prefix_style":"project"}'),
  ('sync', '{"strategy":"global_version","advisory_lock_id":42}');

-- ----------------------------------------------------------------------------
-- 14. Default workflow + item types (so the schema is usable immediately)
-- ----------------------------------------------------------------------------
do $$
declare wf uuid; s_backlog uuid; s_todo uuid; s_prog uuid; s_review uuid; s_done uuid; s_cancel uuid;
        wf_simple uuid; ss_todo uuid; ss_prog uuid; ss_done uuid; ss_cancel uuid;
begin
  -- Standard engineering/ops workflow
  insert into workflows(key, name, description) values ('standard', 'Standard', 'Backlog → Todo → In Progress → In Review → Done') returning id into wf;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf, 'backlog', 'Backlog', 'backlog', '#9ca3af', 0, false) returning id into s_backlog;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf, 'todo', 'Todo', 'todo', '#60a5fa', 1, true) returning id into s_todo;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf, 'in_progress', 'In Progress', 'in_progress', '#f59e0b', 2, false) returning id into s_prog;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf, 'in_review', 'In Review', 'in_progress', '#a78bfa', 3, false) returning id into s_review;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf, 'done', 'Done', 'done', '#10b981', 4, false) returning id into s_done;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf, 'canceled', 'Canceled', 'canceled', '#6b7280', 5, false) returning id into s_cancel;

  insert into workflow_transitions(workflow_id, key, name, from_state_id, to_state_id, guards, effects, sort) values
    (wf, 'triage',   'Triage',        s_backlog, s_todo,   '[]', '[]', 0),
    (wf, 'start',    'Start',         null,      s_prog,   '[{"type":"require_field","field":"assignee_id"},{"type":"no_open_blockers"}]',
                                                           '[{"type":"set_field","field":"start_date","value":"$today","only_if_null":true}]', 1),
    (wf, 'review',   'Send to review', s_prog,   s_review, '[]', '[{"type":"notify","audience":["watchers"],"template":"review_requested"}]', 2),
    (wf, 'reopen',   'Reopen',        s_review,  s_prog,   '[]', '[]', 3),
    (wf, 'complete', 'Complete',      null,      s_done,   '[{"type":"children_in_category","categories":["done","canceled"]}]',
                                                           '[{"type":"set_field","field":"completed_at","value":"$now"},{"type":"webhook","event":"item.completed"}]', 4),
    (wf, 'cancel',   'Cancel',        null,      s_cancel, '[{"type":"require_role","roles":["admin","editor"]}]',
                                                           '[{"type":"set_field","field":"canceled_at","value":"$now"}]', 5),
    (wf, 'restore',  'Restore',       s_cancel,  s_todo,   '[]', '[{"type":"set_field","field":"canceled_at","value":null}]', 6),
    (wf, 'backlog',  'Back to backlog', null,    s_backlog,'[]', '[{"type":"set_field","field":"completed_at","value":null}]', 7);

  -- Simple 3-state workflow for lightweight types
  insert into workflows(key, name, description) values ('simple', 'Simple', 'Todo → Doing → Done') returning id into wf_simple;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf_simple, 'todo', 'Todo', 'todo', '#60a5fa', 0, true) returning id into ss_todo;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf_simple, 'doing', 'Doing', 'in_progress', '#f59e0b', 1, false) returning id into ss_prog;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf_simple, 'done', 'Done', 'done', '#10b981', 2, false) returning id into ss_done;
  insert into workflow_states(workflow_id, key, name, category, color, sort, is_initial) values
    (wf_simple, 'canceled', 'Canceled', 'canceled', '#6b7280', 3, false) returning id into ss_cancel;
  insert into workflow_transitions(workflow_id, key, name, from_state_id, to_state_id, guards, effects, sort) values
    (wf_simple, 'start',    'Start',    null, ss_prog,   '[]', '[]', 0),
    (wf_simple, 'complete', 'Complete', null, ss_done,   '[]', '[{"type":"set_field","field":"completed_at","value":"$now"}]', 1),
    (wf_simple, 'cancel',   'Cancel',   null, ss_cancel, '[]', '[{"type":"set_field","field":"canceled_at","value":"$now"}]', 2),
    (wf_simple, 'reopen',   'Reopen',   null, ss_todo,   '[]', '[{"type":"set_field","field":"completed_at","value":null},{"type":"set_field","field":"canceled_at","value":null}]', 3);

  insert into item_types(key, name, plural_name, icon, color, workflow_id, is_container, sort, field_defs) values
    ('task', 'Task', 'Tasks', 'check-square', '#60a5fa', wf, false, 0, '[]'),
    ('bug',  'Bug',  'Bugs',  'bug', '#ef4444', wf, false, 1,
      '[{"key":"severity","label":"Severity","kind":"select","required":true,
         "options":[{"value":"s1","label":"S1 – Critical"},{"value":"s2","label":"S2 – High"},{"value":"s3","label":"S3 – Medium"},{"value":"s4","label":"S4 – Low"}]},
        {"key":"environment","label":"Environment","kind":"select",
         "options":[{"value":"prod","label":"Production"},{"value":"uat","label":"UAT"},{"value":"dev","label":"Dev"}]},
        {"key":"steps","label":"Steps to reproduce","kind":"long_text"}]'),
    ('initiative', 'Initiative', 'Initiatives', 'flag', '#a78bfa', wf, true, 2,
      '[{"key":"owner_desk","label":"Owning desk","kind":"text"},
        {"key":"business_case","label":"Business case","kind":"long_text"},
        {"key":"budget","label":"Budget (USD)","kind":"number"},
        {"key":"quarter","label":"Target quarter","kind":"select",
         "options":[{"value":"2026Q4","label":"2026 Q4"},{"value":"2027Q1","label":"2027 Q1"},{"value":"2027Q2","label":"2027 Q2"}]}]'),
    ('request', 'Request', 'Requests', 'inbox', '#f59e0b', wf_simple, false, 3,
      '[{"key":"requester_desk","label":"Requesting desk","kind":"text"},
        {"key":"urgency","label":"Urgency","kind":"select",
         "options":[{"value":"today","label":"Today"},{"value":"this_week","label":"This week"},{"value":"whenever","label":"Whenever"}]},
        {"key":"approved","label":"Approved","kind":"bool"}]');
end $$;

-- ----------------------------------------------------------------------------
-- 15. Convenience view: items with resolved display columns
-- ----------------------------------------------------------------------------
create or replace view work_items_v as
select w.*,
       t.key  as type_key, t.name as type_name,
       s.key  as state_key, s.name as state_name, s.category as state_category,
       p.key  as project_key, p.name as project_name,
       a.name as assignee_name,
       (select array_agg(l.name order by l.name) from work_item_labels wl join labels l on l.id = wl.label_id where wl.item_id = w.id and wl.deleted_at is null) as label_names,
       (select r.from_item_id from relations r where r.to_item_id = w.id and r.type = 'parent_of' and r.deleted_at is null) as parent_id,
       exists(select 1 from item_open_blockers(w.id)) as is_blocked
from work_items w
join item_types t on t.id = w.type_id
join workflow_states s on s.id = w.state_id
join projects p on p.id = w.project_id
left join users a on a.id = w.assignee_id;
