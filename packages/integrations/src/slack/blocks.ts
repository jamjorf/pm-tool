// Block Kit builders shared by commands, unfurls and notification rendering.
import { PRIORITY_LABELS } from '@pm/core';
import type { ItemSummary } from '../deps.js';
import { truncate } from '../http.js';

const OPEN_CATEGORIES = new Set(['backlog', 'todo', 'in_progress']);

export function priorityLabel(p: number | null | undefined): string {
  return p == null ? 'None' : (PRIORITY_LABELS[p] ?? String(p));
}

export function itemHeadline(item: ItemSummary): string {
  return `*<${item.url}|${item.key}>* ${mrkdwnEscape(item.title)}`;
}

export function mrkdwnEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function itemContextLine(item: ItemSummary): string {
  const parts = [`*${item.state_name}*`, `Priority: ${priorityLabel(item.priority)}`, `Assignee: ${item.assignee_name ?? 'unassigned'}`];
  if (item.due_date) parts.push(`Due: ${item.due_date}`);
  return parts.join(' · ');
}

export interface CardOptions {
  /** Include action buttons (transition / assign). Default true. */
  actions?: boolean;
  /** Include a short description preview. Default false. */
  description?: boolean;
}

/** Compact Block Kit card for an item: headline, context line and (optionally) action buttons. */
export function itemCard(item: ItemSummary, opts: CardOptions = {}): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: itemHeadline(item) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: itemContextLine(item) }] },
  ];
  if (opts.description && item.description) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mrkdwnEscape(truncate(item.description, 300)) } });
  }
  if (opts.actions !== false) {
    const elements: unknown[] = [
      { type: 'button', text: { type: 'plain_text', text: 'Open' }, url: item.url, action_id: `open:${item.key}` },
    ];
    if (OPEN_CATEGORIES.has(item.state_category)) {
      elements.push({ type: 'button', text: { type: 'plain_text', text: 'Assign to me' }, action_id: `assign_me:${item.key}`, value: item.key });
      elements.push({ type: 'button', text: { type: 'plain_text', text: 'Complete' }, style: 'primary', action_id: `transition:${item.key}:complete`, value: item.key });
    }
    blocks.push({ type: 'actions', elements });
  }
  return blocks;
}

export function itemPlainText(item: ItemSummary): string {
  return `${item.key} ${item.title} — ${item.state_name}, ${priorityLabel(item.priority)}, ${item.assignee_name ?? 'unassigned'} ${item.url}`;
}
