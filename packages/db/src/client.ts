import postgres, { type Sql } from 'postgres';
import { pathToFileURL } from 'node:url';

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/pmtool';

/** DATABASE_URL from the environment, else the local docker-compose default. */
export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

/** One-connection client for scripts (notices silenced; `date` columns kept as strings). */
export function connect(url: string = databaseUrl()): Sql {
  return postgres(url, {
    max: 1,
    onnotice: () => undefined,
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
  });
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
