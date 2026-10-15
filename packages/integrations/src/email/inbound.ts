// ============================================================================
// POST /integrations/email/inbound  (provider-agnostic inbound email webhook)
//   JSON {from, to, subject, text, html?, message_id, in_reply_to?, attachments?}
//   Also accepts Postmark (From/To/Subject/TextBody/StrippedTextReply/MessageID),
//   SendGrid (from/to/subject/text/html) and Mailgun (sender/recipient/subject/
//   body-plain/stripped-text/Message-Id) field names.
//   pm+KEY-12@<inboundDomain>  -> addComment (source 'email'), quoted reply stripped
//   pm+PROJECT@<inboundDomain> -> createItem (title = subject, description = text)
//   pm@<inboundDomain> with "[KEY-12]" in the subject -> comment (replies to notifications)
// Replies 202. Idempotent via recordInbound('email', message_id).
// ============================================================================
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { IntegrationDeps } from '../deps.js';
import { actorForEmail } from '../actors.js';
import { isItemKey, isProjectKey, extractKeys } from '../keys.js';
import { commentMutation, rowOf, tryMutation } from '../mutations.js';

export interface InboundEmail {
  from: string;            // raw header value ("Alice <alice@example.com>" or "alice@example.com")
  fromAddress: string;     // normalised address
  to: string[];            // all recipient addresses (to + cc)
  subject: string;
  text: string;
  html?: string;
  message_id: string;
  in_reply_to?: string;
  attachments?: unknown[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const first = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
};

/** Extract every email address from a header value / list ("A <a@x>, b@y"). */
export function parseAddresses(value: unknown): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    for (const m of s.matchAll(/<([^<>\s@]+@[^<>\s@]+)>|([^\s<>,;"']+@[^\s<>,;"']+)/g)) {
      const a = (m[1] ?? m[2] ?? '').trim().replace(/[.,;]+$/, '').toLowerCase();
      if (a && !out.includes(a)) out.push(a);
    }
  };
  if (typeof value === 'string') push(value);
  else if (Array.isArray(value)) for (const v of value) { if (typeof v === 'string') push(v); else if (v && typeof v === 'object') { const e = (v as Obj).Email ?? (v as Obj).email ?? (v as Obj).address; if (typeof e === 'string') push(e); } }
  return out;
}

/** Normalise the many provider shapes to one InboundEmail. Returns null when there is no sender/recipient at all. */
export function parseInboundEmail(body: unknown): InboundEmail | null {
  const b = obj(body);
  const headers = obj(b.headers);
  const fromRaw = first(b.from, b.From, b.sender, b.Sender, headers.from, headers.From, obj(b.FromFull).Email) ?? '';
  const fromAddress = parseAddresses(fromRaw)[0] ?? '';
  const to = [
    ...parseAddresses(b.to), ...parseAddresses(b.To), ...parseAddresses(b.recipient), ...parseAddresses(b.ToFull),
    ...parseAddresses(b.cc), ...parseAddresses(b.Cc), ...parseAddresses(b.CcFull), ...parseAddresses(b.OriginalRecipient), ...parseAddresses(b.envelope && obj(b.envelope).to),
  ].filter((a, i, arr) => arr.indexOf(a) === i);
  if (!fromAddress && !to.length) return null;
  const subject = first(b.subject, b.Subject, headers.subject) ?? '';
  const text = first(b.text, b.StrippedTextReply, b.TextBody, b['stripped-text'], b['body-plain'], b.StrippedText, b.plain) ?? '';
  const html = first(b.html, b.HtmlBody, b['body-html'], b['stripped-html']);
  const messageId = first(b.message_id, b.MessageID, b.MessageId, b['Message-Id'], b['message-id'], headers['message-id'], headers['Message-Id'], headers['Message-ID'])
    ?? `sha256:${createHash('sha256').update(`${fromAddress}|${to.join(',')}|${subject}|${text}`).digest('hex')}`;
  const inReplyTo = first(b.in_reply_to, b['In-Reply-To'], b['in-reply-to'], headers['in-reply-to'], headers['In-Reply-To']);
  const attachments = Array.isArray(b.attachments) ? b.attachments : Array.isArray(b.Attachments) ? b.Attachments : undefined;
  return {
    from: fromRaw, fromAddress, to, subject, text,
    ...(html ? { html } : {}),
    message_id: messageId.replace(/^<|>$/g, ''),
    ...(inReplyTo ? { in_reply_to: inReplyTo.replace(/^<|>$/g, '') } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

const QUOTE_HEADER_RES: RegExp[] = [
  /^On\s.{0,300}?wrote:\s*$/ims,                 // Gmail/Apple: "On Mon, 1 Jan 2024 at 10:00, Alice <a@b> wrote:" (may wrap)
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,     // Outlook
  /^_{10,}\s*$/m,                                // Outlook separator
  /^From:\s.+\n(?:Sent|Date):\s.+$/im,           // Outlook header block
  /^Le\s.{0,300}?a écrit\s?:\s*$/ims,            // French
  /^Am\s.{0,300}?schrieb\s.{0,100}?:\s*$/ims,    // German
  /^-- \s*$/m,                                   // signature delimiter
];

/** Keep only the new part of a reply: drop quoted lines (`>`) and everything after a reply header. */
export function stripQuotedReply(text: string): string {
  let body = text.replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const re of QUOTE_HEADER_RES) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  body = body.slice(0, cut);
  const lines = body.split('\n').filter((l) => !/^\s*>/.test(l));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Decide what an inbound address targets: `pm+KEY-12@…` → item, `pm+PROJ@…` → project, `pm@…` → nothing (subject may still hold a key). */
export function routeAddress(address: string, inboundDomain?: string): { kind: 'item'; key: string } | { kind: 'project'; key: string } | { kind: 'plain' } | null {
  const m = /^([^+@]+)(?:\+([^@]+))?@(.+)$/.exec(address.toLowerCase());
  if (!m) return null;
  const [, local = '', tag, domain = ''] = m;
  if (inboundDomain && domain !== inboundDomain.toLowerCase()) return null;
  if (local !== 'pm' && local !== 'pm-tool' && local !== 'tickets') return null;
  if (!tag) return { kind: 'plain' };
  const t = tag.toUpperCase();
  if (isItemKey(t)) return { kind: 'item', key: t };
  if (isProjectKey(t)) return { kind: 'project', key: t };
  return null;
}

export interface EmailInboundResult {
  status: number;
  body: { ok: boolean; action: 'comment' | 'created' | 'ignored' | 'duplicate' | 'error'; key?: string; reason?: string };
}

export async function handleInboundEmail(deps: IntegrationDeps, rawBody: unknown): Promise<EmailInboundResult> {
  const mail = parseInboundEmail(rawBody);
  if (!mail) return { status: 400, body: { ok: false, action: 'error', reason: 'missing from/to' } };

  // Pick the first recipient we understand.
  let target: ReturnType<typeof routeAddress> = null;
  for (const addr of mail.to) {
    const r = routeAddress(addr, deps.config.inboundDomain);
    if (r && r.kind !== 'plain') { target = r; break; }
    if (r && !target) target = r;
  }
  if (!target || target.kind === 'plain') {
    // Replies to notification mails carry "[KEY-12]" in the subject.
    const key = extractKeys(mail.subject)[0];
    if (key && target) target = { kind: 'item', key };
  }
  if (!target || target.kind === 'plain') {
    deps.log.info({ to: mail.to, subject: mail.subject }, 'email: no routable recipient; ignored');
    return { status: 202, body: { ok: true, action: 'ignored', reason: 'no_routable_recipient' } };
  }

  if (!(await deps.recordInbound('email', mail.message_id))) return { status: 202, body: { ok: true, action: 'duplicate' } };

  const who = await actorForEmail(deps, 'email', mail.fromAddress);
  const fromLine = who.user ? '' : `*From ${mail.from || mail.fromAddress} (email)*\n\n`;

  if (target.kind === 'item') {
    const item = await deps.findItemByKey(target.key);
    if (!item) return { status: 202, body: { ok: true, action: 'ignored', key: target.key, reason: 'unknown_item' } };
    const text = stripQuotedReply(mail.text) || (mail.subject ? `(no text) ${mail.subject}` : '(empty email)');
    const r = await tryMutation(deps, who, commentMutation(item.id, fromLine + text, 'email', {
      message_id: mail.message_id, from: mail.fromAddress, subject: mail.subject, ...(mail.in_reply_to ? { in_reply_to: mail.in_reply_to } : {}),
    }), 'email');
    if (!r.ok) return { status: 202, body: { ok: false, action: 'error', key: item.key, reason: r.error } };
    return { status: 202, body: { ok: true, action: 'comment', key: item.key } };
  }

  const project = await deps.findProjectByKey(target.key);
  if (!project) return { status: 202, body: { ok: true, action: 'ignored', key: target.key, reason: 'unknown_project' } };
  if (!project.default_type_id) return { status: 202, body: { ok: false, action: 'error', key: target.key, reason: 'project_has_no_default_type' } };
  const title = (mail.subject || stripQuotedReply(mail.text).split('\n')[0] || 'Email item').slice(0, 500);
  const description = fromLine + stripQuotedReply(mail.text);
  const r = await tryMutation(deps, who, {
    name: 'createItem',
    args: { id: randomUUID(), project_id: project.id, type_id: project.default_type_id, title, description },
  }, 'email');
  if (!r.ok) return { status: 202, body: { ok: false, action: 'error', key: target.key, reason: r.error } };
  const key = rowOf(r.result).key;
  return { status: 202, body: { ok: true, action: 'created', ...(key ? { key } : {}) } };
}
