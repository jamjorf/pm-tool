// Being ported to SQLite. Temporary stub so the package builds.
export function isLocalDatabaseUrl(_url: string): boolean { return true; }
export async function reset(_url?: string, _opts: { log?: (m: string) => void } = {}): Promise<void> {
  throw new Error('reset: not ported yet');
}
