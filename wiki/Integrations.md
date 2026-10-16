# Integrations

Everything outside the browser talks to the same API and lands in the same activity log. Outbound: webhooks, Slack DMs, email. Inbound: Slack events, slash commands and buttons, GitHub webhooks, provider-agnostic email JSON. Inbound handlers live in `packages/integrations` and are mounted by the API under `/integrations/*`; every write they make goes through `applyMutation` with `source` set to `slack`, `github` or `email`.

Full guide with Python verification, the Slack manifest and provider field mappings: [docs/04-integrations.md](https://github.com/jamjorf/pm-tool/blob/main/docs/04-integrations.md). Routes: [docs/ARCHITECTURE.md](https://github.com/jamjorf/pm-tool/blob/main/docs/ARCHITECTURE.md#http-api-v1-served-by-pmapi).

## Webhooks out

### Subscribe

Firm admin only. `event_kinds: ["*"]` (the default) matches everything; omit `project` for all projects.

```bash
H=(-H "authorization: Bearer $PM_API_KEY" -H 'content-type: application/json')
curl -s "${H[@]}" -X POST $API/api/v1/webhooks -d '{
  "name": "risk-system",
  "url": "https://risk.internal/hooks/pm",
  "event_kinds": ["item.transitioned","item.completed","comment.created"],
  "project": "RATES"
}'
# → the endpoint row, including "secret": store it on the receiving side
curl -s "${H[@]}" -X POST $API/api/v1/webhooks/<id>/test        # synthetic delivery
curl -s "${H[@]}" $API/api/v1/webhooks/<id>/deliveries           # status, attempts, response codes
```

The same lives under **Admin → Webhooks** (`/admin/webhooks`).

### Event kinds

| kind | When | `changes` |
|---|---|---|
| `item.created` | `createItem` | initial non-default fields |
| `item.updated` | any field change not from a transition (incl. labels, move) | per field |
| `item.transitioned` | `state_id` changed by a transition | `state_id` plus effect fields |
| `item.completed` | a transition's `webhook` effect names it (the seeded `complete` does) | as above |
| `item.deleted`, `item.restored` | soft delete, restore | none |
| `comment.created`, `comment.updated`, `comment.deleted` | comments | `body` |
| `relation.added`, `relation.removed` | relations, parent changes, external links | relation row in `item` context |
| `project.created`, `project.updated` | projects | per field |

Workflow `webhook` effects may emit any string as `event`; subscribe to it by name or with `*`.

### Delivery format

Headers: `X-PM-Event: <kind>`, `X-PM-Delivery: <delivery id>` (idempotency key), `X-PM-Signature: sha256=<hex>`, `content-type: application/json`. Changes within one `txn_id` for the same item are coalesced into one delivery.

```json
{
  "id": 1234,
  "kind": "item.transitioned",
  "created_at": "2026-10-15T14:02:11.312Z",
  "actor": { "id": "…", "name": "Alice", "kind": "user" },
  "project": { "id": "…", "key": "RATES", "name": "Rates Desk Platform" },
  "item": { "id": "…", "key": "RATES-12", "title": "…", "state_key": "in_progress", "state_category": "in_progress", "type_key": "bug", "…": "every work_items_v column" },
  "changes": [ { "field": "state_id", "old": "…", "new": "…" }, { "field": "start_date", "old": null, "new": "2026-10-15" } ],
  "event_ids": [ 9876, 9877 ]
}
```

`event_ids` point at `activity_events` rows; fetch more through `GET /api/v1/activity?since=` if the coalesced changes are not enough.

### Verify the signature (Node)

The signature is HMAC-SHA256 of the **raw request body bytes** with the endpoint secret, hex-encoded, prefixed `sha256=`. Compare in constant time.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyPmSignature(rawBody /* Buffer */, header /* string */, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

// express
app.post('/hooks/pm', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyPmSignature(req.body, req.get('x-pm-signature'), process.env.PM_WEBHOOK_SECRET)) return res.status(401).end();
  const deliveryId = req.get('x-pm-delivery');          // use as the idempotency key
  const event = JSON.parse(req.body.toString('utf8'));
  // handle event.kind ...
  res.status(204).end();
});
```

Respond 2xx within a few seconds and do the work asynchronously. A Python version is in [docs/04-integrations.md §2.3](https://github.com/jamjorf/pm-tool/blob/main/docs/04-integrations.md#23-verify-the-signature).

### Retries

A dispatcher loop inside the API process runs every 5 seconds over `webhook_deliveries where status in ('pending','failed') and next_attempt_at <= now()`. Any non-2xx or timeout schedules a retry with backoff **1 m → 5 m → 30 m → 2 h → 12 h**, then `status = 'dead'`. Deliveries for one endpoint are sent in `id` order, so a slow endpoint delays only its own queue. `GET /api/v1/webhooks/:id/deliveries` shows every attempt with `response_status` and `response_body`.

## Slack

### What it does

| Feature | Route | Behaviour |
|---|---|---|
| Unfurls | `POST /integrations/slack/events` (`link_shared`) | pasting an item URL shows key, title, state, assignee, priority |
| Autolink | `POST /integrations/slack/events` (`message`) | a message containing `RATES-12` gets a threaded reply with the item summary; a `links_to` relation (`external_kind = 'slack_thread'`) is added to the item |
| Slash command | `POST /integrations/slack/commands` | `/pm create <title>`, `/pm find <text>`, `/pm mine`, `/pm RATES-12` |
| Notifications | delivery worker → `sendSlackMessage` | DM per `notification_preferences` (channel `slack`), with transition buttons |
| Buttons | `POST /integrations/slack/interactions` | block actions run the transition as the Slack user (resolved via `users.settings.slack_user_id`, falling back to email) |

### `/pm` commands

| Command | Does |
|---|---|
| `/pm create Fix the 50y tenor` | `createItem` in the channel's mapped project (default type), reporter = the Slack user; replies with key and link |
| `/pm find curve NaN` | `GET /api/v1/search` as the user; top 5 with links |
| `/pm mine` | `GET /api/v1/my-work`: assigned plus due soon |
| `/pm RATES-12` | item card with transition buttons |

### Setup

1. Create a Slack app from the manifest in [docs/04-integrations.md §3.2](https://github.com/jamjorf/pm-tool/blob/main/docs/04-integrations.md#32-setup), replacing `API_HOST` and `APP_HOST`. It declares bot scopes `chat:write`, `commands`, `links:read`, `links:write`, `channels:history`, `groups:history`, `im:write`, `users:read`, `users:read.email`; event subscriptions `link_shared`, `message.channels`, `message.groups` at `https://API_HOST/integrations/slack/events`; the `/pm` slash command at `https://API_HOST/integrations/slack/commands`; interactivity at `https://API_HOST/integrations/slack/interactions`; unfurl domain `APP_HOST`.
2. Install it to the workspace. Copy the **Bot User OAuth Token** to `SLACK_BOT_TOKEN` and the **Signing Secret** to `SLACK_SIGNING_SECRET`.
3. Map channels to projects:

```bash
curl -s "${H[@]}" -X PUT $API/api/v1/integrations/slack -d '{
  "config": { "team_id": "T…", "channel_map": { "RATES": "C…" }, "notify_on": ["item.transitioned","comment.created"] },
  "is_active": true
}'
```

4. Users are linked by having the same email in Slack and pm-tool, or by setting `users.settings.slack_user_id`.

All three routes verify `X-Slack-Signature` with `SLACK_SIGNING_SECRET` and answer the `url_verification` challenge. Retried Slack events are de-duplicated via `inbound_events` (`source = 'slack'`, `external_id = event_id`). Writes from Slack are logged with `source = 'slack'`; `actor_kind = 'user'` when the Slack user resolves, otherwise the `slack` service actor with `actor_kind = 'integration'`.

## GitHub

### Setup

Repository or organisation webhook (or a GitHub App with the same events):

- Payload URL `https://API_HOST/integrations/github/webhook`, content type `application/json`.
- Secret: the value of `GITHUB_WEBHOOK_SECRET` (`X-Hub-Signature-256` is verified).
- Events: **Pull requests**, **Issues**, **Pushes**.
- `GITHUB_TOKEN` (optional) lets the server post a comment back with the item link.
- Enable it: `PUT /api/v1/integrations/github {"config":{"repos":["firm/curves"],"autolink":true},"is_active":true}`.

Redeliveries are de-duplicated via `inbound_events` (`source = 'github'`, `external_id = X-GitHub-Delivery`).

### Conventions

| Where you write the key | Effect |
|---|---|
| Branch name `rates-12-curve-nan` or `RATES-12/curve-nan` | the PR opened from it is linked to `RATES-12` (`links_to`, `external_kind = 'github_pr'`) |
| PR title or body mentions `RATES-12` | same link |
| PR body contains `Fixes RATES-12`, `Closes RATES-12` or `Resolves RATES-12` | on merge, runs the `complete` transition as the GitHub user (matched by noreply email) or the `github` service actor; guard failures become a comment on the item instead of an error |
| Issue title or body mentions a key | `links_to` with `external_kind = 'github_issue'` |
| Commit messages in a push mention a key | one comment per push on the item (`source = 'github'`) listing the commits |

`external_ref` for a PR is `{"url","repo","number","title","state"}`; the generated `external_key` (`github_pr:<url>`) makes re-linking idempotent. PR state changes update `external_ref`.

## Email

### Inbound

`POST /integrations/email/inbound` accepts a provider-agnostic JSON body:

```json
{ "from": "bob@firm.com", "to": "pm+RATES-12@pm.example.com", "subject": "Re: [RATES-12] Curve builder",
  "text": "Confirmed, the tenor grid is wrong.", "html": "<p>…</p>",
  "message_id": "<abc@firm.com>", "in_reply_to": "<xyz@pm.example.com>" }
```

Address scheme (`inbound_domain` from `integration_configs` kind `email`):

| To | Effect |
|---|---|
| `pm+RATES-12@pm.example.com` | `addComment` on RATES-12, `source = 'email'`, `external_ref = {"message_id": …}`; author = the user resolved by `from`, else the `email` service actor with the sender quoted |
| `pm+RATES@pm.example.com` | `createItem` in project RATES (default type), title = subject, description = text, reporter = the resolved user |
| reply to a notification email | its `Reply-To` is `pm+<KEY>@…`, so replies thread back as comments |

Duplicates are dropped via `inbound_events` (`source = 'email'`, `external_id = message_id`). Unknown senders are refused unless the email config allows them (`allow_unknown_senders`). Protect the route with a shared secret (the recommended shape is a `?token=` validated against the email config).

Provider adapters map the provider payload to the JSON above; the field mappings for Postmark, SendGrid Inbound Parse, Mailgun Routes and SES + Lambda are in [docs/04-integrations.md §5.1](https://github.com/jamjorf/pm-tool/blob/main/docs/04-integrations.md#51-inbound).

### Outbound

`SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`) and `EMAIL_FROM`. If `SMTP_URL` is unset, emails are logged instead of sent. Rendering uses `renderNotification` and `renderDigest` from `@pm/integrations`; every email links to the item via `APP_URL`, sets `Reply-To` to the item's inbound address, and respects the user's `email` cadence (`immediate`, `hourly`, `daily`, `off`) and quiet hours. The notification delivery worker runs every 30 seconds; the due-soon scheduler hourly.

## Where secrets go

| Secret | Where | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | `.env` on the API host | see [[Operations]] for the full env table |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` | `.env` on the API host | |
| `SMTP_URL`, `EMAIL_FROM` | `.env` on the API host | |
| Channel map, repos, inbound domain, `allow_unknown_senders` | `integration_configs` via `PUT /api/v1/integrations/:kind` or **Admin → Integrations** (`/admin/integrations`) | `is_active` switches each integration on |
| Webhook endpoint secrets | generated by the server on `POST /api/v1/webhooks`, stored in `webhook_endpoints.secret` | shown in the create response |
| API keys for the MCP server | on the agent host, never on the API server | see [[MCP Server]] |

The seed ships inactive `slack`, `github` and `email` configs and one inactive webhook endpoint so the admin screens have something to edit.
