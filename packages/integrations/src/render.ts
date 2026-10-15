// ============================================================================
// Rendering of outbound notifications (email + Slack share one model).
// Compact and low-noise: one line of context, the body, one link.
// ============================================================================
import type { ItemSummary, OutboundNotification } from './deps.js';
import { escapeHtml, truncate } from './http.js';
import { itemCard, itemContextLine, mrkdwnEscape, priorityLabel } from './slack/blocks.js';

export interface Rendered { subject: string; text: string; html: string; slackBlocks: unknown[] }

const BODY_MAX = 600;

/** "<Actor> <verb>" per notification kind; falls back to the notification title. */
export function headline(n: OutboundNotification): string {
  const actor = n.actorName ?? 'Someone';
  switch (n.kind) {
    case 'assigned': return `${actor} assigned you`;
    case 'mention': return `${actor} mentioned you`;
    case 'reply': return `${actor} replied`;
    case 'comment': return `${actor} commented`;
    case 'state_change': return `${actor} changed the state`;
    case 'due_soon': return 'Due soon';
    case 'mutation_rejected': return 'Change rejected';
    default: return n.title || `${actor}: ${n.kind}`;
  }
}

export function renderNotification(n: OutboundNotification): Rendered {
  const item = n.item;
  const head = headline(n);
  const subject = item ? `[${item.key}] ${head}: ${item.title}` : `${head}: ${n.title}`;
  const body = n.body ? truncate(n.body.trim(), BODY_MAX) : '';

  const textLines = [item ? `${item.key} ${item.title}` : n.title, head];
  if (item) textLines.push(contextText(item));
  if (body) textLines.push('', body);
  if (item) textLines.push('', item.url);
  const text = textLines.join('\n');

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1f2328">',
    item ? `<p style="margin:0 0 4px"><a href="${escapeHtml(item.url)}" style="font-weight:600;color:#0969da;text-decoration:none">${escapeHtml(item.key)}</a> ${escapeHtml(item.title)}</p>` : `<p style="margin:0 0 4px;font-weight:600">${escapeHtml(n.title)}</p>`,
    `<p style="margin:0 0 4px;color:#57606a">${escapeHtml(head)}${item ? ' · ' + escapeHtml(contextText(item)) : ''}</p>`,
    body ? `<blockquote style="margin:8px 0;padding:0 0 0 10px;border-left:3px solid #d0d7de;white-space:pre-wrap">${escapeHtml(body)}</blockquote>` : '',
    item ? `<p style="margin:8px 0 0"><a href="${escapeHtml(item.url)}" style="color:#0969da">Open ${escapeHtml(item.key)}</a></p>` : '',
    '</div>',
  ].filter(Boolean).join('\n');

  const slackBlocks: unknown[] = [];
  if (item) {
    slackBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${mrkdwnEscape(head)} · *<${item.url}|${item.key}>* ${mrkdwnEscape(item.title)}` } });
    if (body) slackBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: '> ' + mrkdwnEscape(body).replace(/\n/g, '\n> ') } });
    slackBlocks.push(...itemCard(item).slice(1)); // context line + action buttons
  } else {
    slackBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${mrkdwnEscape(n.title)}*${body ? '\n' + mrkdwnEscape(body) : ''}` } });
  }
  return { subject, text, html, slackBlocks };
}

function contextText(item: ItemSummary): string {
  const parts = [item.state_name, priorityLabel(item.priority), item.assignee_name ?? 'unassigned'];
  if (item.due_date) parts.push(`due ${item.due_date}`);
  return parts.join(' · ');
}

/** Digest: grouped by project, then by item; one line per notification. */
export function renderDigest(items: OutboundNotification[]): Rendered {
  const byProject = new Map<string, Map<string, { item: ItemSummary | null; notes: OutboundNotification[] }>>();
  for (const n of items) {
    const p = n.item?.project_key ?? 'Other';
    const k = n.item?.key ?? n.title;
    let proj = byProject.get(p);
    if (!proj) { proj = new Map(); byProject.set(p, proj); }
    let entry = proj.get(k);
    if (!entry) { entry = { item: n.item, notes: [] }; proj.set(k, entry); }
    entry.notes.push(n);
  }
  const itemCount = [...byProject.values()].reduce((a, m) => a + m.size, 0);
  const subject = `pm-tool digest: ${items.length} update${items.length === 1 ? '' : 's'} across ${itemCount} item${itemCount === 1 ? '' : 's'}`;

  const text: string[] = [subject, ''];
  const html: string[] = ['<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1f2328">', `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(subject)}</p>`];
  const slackBlocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: truncate(subject, 150) } }];

  for (const [project, entries] of byProject) {
    text.push(`## ${project}`);
    html.push(`<h3 style="margin:12px 0 4px;font-size:15px">${escapeHtml(project)}</h3>`);
    const lines: string[] = [];
    for (const [key, { item, notes }] of entries) {
      const title = item ? `${item.key} ${item.title}` : key;
      text.push(item ? `${title}  ${item.url}` : title);
      html.push(item
        ? `<p style="margin:6px 0 2px"><a href="${escapeHtml(item.url)}" style="font-weight:600;color:#0969da;text-decoration:none">${escapeHtml(item.key)}</a> ${escapeHtml(item.title)} <span style="color:#57606a">· ${escapeHtml(contextText(item))}</span></p>`
        : `<p style="margin:6px 0 2px;font-weight:600">${escapeHtml(key)}</p>`);
      lines.push(item ? `*<${item.url}|${item.key}>* ${mrkdwnEscape(item.title)} _(${mrkdwnEscape(itemContextLine(item).replace(/\*/g, ''))})_` : `*${mrkdwnEscape(key)}*`);
      html.push('<ul style="margin:0 0 6px 18px;padding:0">');
      for (const n of notes) {
        const line = `${headline(n)}${n.body ? ': ' + truncate(n.body.replace(/\s+/g, ' ').trim(), 160) : ''}`;
        text.push(`  - ${line}`);
        html.push(`<li>${escapeHtml(line)}</li>`);
        lines.push(`    • ${mrkdwnEscape(line)}`);
      }
      html.push('</ul>');
    }
    text.push('');
    slackBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(`*${mrkdwnEscape(project)}*\n${lines.join('\n')}`, 2900) } });
  }
  html.push('</div>');
  return { subject, text: text.join('\n').trim(), html: html.join('\n'), slackBlocks };
}
