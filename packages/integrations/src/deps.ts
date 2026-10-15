// ============================================================================
// Contract between @pm/api (which owns the database, auth and mutations) and
// @pm/integrations (Slack / GitHub / email). The API implements IntegrationDeps
// in packages/api/src/integrations.ts and calls registerIntegrationRoutes().
// @pm/integrations must not import a database driver; it only uses these deps.
// ============================================================================
import type { Actor, Mutation } from '@pm/core';

export interface ItemSummary {
  id: string;
  key: string;            // "RATES-12"
  title: string;
  description: string;
  type_key: string;
  project_id: string;
  project_key: string;
  state_name: string;
  state_category: string;
  priority: number;
  assignee_name: string | null;
  assignee_id: string | null;
  due_date: string | null;
  url: string;            // deep link into the web app
}

export interface IntegrationConfig {
  appUrl: string;
  apiUrl: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  githubWebhookSecret?: string;
  githubToken?: string;
  emailFrom: string;
  smtpUrl?: string;
  /** e.g. "pm.example.com" → inbound addresses pm+RATES-12@pm.example.com */
  inboundDomain?: string;
}

export interface IntegrationDeps {
  config: IntegrationConfig;
  /** Row from integration_configs (admin-editable JSON), or null when unset. */
  getIntegrationConfig(kind: 'slack' | 'github' | 'email'): Promise<{ config: Record<string, unknown>; is_active: boolean } | null>;
  findItemByKey(key: string): Promise<ItemSummary | null>;
  findProjectByKey(key: string): Promise<{ id: string; key: string; name: string; default_type_id: string | null } | null>;
  /** Map an external identity to a user (email for email/GitHub-noreply, Slack user id via users.settings.slack_user_id). */
  resolveUserByEmail(email: string): Promise<{ id: string; name: string; email: string } | null>;
  resolveUserBySlackId(slackUserId: string): Promise<{ id: string; name: string; email: string } | null>;
  /** Actor to use for writes done by an integration on behalf of nobody in particular (a service user). */
  systemActor(label: 'slack' | 'github' | 'email'): Promise<Actor>;
  /** Actor for a resolved user. */
  actorForUser(userId: string): Promise<Actor>;
  /** Run one mutation from the shared vocabulary; throws on validation/permission/guard failure. Returns the affected row when applicable. */
  runMutation(actor: Actor, mutation: Mutation, meta: { source: 'slack' | 'github' | 'email'; actorLabel: string }): Promise<unknown>;
  /** Idempotency guard for inbound events. Returns false if (source, externalId) was already seen. */
  recordInbound(source: string, externalId: string): Promise<boolean>;
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

/** Message rendered for an outbound notification (email + Slack share the same model). */
export interface OutboundNotification {
  kind: string;             // mention | assigned | reply | state_change | comment | due_soon | digest
  title: string;
  body: string | null;
  item: ItemSummary | null;
  actorName: string | null;
  createdAt: string;
}
