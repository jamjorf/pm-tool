// Being ported to SQLite (see the Postgres version in git history). Temporary stub so the package builds.
import type { Sql } from './sqlite.js';
export const SEED_USERS: readonly { key: string; email: string; name: string; firm_role: string; is_service?: boolean }[] = [];
export const SEED_PROJECTS: readonly { key: string; name: string }[] = [];
export interface SeedSummary { users: number; projects: number; work_items: number }
export async function seed(_sql: Sql, _opts: { force?: boolean; now?: Date; log?: (m: string) => void } = {}): Promise<SeedSummary | null> {
  throw new Error('seed: not ported yet');
}
