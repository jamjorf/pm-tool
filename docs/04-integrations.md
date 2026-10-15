# 04 — Integrations

Everything outside the browser talks to the same API and ends up in the same
activity log. This document is the practical guide: API usage, webhooks out,
Slack, GitHub, email, and the MCP server for agents. Routes and payloads are
the ones in [ARCHITECTURE.md](ARCHITECTURE.md); nothing here adds a route.

## 1. API usage

### 1.1 Authentication

| Credential | How | For |
|---|---|---|
| Session cookie `pm_session` | set by `/auth/callback` (magic link) or `POST /auth/dev-login` in `AUTH_MODE=dev`; httpOnly, signed with `APP_SECRET` | the SPA |
| API key | `Authorization: Bearer pm_<key>`; created with `POST /me/api-keys` (shown once; stored as sha256 in `api_keys.key_hash`); scopes default `read,write` | scripts, MCP, other systems |

Every call runs as the user who owns the credential: same visibility, same
project roles. Actions by API keys are logged with `actor_kind = 'api_key'`
and the key's name as `actor_label`.

```bash
API=http://localhost:3001

# dev login (AUTH_MODE=dev only; first user becomes firm owner)
curl -s -c cookies.txt -X POST $API/auth/dev-login -H 'content-type: application/json' \
  -d '{"email":"alice@firm.com","name":"Alice"}'

# create an API key (once) and keep it
curl -s -b cookies.txt -X POST $API/me/api-keys -H 'content-type: application/json' \
  -d '{"name":"alice-cli"}'
# → {"id":"…","key":"pm_…"}
export PM_API_KEY=pm_…
```

### 1.2 Examples

```bash
H=(-H "authorization: Bearer $PM_API_KEY" -H 'content-type: application/json')

# Who am I, what am I in
curl -s "${H[@]}" $API/me

# Create an item (project may be given as project_key; id optional)
curl -s "${H[@]}" -X POST $API/api/v1/items -d '{
  "project_key": "RATES",
  "type_id": "'$(curl -s "${H[@]}" $API/api/v1/types | jq -r '.[] | select(.key=="bug") | .id')'",
  "title": "Curve builder returns NaN for 50y tenor",
  "priority": 2,
  "fields": { "severity": "s2", "environment": "uat" }
}'

# Read it (keys or UUIDs)
curl -s "${H[@]}" $API/api/v1/items/RATES-12

# Query with a QuerySpec (the same spec a saved view uses)
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

# Convenience list
curl -s "${H[@]}" "$API/api/v1/items?project=RATES&state_category=todo,in_progress&assignee=me&limit=50"

# Available transitions with guard evaluation
curl -s "${H[@]}" $API/api/v1/items/RATES-12/transitions

# Transition (409 guard_failed with {failures} when a guard blocks it)
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/transitions/start -d '{"comment":"picking this up"}'

# Patch
curl -s "${H[@]}" -X PATCH $API/api/v1/items/RATES-12 -d '{"assignee_id":"…","due_date":"2026-10-31","fields":{"environment":"prod"}}'

# Relations
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/relations -d '{"type":"blocks","to_item":"RATES-15"}'
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/relations -d '{"type":"links_to","external_kind":"url","external_ref":{"url":"https://wiki/curves","title":"Curve spec"}}'
curl -s "${H[@]}" -X PUT  $API/api/v1/items/RATES-12/parent -d '{"parent":"RATES-7"}'

# Comment with a mention
curl -s "${H[@]}" -X POST $API/api/v1/items/RATES-12/comments -d '{"body":"@[Bob](user:…) can you confirm the tenor grid?"}'

# Bulk edit / bulk transition
curl -s "${H[@]}" -X POST $API/api/v1/items/bulk -d '{"keys":["RATES-12","RATES-13","RATES-14"],"patch":{"priority":1}}'
curl -s "${H[@]}" -X POST $API/api/v1/items/bulk-transition -d '{"keys":["RATES-12","RATES-13"],"transition_key":"complete"}'
# → {"ok":["…"],"failed":[{"id":"…","failures":[{"guard":{"type":"children_in_category",…},"reason":"…"}]}]}

# Search (FTS, trigram fallback)
curl -s "${H[@]}" "$API/api/v1/search?q=curve+NaN&project=RATES&limit=20"

# My work (what the MCP server and the palette use)
curl -s "${H[@]}" $API/api/v1/my-work

# Activity feed by cursor
curl -s "${H[@]}" "$API/api/v1/activity?project=RATES&since=0&limit=200"
curl -s "${H[@]}" "$API/api/v1/items/RATES-12/activity?limit=50"

# Export (respects visibility)
curl -s "${H[@]}" "$API/api/v1/export/items.csv?project=RATES" -o rates.csv
```

Errors are always `{"error":{"code","message","details"?}}`; codes:
`not_found`, `forbidden`, `validation`, `conflict`, `guard_failed`,
`unauthorized`, `internal`.

## 2. Webhooks out

### 2.1 Subscribe

```bash
curl -s "${H[@]}" -X POST $API/api/v1/webhooks -d '{
  "name": "risk-system",
  "url": "https://risk.internal/hooks/pm",
  "event_kinds": ["item.transitioned","item.completed","comment.created"],
  "project": "RATES"
}'
# → includes "secret" (store it on the receiving side)
curl -s "${H[@]}" -X POST $API/api/v1/webhooks/<id>/test        # sends a synthetic delivery
curl -s "${H[@]}" $API/api/v1/webhooks/<id>/deliveries           # status, attempts, response codes
```

`event_kinds: ["*"]` (the default) matches everything; `project` omitted
means all projects. Firm admin only.

### 2.2 Delivery format

Headers: `X-PM-Event`, `X-PM-Delivery`, `X-PM-Signature: sha256=<hex>`,
`content-type: application/json`. Body:

```json
{
  "id": 1234,
  "kind": "item.transitioned",
  "created_at": "2026-10-15T14:02:11.312Z",
  "actor": { "id": "…", "name": "Alice", "kind": "user" },
  "project": { "id": "…", "key": "RATES", "name": "Rates desk" },
  "item": { "id": "…", "key": "RATES-12", "title": "…", "state_key": "in_progress", "state_category": "in_progress", "type_key": "bug", "…": "every work_items_v column" },
  "changes": [ { "field": "state_id", "old": "…", "new": "…" }, { "field": "start_date", "old": null, "new": "2026-10-15" } ],
  "event_ids": [ 9876, 9877 ]
}
```

### 2.3 Verify the signature

The signature is HMAC-SHA256 of the **raw request body bytes** with the
endpoint secret, hex-encoded, prefixed `sha256=`. Compare in constant time.

Node (Fastify/Express with raw body):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyPmSignature(rawBody /* Buffer */, header /* string */, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

// express example
app.post('/hooks/pm', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyPmSignature(req.body, req.get('x-pm-signature'), process.env.PM_WEBHOOK_SECRET)) return res.status(401).end();
  const delivery = req.get('x-pm-delivery');          // idempotency key
  const event = JSON.parse(req.body.toString('utf8'));
  // handle event.kind …
  res.status(204).end();
});
```

Python:

```python
import hmac, hashlib

def verify_pm_signature(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")

# flask
@app.post("/hooks/pm")
def pm_hook():
    if not verify_pm_signature(request.get_data(), request.headers.get("X-PM-Signature"), SECRET):
        abort(401)
    event = request.get_json()
    return "", 204
```

Respond 2xx within a few seconds; do the work asynchronously. Any non-2xx or
timeout schedules a retry.

### 2.4 Event catalogue

| kind | When | `changes` |
|---|---|---|
| `item.created` | `createItem` | initial non-default fields |
| `item.updated` | any field change not from a transition (incl. labels, move) | per field |
| `item.transitioned` | `state_id` changed by a transition | `state_id` + effect fields |
| `item.completed` | the transition's `webhook` effect names it (seeded `complete`) | as above |
| `item.deleted` / `item.restored` | soft delete / restore | — |
| `comment.created` / `comment.updated` / `comment.deleted` | comments | `body` |
| `relation.added` / `relation.removed` | relations incl. parent changes and external links | relation row in `item` context |
| `project.created` / `project.updated` | projects | per field |

Workflow `webhook` effects may emit any string as `event`; subscribe to it by
name or with `*`.

### 2.5 Retry policy

Attempts at +1 m, +5 m, +30 m, +2 h, +12 h after the first failure; then
`status = 'dead'`. `GET /api/v1/webhooks/:id/deliveries` shows every attempt
with `response_status`/`response_body`. Re-sending a dead delivery is an admin
action (implementation detail; the `test` route sends a fresh synthetic event).
Deliveries for one endpoint are sent in `id` order; a slow endpoint delays only
its own queue.

## 3. Slack

### 3.1 What it does

| Feature | Route | Behaviour |
|---|---|---|
| Unfurls | `POST /integrations/slack/events` (`link_shared`) | Pasting an item URL shows key, title, state, assignee, priority |
| Autolink | `POST /integrations/slack/events` (`message`) | A message containing `RATES-12` gets a threaded reply with the item summary; a `links_to` external relation (`slack_thread`) is added to the item |
| Slash command | `POST /integrations/slack/commands` | `/pm create <title>`, `/pm find <text>`, `/pm mine`, `/pm RATES-12` |
| Notifications | delivery worker → `sendSlackMessage` | DM per `notification_preferences` (channel `slack`), with transition buttons |
| Buttons | `POST /integrations/slack/interactions` | Block actions run the transition as the Slack user (resolved via `users.settings.slack_user_id`, falling back to email) |

Channel → project mapping lives in `integration_configs` (`kind = 'slack'`):
`{"team_id":…, "channel_map": {"RATES":"C0123"}, "notify_on": [...]}` so `/pm
create` in `#rates` lands in project `RATES`.

### 3.2 Setup

1. Create a Slack app from the manifest below (replace `API_HOST`, `APP_HOST`).
2. Install to the workspace; copy the **Bot User OAuth Token** to
   `SLACK_BOT_TOKEN` and the **Signing Secret** to `SLACK_SIGNING_SECRET`.
3. `PUT /api/v1/integrations/slack {"config":{"team_id":"T…","channel_map":{"RATES":"C…"}},"is_active":true}`.
4. Users link accounts by having the same email in Slack and pm-tool
   (`resolveUserByEmail`) or by setting `users.settings.slack_user_id`.

```json
{
  "display_information": { "name": "pm-tool", "description": "Work items, workflows and notifications" },
  "features": {
    "bot_user": { "display_name": "pm-tool", "always_online": true },
    "slash_commands": [
      { "command": "/pm", "url": "https://API_HOST/integrations/slack/commands",
        "description": "create | find | mine | KEY-123", "usage_hint": "create Fix the curve builder", "should_escape": false }
    ],
    "unfurl_domains": ["APP_HOST"]
  },
  "oauth_config": {
    "scopes": {
      "bot": ["chat:write", "commands", "links:read", "links:write",
              "channels:history", "groups:history", "im:write", "users:read", "users:read.email"]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://API_HOST/integrations/slack/events",
      "bot_events": ["link_shared", "message.channels", "message.groups"]
    },
    "interactivity": { "is_enabled": true, "request_url": "https://API_HOST/integrations/slack/interactions" },
    "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false
  }
}
```

All three routes verify Slack's `X-Slack-Signature` with
`SLACK_SIGNING_SECRET` and answer the Events API `url_verification`
challenge. Retried Slack events are de-duplicated via `inbound_events`
(`source='slack'`, `external_id = event_id`).

### 3.3 `/pm` commands

| Command | Does |
|---|---|
| `/pm create Fix the 50y tenor` | `createItem` in the channel's mapped project (default type), reporter = the Slack user; replies with the key and link |
| `/pm find curve NaN` | `GET /api/v1/search` as the user; top 5 with links |
| `/pm mine` | `GET /api/v1/my-work`: assigned + due soon |
| `/pm RATES-12` | item card with transition buttons |

Writes made from Slack are logged with `source='slack'`,
`actor_kind='user'` when the Slack user resolves, otherwise the `slack`
service actor with `actor_kind='integration'`.

## 4. GitHub

### 4.1 Setup

Repository or organisation webhook (or a GitHub App with the same events):

* Payload URL: `https://API_HOST/integrations/github/webhook`
* Content type: `application/json`
* Secret: the value of `GITHUB_WEBHOOK_SECRET` (signature `X-Hub-Signature-256` is verified)
* Events: **Pull requests**, **Issues**, **Pushes**
* `GITHUB_TOKEN` (optional) lets the server post back a comment with the item link.
* `PUT /api/v1/integrations/github {"config":{"repos":["firm/curves"],"autolink":true},"is_active":true}`

Redeliveries are de-duplicated via `inbound_events` (`source='github'`,
`external_id = X-GitHub-Delivery`).

### 4.2 Conventions

| Where you write the key | Effect |
|---|---|
| Branch name `rates-12-curve-nan` or `RATES-12/curve-nan` | PR opened from the branch is linked to `RATES-12` (`links_to`, `external_kind='github_pr'`) |
| PR title or body mentions `RATES-12` | same link (keys extracted with `extractItemKeys`) |
| PR body contains `Fixes RATES-12` / `Closes RATES-12` / `Resolves RATES-12` | on merge, runs the `complete` transition on the item as the GitHub user (by noreply email) or the `github` service actor; guard failures become a comment on the item instead |
| Issue title/body mentions a key | `links_to` with `external_kind='github_issue'` |
| Commit messages in a push mention a key | a comment on the item (`source='github'`) listing the commits (implementation detail: one comment per push) |

`external_ref` for a PR: `{"url","repo","number","title","state"}`; the
generated `external_key` (`github_pr:<url>`) makes re-linking idempotent.
PR state changes (`closed`, `merged`) update `external_ref` and emit
`relation.added`/`item.updated` as appropriate.

## 5. Email

### 5.1 Inbound

`POST /integrations/email/inbound` accepts a provider-agnostic JSON body:

```json
{ "from": "bob@firm.com", "to": "pm+RATES-12@pm.example.com", "subject": "Re: [RATES-12] Curve builder",
  "text": "Confirmed, the tenor grid is wrong.", "html": "<p>…</p>", "message_id": "<abc@firm.com>", "in_reply_to": "<xyz@pm.example.com>" }
```

Address scheme (`inboundDomain` from `integration_configs.email.inbound_domain`):

| To | Effect |
|---|---|
| `pm+RATES-12@pm.example.com` | `addComment` on RATES-12, `source='email'`, `external_ref={"message_id":…}`; author = user resolved by `from` email, else the `email` service actor with the sender quoted in the body |
| `pm+RATES@pm.example.com` | `createItem` in project RATES (default type), title = subject, description = text; reporter = resolved user |
| reply to a notification email | the notification's `Reply-To` is `pm+<KEY>@…`, so replies thread back as comments |

Duplicates are dropped via `inbound_events` (`source='email'`,
`external_id = message_id`). Unknown senders are refused unless the email
config allows them (`{"allow_unknown_senders": false}` — implementation
detail of the config JSON).

Provider mapping — a small adapter (a serverless function or the provider's
template) converts the provider payload to the JSON above:

| Provider | Mechanism | Field mapping |
|---|---|---|
| Postmark Inbound | webhook JSON | `FromFull.Email→from`, `ToFull[0].Email→to`, `Subject`, `TextBody→text`, `HtmlBody→html`, `MessageID→message_id`, header `In-Reply-To→in_reply_to` |
| SendGrid Inbound Parse | multipart form | `from`, `to`, `subject`, `text`, `html`, headers → `Message-ID`, `In-Reply-To` |
| Mailgun Routes | form | `sender→from`, `recipient→to`, `subject`, `body-plain→text`, `body-html→html`, `Message-Id→message_id`, `In-Reply-To` |
| SES + Lambda | S3 MIME → parse | map from the parsed MIME headers |

Protect the inbound route with a shared secret in the URL or a header
(implementation detail; recommended `?token=` validated against the email
integration config).

### 5.2 Outbound

`SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`) and `EMAIL_FROM`.
If `SMTP_URL` is unset, emails are logged instead of sent (dev). Rendering
uses `renderNotification` / `renderDigest` from `@pm/integrations` (subject,
text, html). Every email links to the item (`APP_URL`), sets `Reply-To` to the
item's inbound address, and respects the user's `email` cadence and quiet
hours.

## 6. MCP server

`packages/mcp` exposes pm-tool to agents over the Model Context Protocol. It
is a client of the REST API (`API_URL`, `PM_API_KEY`); it has no database
access and cannot exceed the key owner's permissions.

### 6.1 Setup

Create a key as the user the agent should act as (`POST /me/api-keys
{"name":"claude-code"}`), then:

**Claude Code**

```bash
claude mcp add pm-tool -e API_URL=https://pm.example.com -e PM_API_KEY=pm_… -- node /path/to/pm-tool/packages/mcp/dist/server.js
# or from the monorepo: pnpm --filter @pm/mcp build && claude mcp add pm-tool -e … -- pnpm --filter @pm/mcp start
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pm-tool": {
      "command": "node",
      "args": ["/path/to/pm-tool/packages/mcp/dist/server.js"],
      "env": { "API_URL": "https://pm.example.com", "PM_API_KEY": "pm_…", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

**Hosted / remote agents**: `MCP_TRANSPORT=http` starts a Streamable HTTP
endpoint (port and auth header are implementation details of `@pm/mcp`); put
it behind the same reverse proxy as the API.

### 6.2 Tool catalogue

Tool names are an implementation detail of `@pm/mcp`; the recommended
catalogue maps 1:1 onto routes so the agent can do everything a user can:

| Tool | Route | Notes |
|---|---|---|
| `my_work` | `GET /api/v1/my-work` | assigned, created, watching, due soon, mentions |
| `list_projects` / `get_project` | `GET /api/v1/projects`, `/projects/:key` | counts by category, views |
| `search_items` | `POST /api/v1/items/query` (spec) and `GET /api/v1/search` (q) | accepts a `QuerySpec` or free text |
| `get_item` | `GET /api/v1/items/:key` | item, relations, children, rollup, available transitions with guard results |
| `create_item` | `POST /api/v1/items` | validates `fields` against the type |
| `update_item` | `PATCH /api/v1/items/:key` | `ItemPatch` |
| `transition_item` | `POST /api/v1/items/:key/transitions/:transitionKey` | returns guard failures instead of erroring, so the agent can fix and retry |
| `bulk_update` / `bulk_transition` | `/items/bulk`, `/items/bulk-transition` | ≤ 500 ids |
| `add_comment` | `POST /api/v1/items/:key/comments` | mentions as `@[Name](user:<uuid>)` |
| `add_relation` / `set_parent` | `/items/:key/relations`, `/items/:key/parent` | incl. external links |
| `list_types` / `list_workflows` | `GET /api/v1/types`, `/workflows` | so the agent knows fields, states and transition keys |
| `item_activity` | `GET /api/v1/items/:key/activity` | history for reasoning about what happened |
| `run_view` | `POST /api/v1/views/:id/run` | reuse a saved view or dashboard |
| `export_items` | `GET /api/v1/export/items.csv` | CSV |

Resources (optional): `pm://projects/{key}` and `pm://items/{key}` as readable
documents. Every tool's description includes the error shape and the guard
vocabulary so the model can explain failures.

### 6.3 Example agent workflows

**"Triage my project"**

1. `list_types` → learn `bug` requires `fields.severity`.
2. `search_items {spec: {filter: {and: [{field:'project.key',op:'eq',value:'RATES'},{field:'state.key',op:'eq',value:'backlog'}]}}}`.
3. For each item: read title/description, propose priority and severity,
   `update_item` with the patch, `transition_item triage` to move it to Todo.
4. Items that look like duplicates: `add_relation {type:'duplicates'}` and a
   comment explaining why.
5. Summarise in a comment on the initiative.

**"What's blocking the Q4 initiatives?"** — `search_items` for initiatives
with `fields.quarter = 2026Q4`, then `get_item` for each (children + rollup +
`is_blocked`), then `item_activity` on the blockers to see who last touched
them; produce a report with keys and links.

**"Stand-up notes"** — `my_work` for each team member (keys scoped per user)
or `run_view` on the shared "This week" view, grouped by assignee.

Every write the agent performs is a normal mutation: guards apply, the
activity log records `actor_kind='agent'`, `source='mcp'`, `actor_label` = the
key's name, and watchers are notified as if a user had done it — except the
key's owner, who is the actor.

### 6.4 Security notes

* **Scopes.** Create agent keys with `scopes: ["read"]` when the agent only
  reports; add `write` only for agents expected to change things. Keys expire
  (`expires_at`) and are revocable (`DELETE /me/api-keys/:id`).
* **One key per agent, named.** `actor_label` makes the audit trail
  attributable ("claude-triage" vs "alice-cli").
* **Confidentiality holds.** The MCP server sees only what the key owner can
  see (`can_view_item`); confidential items are invisible unless the owner is
  assignee/reporter/creator/admin. Do not give agents firm-admin keys.
* **Prompt-injection surface.** Item titles, descriptions and comments are
  user-controlled text; the server never interprets them, but an agent will
  read them. Treat tool output as data in agent instructions.
* **Rate limits** apply per key like any client (see
  [05-operations.md](05-operations.md#3-security)).
* **No bypass.** The MCP server has no database credentials; it cannot read
  `activity_events` beyond what `/activity` exposes under visibility rules.
