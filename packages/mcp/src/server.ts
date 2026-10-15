#!/usr/bin/env node
// ============================================================================
// @pm/mcp entrypoint.
//   MCP_TRANSPORT=stdio (default)  -> StdioServerTransport (Claude Desktop / Claude Code)
//   MCP_TRANSPORT=http             -> Streamable HTTP on MCP_PORT (default 3002) at /mcp,
//                                     stateless; a request's own `Authorization: Bearer`
//                                     token is used instead of PM_API_KEY when present.
// Env: API_URL (default http://localhost:3001), PM_API_KEY, MCP_TRANSPORT, MCP_PORT, MCP_HOST.
// ============================================================================
import http from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PmClient } from './client.js';
import { createServer } from './createServer.js';

export { createServer } from './createServer.js';
export { PmClient, PmApiError } from './client.js';

const log = (...args: unknown[]) => console.error('[pm-mcp]', ...args); // stdout is the stdio protocol channel

function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m?.[1]?.trim() || undefined;
}

export async function startHttp(baseClient: PmClient, port: number, host = '0.0.0.0'): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'pm-tool-mcp', api: baseClient.baseUrl }));
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'not_found', message: 'use POST /mcp' } }));
        return;
      }
      const token = bearer(req.headers.authorization);
      const client = token ? baseClient.withApiKey(token) : baseClient;
      if (!client.apiKey) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized', message: 'Send Authorization: Bearer <pm api key> (or set PM_API_KEY on the server)' } }));
        return;
      }
      // Stateless: a fresh server + transport per request, bound to the caller's key.
      const server = createServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log('request failed', err instanceof Error ? err.message : err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }));
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, host, () => resolve()); });
  log(`Streamable HTTP listening on http://${host}:${port}/mcp (API ${baseClient.baseUrl})`);
  return httpServer;
}

export async function main(): Promise<void> {
  const client = new PmClient();
  const transport = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();
  if (transport === 'http') {
    await startHttp(client, Number(process.env.MCP_PORT ?? 3002), process.env.MCP_HOST ?? '0.0.0.0');
    return;
  }
  if (!client.apiKey) log('warning: PM_API_KEY is not set; API calls will be unauthorized');
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  log(`stdio transport ready (API ${client.baseUrl})`);
}

const isEntrypoint = (() => {
  try { return process.argv[1] !== undefined && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname; } catch { return false; }
})();
if (isEntrypoint) {
  main().catch((err) => { log('fatal', err instanceof Error ? err.stack ?? err.message : err); process.exit(1); });
}
