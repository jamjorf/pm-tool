// ============================================================================
// Implements IntegrationDeps (packages/integrations/src/deps.ts) on top of the
// API's db/auth/mutations and mounts registerIntegrationRoutes(). The module is
// loaded dynamically so the server still boots when @pm/integrations is not built.
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { parseMutation, type Actor, type Mutation } from '@pm/core';
import { ensureServiceUser, loadActor } from './actor.js';
import { withTxn } from './db.js';
import { applyMutation } from './mutations/index.js';
import { pokeAfterCommit } from './sync/poke.js';

/** Structural mirror of IntegrationDeps/ItemSummary/OutboundNotification from packages/integrations/src/deps.ts. */
export interface ItemSummaryLike {
  id: string; key: string; title: string; description: string; type_key: string; project_id: string; project_key: string;
  state_name: string; state_category: string; priority: number; assignee_name: string | null; assignee_id: string | null; due_date: string | null; url: string;
}
export interface IntegrationConfigLike {
  appUrl: string; apiUrl: string; slackBotToken?: string; slackSigningSecret?: string; githubWebhookSecret?: string; githubToken?: string;
  emailFrom: string; smtpUrl?: string; inboundDomain?: string;
}
export interface IntegrationDepsLike {
  config: IntegrationConfigLike;
  getIntegrationConfig(kind: 'slack' | 'github' | 'email'): Promise<{ config: Record<string, unknown>; is_active: boolean } | null>;
  findItemByKey(key: string): Promise<ItemSummaryLike | null>;
  findProjectByKey(key: string): Promise<{ id: string; key: string; name: string; default_type_id: string | null } | null>;
  resolveUserByEmail(email: string): Promise<{ id: string; name: string; email: string } | null>;
  resolveUserBySlackId(slackUserId: string): Promise<{ id: string; name: string; email: string } | null>;
  systemActor(label: 'slack' | 'github' | 'email'): Promise<Actor>;
  actorForUser(userId: string): Promise<Actor>;
  runMutation(actor: Actor, mutation: Mutation, meta: { source: 'slack' | 'github' | 'email'; actorLabel: string }): Promise<unknown>;
  recordInbound(source: string, externalId: string): Promise<boolean>;
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}
export interface OutboundNotificationLike {
  kind: string; title: string; body: string | null; item: ItemSummaryLike | null; actorName: string | null; createdAt: string;
}
export interface RenderedLike { subject: string; text: string; html: string; slackBlocks: unknown[] }
export interface IntegrationsModule {
  registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationDepsLike): Promise<void>;
  sendSlackMessage(deps: IntegrationDepsLike, msg: { channel: string; text: string; blocks?: unknown[] }): Promise<void>;
  sendEmail(deps: IntegrationDepsLike, msg: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  renderNotification(n: OutboundNotificationLike): RenderedLike;
  renderDigest(items: OutboundNotificationLike[]): RenderedLike;
}

declare module 'fastify' {
  interface FastifyInstance {
    integrations?: IntegrationsModule | null;
    integrationDeps?: IntegrationDepsLike;
    refreshIntegrations?: () => Promise<void>;
  }
}

const SERVICE_EMAIL = 'agent@firm.com';

export function buildIntegrationDeps(app: FastifyInstance): IntegrationDepsLike {
  const sql = app.db;
  const cfg = app.config;
  // Secrets: env first, then integration_configs.config (refreshed via PUT /api/v1/integrations/:kind).
  const config: IntegrationConfigLike = {
    appUrl: cfg.APP_URL, apiUrl: cfg.API_URL, slackBotToken: cfg.SLACK_BOT_TOKEN, slackSigningSecret: cfg.SLACK_SIGNING_SECRET,
    githubWebhookSecret: cfg.GITHUB_WEBHOOK_SECRET, githubToken: cfg.GITHUB_TOKEN, emailFrom: cfg.EMAIL_FROM, smtpUrl: cfg.SMTP_URL, inboundDomain: cfg.EMAIL_INBOUND_DOMAIN,
  };
  const refresh = async () => {
    try {
      const rows = await sql`select kind, config from integration_configs`;
      const by: Record<string, Record<string, unknown>> = {};
      for (const r of rows) by[r.kind] = r.config ?? {};
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      config.slackSigningSecret = cfg.SLACK_SIGNING_SECRET ?? str(by.slack?.signing_secret);
      config.slackBotToken = cfg.SLACK_BOT_TOKEN ?? str(by.slack?.bot_token);
      config.githubWebhookSecret = cfg.GITHUB_WEBHOOK_SECRET ?? str(by.github?.webhook_secret);
      config.githubToken = cfg.GITHUB_TOKEN ?? str(by.github?.token);
      config.inboundDomain = cfg.EMAIL_INBOUND_DOMAIN ?? str(by.email?.inbound_domain);
    } catch (e) {
      app.log.warn({ err: e }, 'could not load integration_configs');
    }
  };
  app.decorate('refreshIntegrations', refresh);

  const deps: IntegrationDepsLike = {
    config,
    async getIntegrationConfig(kind) {
      const [r] = await sql`select config, is_active from integration_configs where kind = ${kind}`;
      return r ? { config: r.config ?? {}, is_active: !!r.is_active } : null;
    },
    async findItemByKey(key) {
      const [w] = await sql`select * from work_items_v where upper(key) = upper(${key}) and deleted_at is null`;
      if (!w) return null;
      return {
        id: w.id, key: w.key, title: w.title, description: w.description, type_key: w.type_key, project_id: w.project_id, project_key: w.project_key,
        state_name: w.state_name, state_category: w.state_category, priority: w.priority, assignee_name: w.assignee_name, assignee_id: w.assignee_id,
        due_date: w.due_date, url: `${cfg.APP_URL}/i/${w.key}`,
      };
    },
    async findProjectByKey(key) {
      const [p] = await sql`select id, key, name, default_type_id from projects where upper(key) = upper(${key}) and deleted_at is null`;
      return p ? { id: p.id, key: p.key, name: p.name, default_type_id: p.default_type_id } : null;
    },
    async resolveUserByEmail(email) {
      const [u] = await sql`select id, name, email from users where lower(email) = lower(${email}) and deleted_at is null and is_active`;
      return u ? { id: u.id, name: u.name, email: u.email } : null;
    },
    async resolveUserBySlackId(slackUserId) {
      const [u] = await sql`select id, name, email from users where settings->>'slack_user_id' = ${slackUserId} and deleted_at is null and is_active`;
      return u ? { id: u.id, name: u.name, email: u.email } : null;
    },
    async systemActor(label) {
      let [u] = await sql`select * from users where lower(email) = ${SERVICE_EMAIL} and deleted_at is null`;
      if (!u) [u] = await sql`select * from users where is_service and deleted_at is null order by created_at limit 1`;
      if (!u) {
        u = await withTxn(sql, async (tx) => {
          const [row] = await tx`insert into users (email, name, firm_role, is_service) values (${SERVICE_EMAIL}, 'Agent', 'admin', true)
            on conflict do nothing returning *`;
          return row ?? (await ensureServiceUser(tx, label));
        });
      }
      const actor = await loadActor(sql, u!.id);
      if (actor.firmRole === 'member' || actor.firmRole === 'guest') actor.firmRole = 'admin';
      return actor;
    },
    actorForUser: (userId) => loadActor(sql, userId),
    async runMutation(actor, mutation, meta) {
      const raw = (mutation.args ?? {}) as Record<string, unknown>;
      const parsed = parseMutation(mutation.name, raw);
      // addComment may carry source/external_ref (zod strips them); keep them for comments.source/external_ref
      if (parsed.name === 'addComment') {
        const extra: Record<string, unknown> = {};
        if (typeof raw.source === 'string') extra.source = raw.source;
        if (raw.external_ref && typeof raw.external_ref === 'object') extra.external_ref = raw.external_ref;
        Object.assign(parsed.args as Record<string, unknown>, extra);
      }
      const result = await withTxn(sql, (tx) =>
        applyMutation(tx, actor, parsed, { source: meta.source, txnId: randomUUID(), mutationName: parsed.name, actorKind: 'integration', actorLabel: meta.actorLabel }),
      );
      await pokeAfterCommit(sql);
      return result;
    },
    async recordInbound(source, externalId) {
      const rows = await sql`insert into inbound_events (source, external_id) values (${source}, ${externalId}) on conflict do nothing returning source`;
      return rows.length > 0;
    },
    log: app.log,
  };
  app.decorate('integrationDeps', deps);
  void refresh();
  return deps;
}

/** Dynamically import @pm/integrations; returns null (and logs) when it is not built yet. */
export async function loadIntegrationsModule(app: FastifyInstance): Promise<IntegrationsModule | null> {
  const spec = '@pm/integrations';
  try {
    const mod = (await import(spec)) as Partial<IntegrationsModule>;
    if (typeof mod.registerIntegrationRoutes !== 'function') throw new Error('registerIntegrationRoutes not exported');
    return mod as IntegrationsModule;
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, '@pm/integrations not available; /integrations/* routes disabled');
    return null;
  }
}
