// ============================================================================
// Database location + CLI helpers. The database is a SQLite file; see sqlite.ts
// for the runtime layer (openDb, sql tag, transactions).
// ============================================================================
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, resolveDbPath, DEFAULT_DB_PATH, type Sql } from './sqlite.js';

// Honour a repo-root .env when present (Node 22 built-in; existing env vars win).
for (const f of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } break; }
}

export const DEFAULT_DATABASE_URL = DEFAULT_DB_PATH;

/** DATABASE_URL from the environment (a file path, `sqlite:path`, or `:memory:`), else ./data/pmtool.db under the repo root. */
export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

/** Open the configured database (creates the file and parent directory if needed). */
export function connect(url: string = databaseUrl()): Sql {
  return openDb(url);
}

/** Absolute filesystem path of the configured database (':memory:' for in-memory). */
export function databasePath(url: string = databaseUrl()): string {
  return resolveDbPath(url);
}

/** True when this module is the entry point (`tsx src/x.ts` / `node dist/x.js`). */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return !!entry && pathToFileURL(entry).href === importMetaUrl;
}

export function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

export type { Sql };
