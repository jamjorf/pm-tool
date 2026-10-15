import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PmClient } from './client.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export const SERVER_INFO = { name: 'pm-tool', version: '0.1.0' } as const;

/** Build a fully configured MCP server bound to one PmClient (one API key). */
export function createServer(client: PmClient): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: [
      'pm-tool: firm-wide project management. Items have keys like RATES-12; projects have keys like RATES.',
      'Start with list_projects / list_types / list_workflows to learn the vocabulary, search_items for free text, query_items for structured filters (macros: $me, $today).',
      'State changes go through transition_item (workflow guards may block them; list_transitions explains why).',
      'Resources: pm://items/{key} and pm://projects/{key} give markdown summaries.',
    ].join(' '),
  });
  registerTools(server, client);
  registerResources(server, client);
  registerPrompts(server);
  return server;
}
