// ============================================================================
// registerIntegrationRoutes(app, deps): mounts the five inbound routes.
//
// Raw-body approach: the routes are registered inside an encapsulated Fastify
// plugin. In that scope we replace the `application/json` parser and add an
// `application/x-www-form-urlencoded` parser, both with `parseAs: 'string'`,
// so the exact bytes Slack/GitHub signed are kept (in a WeakMap keyed by the
// request; no FastifyRequest augmentation, so the host app's own typings and
// parsers are untouched). Signature checks run in a `preHandler` hook.
//
// Secrets: Slack signing secret / GitHub webhook secret come from
// `deps.config` (env) or, as a fallback, the admin-edited integration config
// (`signing_secret` / `webhook_secret`). When no secret is configured the
// request is accepted and a warning is logged (dev mode); with a secret, bad
// or missing signatures are rejected with 401.
// ============================================================================
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IntegrationDeps } from './deps.js';
import { verifySlackSignature } from './slack/verify.js';
import { verifyGithubSignature } from './github/verify.js';
import { handleSlackEvent } from './slack/events.js';
import { handleSlackCommand, type SlashCommandBody } from './slack/commands.js';
import { handleSlackInteraction } from './slack/interactions.js';
import { handleGithubWebhook } from './github/webhook.js';
import { handleInboundEmail } from './email/inbound.js';

const RAW_BODIES = new WeakMap<object, string>();

/** Raw request body (string) captured by the integration content-type parsers. */
export function getRawBody(req: FastifyRequest): string {
  return RAW_BODIES.get(req) ?? '';
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

async function slackSigningSecret(deps: IntegrationDeps): Promise<string | undefined> {
  if (deps.config.slackSigningSecret) return deps.config.slackSigningSecret;
  const cfg = await deps.getIntegrationConfig('slack').catch(() => null);
  const s = cfg?.config?.signing_secret;
  return typeof s === 'string' && s ? s : undefined;
}

async function githubWebhookSecret(deps: IntegrationDeps): Promise<string | undefined> {
  if (deps.config.githubWebhookSecret) return deps.config.githubWebhookSecret;
  const cfg = await deps.getIntegrationConfig('github').catch(() => null);
  const s = cfg?.config?.webhook_secret;
  return typeof s === 'string' && s ? s : undefined;
}

async function emailInboundToken(deps: IntegrationDeps): Promise<string | undefined> {
  const cfg = await deps.getIntegrationConfig('email').catch(() => null);
  const s = cfg?.config?.inbound_token;
  return typeof s === 'string' && s ? s : undefined;
}

export async function registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationDeps): Promise<void> {
  await app.register(async (scope) => {
    // --- raw body capture (encapsulated in this plugin scope) ---------------
    for (const ct of ['application/json', 'application/x-www-form-urlencoded']) {
      if (scope.hasContentTypeParser(ct)) scope.removeContentTypeParser(ct);
    }
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      RAW_BODIES.set(req, raw);
      if (!raw.trim()) return done(null, {});
      try { done(null, JSON.parse(raw)); } catch (err) { done(Object.assign(err as Error, { statusCode: 400 }), undefined); }
    });
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      RAW_BODIES.set(req, raw);
      done(null, Object.fromEntries(new URLSearchParams(raw)));
    });

    // --- signature guards -----------------------------------------------------
    const slackGuard = async (req: FastifyRequest, reply: FastifyReply) => {
      const secret = await slackSigningSecret(deps);
      if (!secret) { deps.log.warn({ url: req.url }, 'slack: no signing secret configured; accepting unsigned request (dev mode)'); return; }
      const ok = verifySlackSignature(secret, getRawBody(req), header(req, 'x-slack-request-timestamp'), header(req, 'x-slack-signature'));
      if (!ok) { deps.log.warn({ url: req.url }, 'slack: invalid signature'); return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid Slack signature' } }); }
    };
    const githubGuard = async (req: FastifyRequest, reply: FastifyReply) => {
      const secret = await githubWebhookSecret(deps);
      if (!secret) { deps.log.warn({ url: req.url }, 'github: no webhook secret configured; accepting unsigned request (dev mode)'); return; }
      const ok = verifyGithubSignature(secret, getRawBody(req), header(req, 'x-hub-signature-256'));
      if (!ok) { deps.log.warn({ url: req.url }, 'github: invalid signature'); return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid GitHub signature' } }); }
    };
    const emailGuard = async (req: FastifyRequest, reply: FastifyReply) => {
      const token = await emailInboundToken(deps);
      if (!token) { deps.log.warn({ url: req.url }, 'email: no inbound_token configured; accepting unauthenticated request (dev mode)'); return; }
      const q = (req.query ?? {}) as Record<string, unknown>;
      const presented = header(req, 'x-inbound-token') ?? (typeof q.token === 'string' ? q.token : undefined) ?? header(req, 'authorization')?.replace(/^Bearer\s+/i, '');
      if (presented !== token) return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid inbound email token' } });
    };

    // --- routes ---------------------------------------------------------------
    scope.post('/integrations/slack/events', { preHandler: slackGuard }, async (req, reply) => {
      const r = await handleSlackEvent(deps, req.body);
      return reply.code(r.status).send(r.body);
    });
    scope.post('/integrations/slack/commands', { preHandler: slackGuard }, async (req, reply) => {
      const r = await handleSlackCommand(deps, (req.body ?? {}) as SlashCommandBody);
      return reply.code(r.status).send(r.body);
    });
    scope.post('/integrations/slack/interactions', { preHandler: slackGuard }, async (req, reply) => {
      // Slack wants a fast 200; the result is posted to response_url by the handler.
      const r = await handleSlackInteraction(deps, req.body);
      return reply.code(r.status).send(r.body);
    });
    scope.post('/integrations/github/webhook', { preHandler: githubGuard }, async (req, reply) => {
      const r = await handleGithubWebhook(deps, {
        event: header(req, 'x-github-event') ?? '',
        deliveryId: header(req, 'x-github-delivery') ?? '',
        payload: (req.body ?? {}) as Record<string, unknown>,
      });
      return reply.code(r.status).send(r.body);
    });
    scope.post('/integrations/email/inbound', { preHandler: emailGuard }, async (req, reply) => {
      const r = await handleInboundEmail(deps, req.body);
      return reply.code(r.status).send(r.body);
    });
  });
}
