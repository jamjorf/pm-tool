// Human-readable renderings (markdown / plain text) of API payloads for tool
// text blocks and resources. All fields are optional-safe: rows come from
// work_items_v (snake_case) and may carry joined columns (type_key, state_key,
// state_category, project_key, assignee_name, label_names).
import { PRIORITY_LABELS } from '@pm/core';
import type { Json, ItemDetail } from './client.js';

const s = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function priority(p: unknown): string {
  const n = typeof p === 'number' ? p : Number(p);
  return Number.isFinite(n) ? (PRIORITY_LABELS[n] ?? String(n)) : '—';
}

export function itemLine(it: Json): string {
  const state = s(it.state_name ?? it.state_key ?? it.state ?? it.state_category);
  const parts = [`${s(it.key)}`, s(it.title)];
  const meta: string[] = [];
  if (state) meta.push(state);
  if (it.priority != null && it.priority !== 0) meta.push(`P:${priority(it.priority)}`);
  if (it.assignee_name) meta.push(`@${s(it.assignee_name)}`);
  if (it.due_date) meta.push(`due ${s(it.due_date)}`);
  if (it.type_key) meta.push(s(it.type_key));
  return `- ${parts.join(' ')}${meta.length ? `  [${meta.join(', ')}]` : ''}`;
}

export function itemList(items: Json[], total?: number): string {
  if (!items.length) return 'No items.';
  const head = total != null && total !== items.length ? `${items.length} of ${total} items:` : `${items.length} item${items.length === 1 ? '' : 's'}:`;
  return [head, ...items.map(itemLine)].join('\n');
}

export function itemMarkdown(d: ItemDetail): string {
  const it = d.item ?? d;
  const lines: string[] = [];
  lines.push(`# ${s(it.key)} ${s(it.title)}`);
  const facts: Array<[string, unknown]> = [
    ['Project', it.project_key ?? it.project_id],
    ['Type', it.type_key ?? it.type_id],
    ['State', it.state_name ?? it.state_key ?? it.state_id],
    ['Category', it.state_category],
    ['Priority', it.priority != null ? priority(it.priority) : null],
    ['Assignee', it.assignee_name ?? it.assignee_id],
    ['Reporter', it.reporter_name ?? it.reporter_id],
    ['Start', it.start_date],
    ['Due', it.due_date],
    ['Estimate', it.estimate],
    ['Labels', Array.isArray(d.labels) ? d.labels.map((l) => s(l.name ?? l)).join(', ') : Array.isArray(it.label_names) ? (it.label_names as unknown[]).map(s).join(', ') : null],
    ['Blocked', it.is_blocked === true ? 'yes' : null],
    ['Confidential', it.confidential === true ? 'yes' : null],
    ['Updated', it.updated_at],
  ];
  for (const [k, v] of facts) if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) lines.push(`- **${k}:** ${s(v)}`);
  const fields = it.fields && typeof it.fields === 'object' ? (it.fields as Json) : {};
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length) {
    lines.push('', '## Fields');
    for (const k of fieldKeys) lines.push(`- **${k}:** ${s(fields[k])}`);
  }
  if (it.description) lines.push('', '## Description', '', s(it.description));
  if (d.parent && typeof d.parent === 'object') lines.push('', `**Parent:** ${s((d.parent as Json).key)} ${s((d.parent as Json).title)}`);
  if (Array.isArray(d.children) && d.children.length) {
    lines.push('', '## Children');
    for (const c of d.children) lines.push(itemLine(c));
  }
  if (Array.isArray(d.relations) && d.relations.length) {
    lines.push('', '## Relations');
    for (const r of d.relations) {
      const other = r.other_item;
      if (other) lines.push(`- ${s(r.type)} → ${s(other.key)} ${s(other.title)}${other.state ? ` (${s(other.state)})` : ''}  [relation ${s(r.id)}]`);
      else {
        const ref = (r.external_ref ?? {}) as Json;
        lines.push(`- ${s(r.type)} → ${s(r.external_kind)} ${s(ref.title ?? ref.url ?? r.external_key)}${ref.url && ref.title ? ` ${s(ref.url)}` : ''}  [relation ${s(r.id)}]`);
      }
    }
  }
  if (d.rollup && typeof d.rollup === 'object' && Object.keys(d.rollup).length) {
    lines.push('', '## Rollup', '', Object.entries(d.rollup).map(([k, v]) => `- ${k}: ${s(v)}`).join('\n'));
  }
  if (Array.isArray(d.available_transitions) && d.available_transitions.length) {
    lines.push('', '## Transitions');
    for (const t of d.available_transitions) {
      const fails = Array.isArray(t.failures) && t.failures.length ? ` — blocked: ${t.failures.map(failureText).join('; ')}` : '';
      lines.push(`- \`${t.key}\` ${t.name ?? ''} → ${s(t.to_state)}${t.allowed === false ? ' (not allowed)' : ''}${fails}`);
    }
  }
  if (it.url) lines.push('', s(it.url));
  return lines.join('\n');
}

export function failureText(f: unknown): string {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') {
    const o = f as Json;
    return s(o.message ?? o.reason ?? o.guard ?? o.type ?? JSON.stringify(o));
  }
  return s(f);
}

export function projectMarkdown(p: Json): string {
  const proj = (p.project && typeof p.project === 'object' ? (p.project as Json) : p);
  const lines = [`# ${s(proj.key)} ${s(proj.name)}`];
  if (proj.description) lines.push('', s(proj.description));
  const facts: Array<[string, unknown]> = [['Status', proj.status], ['Visibility', proj.visibility], ['Lead', proj.lead_name ?? proj.lead_id], ['Start', proj.start_date], ['Target', proj.target_date]];
  lines.push('');
  for (const [k, v] of facts) if (v != null && v !== '') lines.push(`- **${k}:** ${s(v)}`);
  const counts = (p.counts ?? p.item_counts ?? p.counts_by_category) as Json | undefined;
  if (counts && typeof counts === 'object') lines.push('', '## Items by category', '', ...Object.entries(counts).map(([k, v]) => `- ${k}: ${s(v)}`));
  const members = p.members as Json[] | undefined;
  if (Array.isArray(members) && members.length) lines.push('', '## Members', '', ...members.map((m) => `- ${s(m.name ?? m.user_name ?? m.user_id)} (${s(m.role)})`));
  const views = p.views as Json[] | undefined;
  if (Array.isArray(views) && views.length) lines.push('', '## Views', '', ...views.map((v) => `- ${s(v.name)} (${s(v.kind)}) [${s(v.id)}]`));
  return lines.join('\n');
}

export function commentsText(comments: Json[]): string {
  if (!comments.length) return 'No comments.';
  return comments.map((c) => `[${s(c.created_at)}] ${s(c.author_name ?? c.author_id ?? c.source)}${c.parent_id ? ' (reply)' : ''}:\n${s(c.body)}`).join('\n\n');
}

export function activityText(events: Json[]): string {
  if (!events.length) return 'No activity.';
  return events.map((e) => {
    const who = s(e.actor_label ?? e.actor_name ?? e.actor_id ?? e.actor_kind);
    const what = e.field ? `${s(e.action)} ${s(e.field)}: ${s(e.old_value)} → ${s(e.new_value)}` : `${s(e.action)} ${s(e.entity_type)}`;
    return `- #${s(e.id)} ${s(e.created_at)} ${who} ${what}${e.item_key ? ` (${s(e.item_key)})` : ''}`;
  }).join('\n');
}

export function transitionsText(ts: Json[]): string {
  if (!ts.length) return 'No transitions available.';
  return ts.map((t) => {
    const fails = Array.isArray(t.failures) && t.failures.length ? ` — blocked: ${(t.failures as unknown[]).map(failureText).join('; ')}` : '';
    return `- \`${s(t.key)}\` ${s(t.name)} → ${s(t.to_state ?? t.to_state_key)}${t.allowed === false ? ' (not allowed)' : ''}${fails}`;
  }).join('\n');
}

export function table(rows: Json[], cols: string[]): string {
  if (!rows.length) return '(none)';
  return rows.map((r) => cols.map((c) => `${c}=${s(r[c])}`).join('  ')).join('\n');
}
