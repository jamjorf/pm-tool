// ============================================================================
// MCP tools for pm-tool. Each tool returns a human-readable text block and a
// `structuredContent` JSON object; API errors are returned as tool errors
// (isError: true) with the API's code/message so an agent can recover.
// ============================================================================
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ItemPatch, QuerySpec, ViewKind } from '@pm/core';
import { PmApiError, type Json, type PmClient } from './client.js';
import { activityText, commentsText, failureText, itemList, itemMarkdown, projectMarkdown, table, transitionsText } from './format.js';

const RELATION_TYPES = ['parent_of', 'blocks', 'duplicates', 'relates_to'] as const;

export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

export function toolError(err: unknown): CallToolResult {
  if (err instanceof PmApiError) {
    let text = `Error ${err.code} (HTTP ${err.status}): ${err.message}`;
    const details = err.details as Json | undefined;
    const failures = details && typeof details === 'object' ? (details.failures as unknown[] | undefined) : undefined;
    if (err.code === 'guard_failed' || (Array.isArray(failures) && failures.length)) {
      text = `Transition blocked by workflow guards:\n${(failures ?? []).map((f) => `- ${failureText(f)}`).join('\n') || `- ${err.message}`}\nResolve the listed conditions (or pick another transition via list_transitions) and retry.`;
    } else if (details && typeof details === 'object' && !Array.isArray(details) && Object.keys(details).length) {
      text += `\nDetails: ${JSON.stringify(details)}`;
    }
    return { isError: true, content: [{ type: 'text', text }], structuredContent: { error: { code: err.code, status: err.status, message: err.message, details: err.details ?? null } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }], structuredContent: { error: { code: 'internal', message } } };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await fn(); } catch (err) { return toolError(err); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve "alice@example.com" | "<uuid>" | "Alice" to a user id via GET /api/v1/users. */
export async function resolveUserId(client: PmClient, ref: string): Promise<string> {
  const r = ref.trim();
  if (UUID_RE.test(r)) return r.toLowerCase();
  if (r === 'me' || r === '$me') {
    const me = await client.me();
    const user = (me.user ?? me) as Json;
    if (typeof user.id === 'string') return user.id;
  }
  const users = await client.listUsers();
  const lower = r.toLowerCase();
  const byEmail = users.find((u) => typeof u.email === 'string' && u.email.toLowerCase() === lower);
  if (byEmail) return String(byEmail.id);
  const byName = users.filter((u) => typeof u.name === 'string' && u.name.toLowerCase() === lower);
  if (byName.length === 1) return String(byName[0]!.id);
  throw new PmApiError(404, 'not_found', `No user matches "${ref}" (use an email address or user id; call list_users)`);
}

async function resolveTypeId(client: PmClient, typeKey: string | undefined, project: Json | undefined): Promise<string> {
  if (typeKey && UUID_RE.test(typeKey)) return typeKey;
  const types = await client.listTypes();
  if (typeKey) {
    const t = types.find((x) => x.key === typeKey || x.id === typeKey || (typeof x.name === 'string' && x.name.toLowerCase() === typeKey.toLowerCase()));
    if (!t) throw new PmApiError(404, 'not_found', `Unknown item type "${typeKey}". Known: ${types.map((x) => x.key).join(', ')}`);
    return String(t.id);
  }
  const proj = (project?.project && typeof project.project === 'object' ? project.project : project) as Json | undefined;
  const def = proj?.default_type_id;
  if (typeof def === 'string') return def;
  const first = types.find((x) => x.is_active !== false);
  if (first) return String(first.id);
  throw new PmApiError(400, 'validation', 'No item types defined; pass `type`.');
}

function scopedSpec(spec: QuerySpec, project: string | undefined): QuerySpec {
  if (!project) return spec;
  const projectFilter = { field: 'project.key', op: 'eq' as const, value: project.toUpperCase() };
  return { ...spec, filter: spec.filter ? { and: [projectFilter, spec.filter] } : projectFilter };
}

const QUERY_SPEC_DOC = `Run a structured query (QuerySpec) against work items; the same grammar powers saved views.
spec = { filter?, sort?: [{field, dir:'asc'|'desc'}], group_by?: field, limit?, offset?, include_archived? }
filter = {field, op, value?} | {and:[...]} | {or:[...]} | {not: filter}
fields: title, description, key, priority (0 none,1 urgent,2 high,3 medium,4 low), assignee_id, reporter_id, state_id, type_id, project_id,
        start_date, due_date, estimate, created_at, updated_at, completed_at, confidential, parent_id, is_blocked,
        state.category (backlog|todo|in_progress|done|canceled), state.key, type.key, project.key, labels (label ids), fields.<custom_key>, search (op: match)
ops: eq neq in nin lt lte gt gte contains starts_with is_null not_null is_empty not_empty has has_any has_all match before after within_days
macros for value: "$me" (current user id), "$today", "$now", "$start_of_week", "$end_of_week", "$start_of_month"
Examples:
1) My open work, most urgent first:
   {"filter":{"and":[{"field":"assignee_id","op":"eq","value":"$me"},{"field":"state.category","op":"in","value":["todo","in_progress"]}]},"sort":[{"field":"priority","dir":"asc"}]}
2) Overdue bugs in a project (pass project:"RATES" or filter on project.key):
   {"filter":{"and":[{"field":"type.key","op":"eq","value":"bug"},{"field":"due_date","op":"before","value":"$today"},{"field":"state.category","op":"nin","value":["done","canceled"]}]}}
3) Items updated this week grouped by state, with a text match:
   {"filter":{"and":[{"field":"updated_at","op":"after","value":"$start_of_week"},{"field":"search","op":"match","value":"curve bootstrapping"}]},"group_by":"state.category","limit":50}`;

export function registerTools(server: McpServer, client: PmClient): void {
  const key = z.string().describe('Item key like RATES-12 (or its UUID)');
  const projectKey = z.string().describe('Project key like RATES (or its UUID)');

  // ---- projects --------------------------------------------------------------
  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'List projects visible to the API key: key, name, status, visibility. Pass include_archived to see archived ones.',
    inputSchema: { include_archived: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ include_archived }) => run(async () => {
    const projects = await client.listProjects(!!include_archived);
    const text = projects.length ? projects.map((p) => `- ${p.key}: ${p.name}${p.status ? ` [${p.status}]` : ''}${p.visibility === 'private' ? ' (private)' : ''}`).join('\n') : 'No projects.';
    return ok(text, { projects });
  }));

  server.registerTool('get_project', {
    title: 'Get project',
    description: 'Project details: members, item counts by state category, saved views, default item type.',
    inputSchema: { key: projectKey },
    annotations: { readOnlyHint: true },
  }, async ({ key: k }) => run(async () => {
    const project = await client.getProject(k);
    return ok(projectMarkdown(project), { project });
  }));

  // ---- search / query --------------------------------------------------------
  server.registerTool('search_items', {
    title: 'Search items',
    description: 'Full-text search over item titles, descriptions and comments (websearch syntax: "exact phrase", -excluded, OR). Falls back to fuzzy title match. Best first step when you only have words; use query_items for structured filters.',
    inputSchema: { q: z.string().min(1), project: projectKey.optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ q, project, limit }) => run(async () => {
    const res = await client.search(q, project, limit ?? 25);
    const items = Array.isArray(res.items) ? res.items : [];
    return ok(itemList(items), { items });
  }));

  server.registerTool('query_items', {
    title: 'Query items (QuerySpec)',
    description: QUERY_SPEC_DOC,
    inputSchema: { spec: QuerySpec, project: projectKey.optional().describe('Restrict to one project (adds project.key = X to the filter)') },
    annotations: { readOnlyHint: true },
  }, async ({ spec, project }) => run(async () => {
    const res = await client.queryItems(scopedSpec(spec, project));
    const items = Array.isArray(res.items) ? res.items : [];
    let text = itemList(items, typeof res.total === 'number' ? res.total : undefined);
    if (res.groups) text += `\n\nGroups: ${JSON.stringify(res.groups)}`;
    return ok(text, { items, groups: res.groups ?? null, total: res.total ?? items.length });
  }));

  // ---- items -----------------------------------------------------------------
  server.registerTool('get_item', {
    title: 'Get item',
    description: 'Full item: fields, description, labels, parent/children, relations (incl. external links), rollup, watchers and the transitions currently available with guard results.',
    inputSchema: { key },
    annotations: { readOnlyHint: true },
  }, async ({ key: k }) => run(async () => {
    const detail = await client.getItem(k);
    return ok(itemMarkdown(detail), detail as Record<string, unknown>);
  }));

  server.registerTool('create_item', {
    title: 'Create item',
    description: 'Create a work item in a project. `type` is an item type key from list_types (defaults to the project default). `assignee` may be an email, user id or exact name. `labels` are label names (created on the item after creation). `parent` is an item key. `fields` are type-specific custom fields (see list_types for keys).',
    inputSchema: {
      project: projectKey,
      type: z.string().optional(),
      title: z.string().min(1).max(500),
      description: z.string().optional().describe('Markdown'),
      priority: z.number().int().min(0).max(4).optional().describe('0 none, 1 urgent, 2 high, 3 medium, 4 low'),
      assignee: z.string().optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      estimate: z.number().optional(),
      labels: z.array(z.string()).optional(),
      parent: z.string().optional(),
      fields: z.record(z.unknown()).optional(),
      confidential: z.boolean().optional(),
    },
  }, async (a) => run(async () => {
    const project = await client.getProject(a.project);
    const type_id = await resolveTypeId(client, a.type, project);
    const assignee_id = a.assignee ? await resolveUserId(client, a.assignee) : undefined;
    const created = await client.createItem({
      project_key: a.project.toUpperCase(), type_id, title: a.title,
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.priority !== undefined ? { priority: a.priority } : {}),
      ...(assignee_id ? { assignee_id } : {}),
      ...(a.due_date ? { due_date: a.due_date } : {}),
      ...(a.start_date ? { start_date: a.start_date } : {}),
      ...(a.estimate !== undefined ? { estimate: a.estimate } : {}),
      ...(a.fields ? { fields: a.fields } : {}),
      ...(a.confidential !== undefined ? { confidential: a.confidential } : {}),
    });
    const row = (created.item && typeof created.item === 'object' ? created.item : created) as Json;
    const k = String(row.key ?? row.id);
    const notes: string[] = [];
    for (const label of a.labels ?? []) {
      try { await client.addLabel(k, label); } catch (err) { notes.push(`label "${label}": ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (a.parent) {
      try { await client.setParent(k, a.parent); } catch (err) { notes.push(`parent "${a.parent}": ${err instanceof Error ? err.message : String(err)}`); }
    }
    const text = `Created ${k}: ${row.title ?? a.title}${row.url ? `\n${row.url}` : ''}${notes.length ? `\nWarnings:\n- ${notes.join('\n- ')}` : ''}`;
    return ok(text, { item: row, warnings: notes });
  }));

  server.registerTool('update_item', {
    title: 'Update item',
    description: 'Patch item fields: title, description, priority, assignee_id, reporter_id, start_date, due_date, estimate, fields (shallow-merged custom fields), confidential, type_id. To change state use transition_item. `assignee` (email/id/name) is resolved to assignee_id for convenience.',
    inputSchema: { key, patch: ItemPatch, assignee: z.string().nullable().optional() },
  }, async ({ key: k, patch, assignee }) => run(async () => {
    const p: Record<string, unknown> = { ...patch };
    if (assignee === null) p.assignee_id = null;
    else if (assignee) p.assignee_id = await resolveUserId(client, assignee);
    const item = await client.updateItem(k, p as ItemPatch);
    const row = (item.item && typeof item.item === 'object' ? item.item : item) as Json;
    return ok(`Updated ${row.key ?? k}: ${Object.keys(p).join(', ')}`, { item: row });
  }));

  server.registerTool('bulk_update_items', {
    title: 'Bulk update items',
    description: 'Apply the same patch (see update_item) to many items in one transaction.',
    inputSchema: { keys: z.array(z.string()).min(1).max(500), patch: ItemPatch, assignee: z.string().nullable().optional() },
  }, async ({ keys, patch, assignee }) => run(async () => {
    const p: Record<string, unknown> = { ...patch };
    if (assignee === null) p.assignee_id = null;
    else if (assignee) p.assignee_id = await resolveUserId(client, assignee);
    const res = await client.bulkUpdate(keys, p as ItemPatch);
    return ok(`Updated ${keys.length} items: ${Object.keys(p).join(', ')}`, { result: res, keys });
  }));

  server.registerTool('transition_item', {
    title: 'Transition item',
    description: 'Run a workflow transition (e.g. start, complete, cancel, reopen) on an item. Use list_transitions or get_item to see which transitions are available and why one may be blocked. Returns the guard failures when the transition is not allowed.',
    inputSchema: { key, transition: z.string().describe('transition key'), comment: z.string().optional() },
  }, async ({ key: k, transition, comment }) => run(async () => {
    const res = await client.transition(k, transition, comment);
    const row = (res.item && typeof res.item === 'object' ? res.item : res) as Json;
    return ok(`${row.key ?? k}: transition "${transition}" applied → ${row.state_name ?? row.state_key ?? row.state_id ?? 'new state'}`, { item: row });
  }));

  server.registerTool('list_transitions', {
    title: 'List transitions',
    description: 'Transitions available for an item with guard evaluation (allowed / failures).',
    inputSchema: { key },
    annotations: { readOnlyHint: true },
  }, async ({ key: k }) => run(async () => {
    const transitions = await client.listTransitions(k);
    return ok(transitionsText(transitions), { transitions });
  }));

  // ---- comments --------------------------------------------------------------
  server.registerTool('add_comment', {
    title: 'Add comment',
    description: 'Add a markdown comment to an item. Mention users with @[Name](user:<uuid>). Optional parent_id makes it a reply.',
    inputSchema: { key, body: z.string().min(1), parent_id: z.string().uuid().optional() },
  }, async ({ key: k, body, parent_id }) => run(async () => {
    const comment = await client.addComment(k, body, parent_id);
    return ok(`Comment added to ${k}${comment.id ? ` (${comment.id})` : ''}.`, { comment });
  }));

  server.registerTool('list_comments', {
    title: 'List comments',
    description: 'Comments on an item, oldest first.',
    inputSchema: { key },
    annotations: { readOnlyHint: true },
  }, async ({ key: k }) => run(async () => {
    const comments = await client.listComments(k);
    return ok(commentsText(comments), { comments });
  }));

  // ---- relations -------------------------------------------------------------
  server.registerTool('link_items', {
    title: 'Link items',
    description: 'Create a relation between two items: parent_of (from = parent; an item has one parent), blocks (from blocks to), duplicates, relates_to.',
    inputSchema: { from: key, to: key, type: z.enum(RELATION_TYPES) },
  }, async ({ from, to, type }) => run(async () => {
    const relation = await client.addRelation(from, { type, to_item: to });
    return ok(`${from} ${type} ${to}${relation.id ? ` (relation ${relation.id})` : ''}`, { relation });
  }));

  server.registerTool('add_external_link', {
    title: 'Add external link',
    description: 'Attach an external URL to an item as a links_to relation. kind examples: github_pr, github_issue, github_commit, slack_thread, doc, url.',
    inputSchema: { key, kind: z.string().min(1), url: z.string().url(), title: z.string().optional(), ref: z.record(z.unknown()).optional().describe('extra external_ref fields') },
  }, async ({ key: k, kind, url, title, ref }) => run(async () => {
    const relation = await client.addRelation(k, { type: 'links_to', external_kind: kind, external_ref: { url, ...(title ? { title } : {}), ...(ref ?? {}) } });
    return ok(`Linked ${k} → ${kind} ${title ?? url}${relation.id ? ` (relation ${relation.id})` : ''}`, { relation });
  }));

  server.registerTool('unlink', {
    title: 'Remove relation',
    description: 'Delete a relation by id (ids are shown by get_item under Relations).',
    inputSchema: { relation_id: z.string() },
    annotations: { destructiveHint: true },
  }, async ({ relation_id }) => run(async () => {
    const res = await client.removeRelation(relation_id);
    return ok(`Removed relation ${relation_id}.`, { result: res });
  }));

  // ---- activity / my work / views -------------------------------------------
  server.registerTool('list_activity', {
    title: 'List activity',
    description: 'Activity log (one event per changed field). Filter by item key, project, actor, and `since` (an event id cursor; events have increasing ids).',
    inputSchema: { key: key.optional(), project: projectKey.optional(), actor: z.string().optional(), since: z.union([z.string(), z.number()]).optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ key: k, project, actor, since, limit }) => run(async () => {
    const events = k && !project && !actor && since === undefined
      ? await client.itemActivity(k, { limit })
      : await client.activity({ item: k, project, actor, since, limit });
    return ok(activityText(events), { events });
  }));

  server.registerTool('my_work', {
    title: 'My work',
    description: 'Work for the current API key\'s user: assigned, created, watching, due_soon, mentions.',
    annotations: { readOnlyHint: true },
  }, async () => run(async () => {
    const res = await client.myWork();
    const sections = ['assigned', 'due_soon', 'mentions', 'watching', 'created'];
    const text = sections.filter((sct) => Array.isArray(res[sct])).map((sct) => `## ${sct}\n${itemList(res[sct] as Json[])}`).join('\n\n') || JSON.stringify(res);
    return ok(text, res);
  }));

  server.registerTool('list_views', {
    title: 'List views',
    description: 'Saved views (list/board/timeline/dashboard) with their QuerySpec. Optionally scoped to a project.',
    inputSchema: { project: projectKey.optional() },
    annotations: { readOnlyHint: true },
  }, async ({ project }) => run(async () => {
    const views = await client.listViews(project);
    return ok(views.length ? views.map((v) => `- ${v.name} (${v.kind}) id=${v.id}${v.project_id ? '' : ' [global]'}${v.is_shared ? ' shared' : ''}`).join('\n') : 'No views.', { views });
  }));

  server.registerTool('run_view', {
    title: 'Run view',
    description: 'Execute a saved view by id and return its items (dashboards return widget rows).',
    inputSchema: { view_id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ view_id }) => run(async () => {
    const res = await client.runView(view_id);
    const items = Array.isArray(res.items) ? (res.items as Json[]) : null;
    const text = items ? itemList(items, typeof res.total === 'number' ? res.total : undefined) : JSON.stringify(res, null, 2);
    return ok(text, res);
  }));

  server.registerTool('create_view', {
    title: 'Create view',
    description: 'Save a QuerySpec as a view. kind: list | board | timeline | dashboard. spec is a ViewSpec = QuerySpec + presentation (columns, board.column_field, timeline.start_field/end_field, dashboard.widgets).',
    inputSchema: { project: projectKey.optional(), name: z.string().min(1), kind: ViewKind, spec: z.record(z.unknown()), is_shared: z.boolean().optional() },
  }, async ({ project, name, kind, spec, is_shared }) => run(async () => {
    let project_id: string | null = null;
    if (project) {
      const p = await client.getProject(project);
      const row = (p.project && typeof p.project === 'object' ? p.project : p) as Json;
      project_id = String(row.id);
    }
    const view = await client.createView({ project_id, name, kind, spec: { ...spec, kind }, ...(is_shared !== undefined ? { is_shared } : {}) });
    return ok(`Created view "${name}" (${kind})${view.id ? ` id=${view.id}` : ''}`, { view });
  }));

  // ---- metadata --------------------------------------------------------------
  server.registerTool('list_types', {
    title: 'List item types',
    description: 'Item types with their workflow and custom field definitions (key, kind, required, options). Use the keys in create_item.type and fields.',
    annotations: { readOnlyHint: true },
  }, async () => run(async () => {
    const types = await client.listTypes();
    const text = types.map((t) => {
      const defs = Array.isArray(t.field_defs) ? (t.field_defs as Json[]) : [];
      const fields = defs.map((f) => `${f.key}:${f.kind}${f.required ? '!' : ''}${Array.isArray(f.options) ? `(${(f.options as Json[]).map((o) => o.value).join('|')})` : ''}`).join(', ');
      return `- ${t.key} "${t.name}" workflow=${t.workflow_key ?? t.workflow_id}${t.is_container ? ' container' : ''}${fields ? `\n    fields: ${fields}` : ''}`;
    }).join('\n') || 'No types.';
    return ok(text, { types });
  }));

  server.registerTool('list_workflows', {
    title: 'List workflows',
    description: 'Workflows with their states (key, category) and transitions (key, from → to, guards). Tells you which transition keys exist for transition_item.',
    annotations: { readOnlyHint: true },
  }, async () => run(async () => {
    const workflows = await client.listWorkflows();
    const text = workflows.map((w) => {
      const states = Array.isArray(w.states) ? (w.states as Json[]) : [];
      const transitions = Array.isArray(w.transitions) ? (w.transitions as Json[]) : [];
      const byId = new Map(states.map((st) => [String(st.id), String(st.key)]));
      const lines = [`- ${w.key} "${w.name}"`];
      if (states.length) lines.push(`    states: ${states.map((st) => `${st.key}(${st.category})${st.is_initial ? '*' : ''}`).join(', ')}`);
      if (transitions.length) lines.push(`    transitions: ${transitions.map((t) => `${t.key}: ${t.from_state_id ? byId.get(String(t.from_state_id)) ?? t.from_state_id : '*'} → ${byId.get(String(t.to_state_id)) ?? t.to_state_id}${Array.isArray(t.guards) && (t.guards as unknown[]).length ? ` [guards: ${(t.guards as Json[]).map((g) => g.type).join(', ')}]` : ''}`).join('; ')}`);
      return lines.join('\n');
    }).join('\n') || 'No workflows.';
    return ok(text, { workflows });
  }));

  server.registerTool('list_users', {
    title: 'List users',
    description: 'Users (id, name, email, firm role). Use ids/emails for assignee fields.',
    annotations: { readOnlyHint: true },
  }, async () => run(async () => {
    const users = await client.listUsers();
    return ok(table(users, ['id', 'name', 'email', 'firm_role']), { users });
  }));
}
