import type { IntegrationDeps } from '../deps.js';

export interface OutboundEmail {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

type Transporter = { sendMail(opts: Record<string, unknown>): Promise<unknown> };
const transports = new Map<string, Promise<Transporter>>();

async function transportFor(smtpUrl: string): Promise<Transporter> {
  let t = transports.get(smtpUrl);
  if (!t) {
    t = import('nodemailer').then((m) => (m.default ?? m).createTransport(smtpUrl) as unknown as Transporter);
    transports.set(smtpUrl, t);
  }
  return t;
}

/** Send via SMTP when `SMTP_URL` is configured; otherwise log the message (dev). */
export async function sendEmail(deps: IntegrationDeps, mail: OutboundEmail): Promise<void> {
  const { smtpUrl, emailFrom, inboundDomain } = deps.config;
  const replyTo = mail.replyTo ?? (inboundDomain ? `pm@${inboundDomain}` : undefined);
  if (!smtpUrl) {
    deps.log.info({ to: mail.to, subject: mail.subject, text: mail.text }, 'email: SMTP_URL not set; message logged instead of sent (dev mode)');
    return;
  }
  try {
    const transport = await transportFor(smtpUrl);
    await transport.sendMail({
      from: emailFrom,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
    });
    deps.log.info({ to: mail.to, subject: mail.subject }, 'email: sent');
  } catch (err) {
    deps.log.error({ to: mail.to, subject: mail.subject, err: err instanceof Error ? err.message : String(err) }, 'email: send failed');
    throw err;
  }
}
