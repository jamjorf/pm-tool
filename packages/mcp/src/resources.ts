import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PmClient } from './client.js';
import { itemMarkdown, projectMarkdown } from './format.js';

export function registerResources(server: McpServer, client: PmClient): void {
  server.registerResource(
    'item',
    new ResourceTemplate('pm://items/{key}', { list: undefined }),
    { title: 'Work item', description: 'Markdown rendering of a work item by key (e.g. pm://items/RATES-12)', mimeType: 'text/markdown' },
    async (uri, { key }) => {
      const detail = await client.getItem(String(key));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: itemMarkdown(detail) }] };
    },
  );

  server.registerResource(
    'project',
    new ResourceTemplate('pm://projects/{key}', {
      list: async () => {
        const projects = await client.listProjects().catch(() => []);
        return { resources: projects.map((p) => ({ uri: `pm://projects/${p.key}`, name: String(p.key), description: String(p.name ?? ''), mimeType: 'text/markdown' })) };
      },
    }),
    { title: 'Project', description: 'Project summary: members, counts by state category, views', mimeType: 'text/markdown' },
    async (uri, { key }) => {
      const project = await client.getProject(String(key));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: projectMarkdown(project) }] };
    },
  );
}
