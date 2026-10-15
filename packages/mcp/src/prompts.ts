import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt('triage_project', {
    title: 'Triage a project',
    description: 'Review open items in a project and propose priorities, assignees and next steps.',
    argsSchema: { project: z.string().describe('Project key, e.g. RATES') },
  }, ({ project }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Triage the pm-tool project ${project}.`,
          '',
          '1. Call get_project to understand the project, then query_items with',
          `   {"filter":{"and":[{"field":"project.key","op":"eq","value":"${project}"},{"field":"state.category","op":"in","value":["backlog","todo","in_progress"]}]},"sort":[{"field":"priority","dir":"asc"},{"field":"updated_at","dir":"desc"}],"limit":200}`,
          '2. Flag items that are: unassigned, overdue (due_date before $today), blocked (is_blocked), stale (not updated in 14+ days), or missing a priority.',
          '3. Propose for each flagged item: a priority (1 urgent … 4 low), an assignee (use list_users and the existing assignees in the project), and whether it should be split, cancelled, or scheduled.',
          '4. Present a short table (key, title, current state, proposed change, reason). Do NOT apply changes until the user confirms; then use update_item / bulk_update_items / transition_item.',
        ].join('\n'),
      },
    }],
  }));

  server.registerPrompt('standup', {
    title: 'Daily standup summary',
    description: 'What changed since yesterday in a project, what is in progress, and what is blocked.',
    argsSchema: { project: z.string().describe('Project key, e.g. RATES') },
  }, ({ project }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Write a standup summary for pm-tool project ${project}.`,
          '',
          `- Done since yesterday: query_items {"filter":{"and":[{"field":"project.key","op":"eq","value":"${project}"},{"field":"state.category","op":"eq","value":"done"},{"field":"completed_at","op":"within_days","value":1}]}}`,
          `- In progress: query_items {"filter":{"and":[{"field":"project.key","op":"eq","value":"${project}"},{"field":"state.category","op":"eq","value":"in_progress"}]},"group_by":"assignee_id"}`,
          `- Blocked: query_items {"filter":{"and":[{"field":"project.key","op":"eq","value":"${project}"},{"field":"is_blocked","op":"eq","value":true}]}}`,
          `- Due in the next 3 days: query_items {"filter":{"and":[{"field":"project.key","op":"eq","value":"${project}"},{"field":"due_date","op":"within_days","value":3},{"field":"state.category","op":"nin","value":["done","canceled"]}]}}`,
          `- Recent activity: list_activity {"project":"${project}","limit":100}`,
          '',
          'Group by person, keep it to one line per item (key, title, state), call out blockers and overdue items explicitly, and end with 2-3 suggested focus items for today.',
        ].join('\n'),
      },
    }],
  }));
}
