# API

REST API v1 served by `@pm/api` (Fastify 5) on `:3001` in development. Every write route maps to exactly one mutation from `packages/core/src/mutations.ts` and goes through `applyMutation`; every read uses the same visibility functions as sync. Routes are the ones in [docs/ARCHITECTURE.md](https://github.com/jamjorf/pm-tool/blob/main/docs/ARCHITECTURE.md#http-api-v1-served-by-pmapi); worked examples are in [docs/04-integrations.md §1](https://github.com/jamjorf/pm-tool/blob/main/docs/04-integrations.md#1-api-usage).

## Authentication

| Credential | How | For |
|---|---|---|
| Session cookie `pm_session` | set by `GET /auth/callback?token=` (magic link) or `POST /auth/dev-login` when `AUTH_MODE=dev`; httpOnly, signed with `APP_SECRET`, backed by a `sessions` row | the SPA |
| API key | `Authorization: Bearer pm_<key>`; created with `POST /me/api-keys` (shown once, stored as sha256 in `api_keys.key_hash`); scopes default to `read,write`; optional `expires_at`; revoke with `DELETE /me/api-keys/:id` | scripts, MCP, other systems |

Every call runs as the user who owns the credential: same visibility, same project roles. API-key actions are logged with `actor_kind = 'api_key'` and the key's name as `actor_label`. CORS allows `APP_URL`, `API_URL` and localhost origins with credentials; API keys do not need CORS. Rate limits are per credential ([docs/05-operations.md §3](https://github.com/jamjorf/pm-tool/blob/main/docs/05-operations.md#3-security)).

```bash
API=http://localhost:3001

# dev login (AUTH_MODE=dev only; the first user ever created becomes firm owner)
curl -s -c cookies.txt -X POST $API/auth/dev-login -H 'content-type: application/json' \
  -d '{"email":"alice@firm.com","name":"Alice"}'

# magic link (in dev the link is logged and also returned in the response)
curl -s -X POST $API/auth/magic-link -H 'content-type: application/json' -d '{"email":"alice@firm.com"}'

# create an API key and keep it
curl -s -b cookies.txt -X POST $API/me/api-keys -H 'content-type: application/json' \
  -d '{"name":"alice-cli","scopes":["read","write"]}'
export PM_API_KEY=pm_…
H=(-H "authorization: Bearer $PM_API_KEY" -H 'content-type: application/json')
```

### `X-PM-Source`

Clients may send `X-PM-Source: app | api | mcp` to label the channel in the activity log (`activity_events.source`). The default is `api` for API keys and `app` for sessions. `mcp` also sets `actor_kind = 'agent'`, which is how the MCP server marks agent writes. Other values are ignored.

## Errors

One envelope for every error:

```json
{ "error": { "code": "guard_failed", "message": "…", "details": { "failures": [ { "guard": { "type": "require_field", "field": "assignee_id" }, "reason": "…" } ] } } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation` | zod or field validation failed (for example a `bug` without `fields.severity`), bad cursor |
| 401 | `unauthorized` | no or invalid credential |
| 403 | `forbidden` | `permissions.assert` failed, dev-login disabled, non-admin on an admin route |
| 404 | `not_found` | unknown route, item, project, view, or a transition key that is not in the item's workflow |
| 409 | `conflict` | uniqueness or state conflict |
| 409 | `guard_failed` | a workflow guard blocked the transition; `details.failures` lists each guard and reason |
| 500 | `internal` | unexpected |

## Route catalog

Item routes accept the item key (`RATES-12`) or UUID; project routes accept the project key or UUID. Responses are snake_case rows exactly as in SQL.

### Auth, account, sync

```
GET  /health
POST /auth/dev-login            {email, name?}       AUTH_MODE=dev only
POST /auth/magic-link           {email}              sends the link (dev: logs it)
GET  /auth/callback?token=      sets the cookie, 302 to APP_URL
POST /auth/logout
GET  /me                        → {user, memberships:[{project_id, role}], preferences:[...]}
PATCH /me                       {name?, avatar_url?, settings?}
POST /me/api-keys               {name, scopes?, expires_at?} → {id, key, ...}   (key shown once)
GET  /me/api-keys ; DELETE /me/api-keys/:id

POST /sync/push | POST /sync/pull | GET /sync/poke (SSE)      see the Sync page
```

### Projects

```
GET    /api/v1/projects                       ?include_archived
POST   /api/v1/projects                       createProject args (id optional)
GET    /api/v1/projects/:key                  → project + members + item counts by category + views
PATCH  /api/v1/projects/:key                  updateProject.patch
GET    /api/v1/projects/:key/members
PUT    /api/v1/projects/:key/members/:userId  {role}
DELETE /api/v1/projects/:key/members/:userId
```

### Items

```
GET    /api/v1/items                          ?project=KEY&type=task&state_category=todo,in_progress&assignee=me|<uuid>&label=name&q=text&updated_since=ISO&limit=50&cursor=
POST   /api/v1/items/query                    {spec: QuerySpec} → {items, groups?, total}
POST   /api/v1/items                          createItem args (id optional; project as project_key; type as type_key; labels as names; parent as key)
GET    /api/v1/items/:key                     → {item, labels, relations:[{...relation, other_item}], parent, children, rollup, available_transitions:[{key,name,to_state,allowed,failures}], watchers}
PATCH  /api/v1/items/:key                     ItemPatch
DELETE /api/v1/items/:key                     soft delete
POST   /api/v1/items/:key/restore
POST   /api/v1/items/:key/transitions/:transitionKey   {comment?} → 200 item | 409 guard_failed
GET    /api/v1/items/:key/transitions         available transitions with guard evaluation
GET    /api/v1/items/:key/activity            ?before=<event id>&limit
GET    /api/v1/items/:key/comments
POST   /api/v1/items/:key/comments            {body, parent_id?}
PATCH  /api/v1/comments/:id ; DELETE /api/v1/comments/:id
GET    /api/v1/items/:key/relations
POST   /api/v1/items/:key/relations           {type, to_item?: key|uuid, external_kind?, external_ref?}
DELETE /api/v1/relations/:id
PUT    /api/v1/items/:key/parent              {parent: key|uuid|null}
POST   /api/v1/items/:key/labels              {label: name|uuid} ; DELETE /api/v1/items/:key/labels/:labelId
POST   /api/v1/items/:key/watch ; DELETE /api/v1/items/:key/watch
POST   /api/v1/items/bulk                     {ids|keys, patch} → {items}
POST   /api/v1/items/bulk-transition          {ids|keys, transition_key} → {ok:[], failed:[{id, failures}]}
```

`ItemPatch` fields: `title`, `description`, `type_id`, `priority` (0 to 4), `assignee_id`, `reporter_id`, `start_date`, `due_date`, `estimate`, `fields` (shallow-merged), `confidential`, `sort_order`, `archived_at`. State is never patched; use a transition.

### Search, my work, activity, export

```
GET    /api/v1/search                         ?q=&project=&limit → {items:[{...item, rank, snippet}]}
GET    /api/v1/my-work                        → {assigned, created, watching, due_soon, mentions}
GET    /api/v1/activity                       ?project=&item=&actor=&since=<event id>&limit   (respects visibility)
GET    /api/v1/export/items.csv               ?project=   (respects visibility)
```

### Vocabulary, views, notifications, admin

```
GET    /api/v1/types ; PUT /api/v1/types/:key                       (firm admin, upsertItemType)
GET    /api/v1/workflows ; GET /api/v1/workflows/:key ; PUT /api/v1/workflows/:key   (firm admin, upsertWorkflow)
GET    /api/v1/labels ?project= ; POST /api/v1/labels
GET    /api/v1/users ; PATCH /api/v1/users/:id                      (firm admin: firm_role, is_active)
GET    /api/v1/views ?project= ; POST /api/v1/views ; PATCH /api/v1/views/:id ; DELETE /api/v1/views/:id
POST   /api/v1/views/:id/run                  same shape as items/query; dashboards → {widgets:[{id, rows:[{key,label,value}]}]}
GET    /api/v1/notifications ?unread=1 ; POST /api/v1/notifications/:id/read ; POST /api/v1/notifications/read-all
GET    /api/v1/notification-preferences ; PUT /api/v1/notification-preferences/:channel
GET    /api/v1/webhooks ; POST /api/v1/webhooks {name,url,event_kinds,project?} ; PATCH/DELETE /api/v1/webhooks/:id
GET    /api/v1/webhooks/:id/deliveries ; POST /api/v1/webhooks/:id/test
GET    /api/v1/integrations ; PUT /api/v1/integrations/:kind {config, is_active}
```

### Inbound integrations

```
POST   /integrations/slack/events | /integrations/slack/commands | /integrations/slack/interactions
POST   /integrations/github/webhook
POST   /integrations/email/inbound
```

Payloads and setup are in [[Integrations]].

## Response shapes

| Route | Returns |
|---|---|
| `GET /api/v1/items` | `{items, next_cursor}`; pass `cursor` back to page |
| `POST /api/v1/items/query` | `{items, groups?, total}`; `groups` present when `group_by` is set |
| `POST /api/v1/items` | 201 with the same shape as `GET /api/v1/items/:key` |
| `POST /api/v1/items/bulk-transition` | `{ok:[ids], failed:[{id, failures:[{guard, reason}]}]}` |
| `GET /api/v1/activity` | activity rows in `id` order; page with `since=<last id>` |
| `POST /api/v1/webhooks` | the endpoint row including `secret` (store it on the receiver) |

Design principles (routes are mutations, keys or UUIDs, one error shape, reads are specs, visibility everywhere, idempotent creates, cursor feeds, snake_case): [docs/02-design.md §10](https://github.com/jamjorf/pm-tool/blob/main/docs/02-design.md#10-api-design-principles).

## Examples

### Create an item

```bash
curl -s "${H[@]}" -X POST $API/api/v1/items -d '{
  "project_key": "RATES",
  "type": "bug",
  "title": "Curve builder returns NaN for 50y tenor",
  "priority": 2,
  "fields": { "severity": "s2", "environment": "uat" }
}'
```

`bug` requires `fields.severity`; omit it and the response is `400 validation`.

### Query with a QuerySpec

```bash
curl -s "${H[@]}" -X POST $API/api/v1/items/query -d '{
  "spec": {
    "filter": { "and": [
      { "field": "project.key", "op": "eq", "value": "RATES" },
      { "field": "state.category", "op": "nin", "value": ["done","canceled"] },
      { "field": "fields.severity", "op": "in", "value": ["s1","s2"] }
    ]},
    "sort": [ { "field": "priority", "dir": "asc" } ],
    "group_by": "assignee_id",
    "limit": 100
  }
}'

# the convenience form builds a spec from query parameters
curl -s "${H[@]}" "$API/api/v1/items?project=RATES&state_category=todo,in_progress&assignee=me&limit=50"
```

### Transition, with a guard failure

```bash
curl -s "${H[@]}" $API/api/v1/items/RATES-12/transitions                 # what is allowed now, and why not
curl -s -i "${H[@]}" -X POST $API/api/v1/items/RATES-12/transitions/start -d '{"comment":"picking this up"}'
```

Without an assignee the second call answers `HTTP/1.1 409 Conflict` with `{"error":{"code":"guard_failed",...,"details":{"failures":[{"guard":{"type":"require_field","field":"assignee_id"},"reason":"…"}]}}}`. Fix and retry:

```bash
curl -s "${H[@]}" -X PATCH $API/api/v1/items/RATES-12 -d '{"assignee_id":"<uuid>","due_date":"2026-10-31"}'
curl -s "${H[@]}" -X POST  $API/api/v1/items/RATES-12/transitions/start -d '{}'
```

### Bulk update and bulk transition

```bash
curl -s "${H[@]}" -X POST $API/api/v1/items/bulk -d '{"keys":["RATES-12","RATES-13","RATES-14"],"patch":{"priority":1}}'
curl -s "${H[@]}" -X POST $API/api/v1/items/bulk-transition -d '{"keys":["RATES-12","RATES-13"],"transition_key":"complete"}'
# → {"ok":["…"],"failed":[{"id":"…","failures":[{"guard":{"type":"children_in_category","categories":["done","canceled"]},"reason":"…"}]}]}
```

### Relations, parent, comment with a mention

```bash
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/relations -d '{"type":"blocks","to_item":"RATES-15"}'
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/relations -d '{"type":"links_to","external_kind":"url","external_ref":{"url":"https://wiki/curves","title":"Curve spec"}}'
curl -s "${H[@]}" -X PUT  $API/api/v1/items/RATES-12/parent -d '{"parent":"RATES-7"}'
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/comments -d '{"body":"@[Bob Okafor](user:<uuid>) can you confirm the tenor grid?"}'
```

### Search, my work, activity, export

```bash
curl -s "${H[@]}" "$API/api/v1/search?q=curve+NaN&project=RATES&limit=20"
curl -s "${H[@]}" $API/api/v1/my-work
curl -s "${H[@]}" "$API/api/v1/activity?project=RATES&since=0&limit=200"
curl -s "${H[@]}" "$API/api/v1/items/RATES-12/activity?limit=50"
curl -s "${H[@]}" "$API/api/v1/export/items.csv?project=RATES" -o rates.csv
```

### Webhooks

```bash
curl -s "${H[@]}" -X POST $API/api/v1/webhooks -d '{
  "name": "risk-system",
  "url": "https://risk.internal/hooks/pm",
  "event_kinds": ["item.transitioned","item.completed","comment.created"],
  "project": "RATES"
}'
# → includes "secret"; then POST /api/v1/webhooks/<id>/test and GET /api/v1/webhooks/<id>/deliveries
```

Payload format, signature verification and retries are in [[Integrations]].
