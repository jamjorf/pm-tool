// @pm/integrations — Slack, GitHub and email for pm-tool.
// Pure library consumed by @pm/api: no DB driver, everything goes through IntegrationDeps.
export type { IntegrationDeps, IntegrationConfig, ItemSummary, OutboundNotification } from './deps.js';

export { registerIntegrationRoutes, getRawBody } from './routes.js';

export { sendSlackMessage, slackApi, type SlackMessage } from './slack/client.js';
export { verifySlackSignature, signSlackRequest } from './slack/verify.js';
export { handleSlackEvent, slackPermalink } from './slack/events.js';
export { handleSlackCommand, type SlashCommandBody } from './slack/commands.js';
export { handleSlackInteraction } from './slack/interactions.js';
export { itemCard } from './slack/blocks.js';

export { verifyGithubSignature, signGithubRequest } from './github/verify.js';
export { handleGithubWebhook, extractClosingKeys, type GithubWebhookInput, type GithubWebhookResult } from './github/webhook.js';

export { sendEmail, type OutboundEmail } from './email/send.js';
export { parseInboundEmail, handleInboundEmail, stripQuotedReply, routeAddress, parseAddresses, type InboundEmail } from './email/inbound.js';

export { renderNotification, renderDigest, type Rendered } from './render.js';
export { extractKeys, extractKeysFromBranch, keyFromUrl } from './keys.js';
